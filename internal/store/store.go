// Package store keeps the few facts that have to survive a restart.
//
// Most of what is here is observation and could be lost without changing what
// the server does: how many times a name has been joined, and when. Two things
// could not, and both arrived with the setting that limits who may open a room.
// One is that setting itself, which is changed from the management pages and so
// has nowhere else to live. The other is whether a name has ever been used,
// because under that setting it is what decides whether somebody is let in.
//
// So this file is a tally on one deployment and part of the access control on
// another, and one setting is the whole difference. Losing it where anybody may
// open a room costs the figures on a management page. Losing it where only
// administrators may turns people out of rooms they were in the middle of using.
//
// What has not changed is that there is no migration framework, no schema
// version, and no startup check. A record this build cannot read is treated as
// one that is not there — a lost tally in the first case, a closed room in the
// second — which is why fields here are only ever added, and why forgetting
// leaves a record it could not read exactly where it is.
package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"

	"tomoshibi/internal/room"

	bolt "go.etcd.io/bbolt"
)

// The buckets. Named once, here, because these names live in the file and
// outlive any refactor of this package.
var (
	// rooms holds one tally per name somebody used.
	rooms = []byte("rooms")

	// settings holds the handful of choices made from the management pages,
	// which have no configuration file to write to.
	settings = []byte("settings")
)

// openedBy is where settings keeps a room.Opening.
var openedBy = []byte("rooms.opened_by")

// ErrNotOpen refuses a name nobody has used to somebody who may not open one.
var ErrNotOpen = errors.New("that room has not been opened")

// Room is what is known about a name somebody used.
//
// A room has no existence beyond its name, so this is a tally rather than a
// definition: it records that the name was used, not that anything exists
// because of it. Fields are only ever added, never renamed or removed, which is
// the whole of the schema-evolution story here.
//
// That the record is here at all is the second fact it carries, and the one
// that is load-bearing: where only administrators may open a room, a name with
// no record is a name nobody may use. Which is why Seen is not only a figure on
// a management page — it is how long the room has left. See Forget.
type Room struct {
	// Host is the mark of whoever the room answers to.
	//
	// Set to whoever first spoke the name, because somebody has to be able to
	// quiet a room and there is nobody else it could reasonably be. Transferable,
	// because the person who opened a recurring meeting is not always the person
	// running it, and because they leave.
	//
	// The mark rather than the identity: an identity is minted fresh whenever a
	// passphrase changes and carries a random tail, so a host who reloaded into a
	// new one would stop being host without anybody doing anything. A mark is the
	// same on every visit for somebody who can prove a name, and lasts a session
	// for somebody who cannot — which is the whole of what can honestly be
	// promised to an anonymous host.
	Host string `json:"host,omitempty"`

	// Created is when the name was first seen.
	Created time.Time `json:"created"`
	// Seen is when it was last joined.
	Seen time.Time `json:"seen"`
	// Joins counts every join since the beginning.
	Joins uint64 `json:"joins"`

	// Relay is the machine this room was last held on.
	//
	// Recorded because a meeting lives on one server and the rule about who may
	// use a reserved one is about starting a call there, not about the people
	// invited to it: a room an administrator opened on their own relay has to
	// let in everybody they sent the link to. Knowing where it is is the whole
	// of what that needs.
	//
	// Last rather than first, so a room that emptied and came back somewhere
	// else is recorded where it now is. It is a note about where to find a
	// meeting, not a claim of ownership.
	Relay string `json:"relay,omitempty"`
}

// Store is the database.
//
// Safe for concurrent use: bbolt serialises writers itself and reads run in
// their own transactions, so there is no lock here to hold and no pool to size.
type Store struct {
	db *bolt.DB
}

// Open the store, creating the file and its parent directory.
func Open(path string) (*Store, error) {
	if dir := filepath.Dir(path); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, fmt.Errorf("create %s: %w", dir, err)
		}
	}

	// A short timeout rather than none: the file is locked exclusively, so
	// without one a second process would wait forever with no indication of why.
	db, err := bolt.Open(path, 0o600, &bolt.Options{Timeout: 2 * time.Second})
	if errors.Is(err, bolt.ErrTimeout) {
		return nil, fmt.Errorf(
			"%s is held by another process, almost certainly the server itself. "+
				"Stop it and try again: the store admits one process at a time", path)
	}
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", path, err)
	}

	return &Store{db: db}, nil
}

// Close releases the file.
func (s *Store) Close() error {
	return s.db.Close()
}

// OpenRoom records a join, refusing a name nobody has used when mayOpen is
// false. Returns the tally including this join.
//
// The refusal and the tally are one transaction because they are one question.
// bbolt admits a single writer at a time, so two people arriving at a fresh name
// in the same instant are put in an order: the first opens it, and the second
// finds it already open and is let in whoever they are. Asked separately — read,
// decide, write — both would find nothing there and the answer would depend on
// which of them the scheduler ran first.
//
// The name is what "existing" means here, and nothing else could be. Whether
// anybody is in the room at this moment is the media server's to know and its
// answer changes every time the last participant leaves, so a policy resting on
// it would turn everybody out of their own meeting the moment it emptied for a
// second. This asks whether the name was ever used, which only becomes true and
// never goes back.
func (s *Store) OpenRoom(name string, mayOpen bool) (Room, error) {
	var tally Room
	now := time.Now().UTC()

	err := s.db.Update(func(tx *bolt.Tx) error {
		bucket, err := tx.CreateBucketIfNotExists(rooms)
		if err != nil {
			return err
		}

		raw := bucket.Get([]byte(name))
		if raw == nil && !mayOpen {
			return ErrNotOpen
		}

		// A record this build cannot read is treated as one that is not there.
		// Losing a tally is the whole cost, and it beats refusing to let anybody
		// into a meeting over a stale row.
		if raw != nil {
			if err := json.Unmarshal(raw, &tally); err != nil {
				tally = Room{}
			}
		}

		tally.Joins++
		tally.Seen = now
		if tally.Created.IsZero() {
			tally.Created = now
		}

		encoded, err := json.Marshal(tally)
		if err != nil {
			return err
		}

		return bucket.Put([]byte(name), encoded)
	})

	// Returned bare rather than wrapped: this one is an answer the caller sends
	// on to somebody, not a failure to report.
	if errors.Is(err, ErrNotOpen) {
		return Room{}, ErrNotOpen
	}

	if err != nil {
		return Room{}, fmt.Errorf("record a join for %q: %w", name, err)
	}

	return tally, nil
}

// Forget removes names nobody has joined since the given moment, at most limit
// of them, and reports how many went.
//
// Bounded because bbolt admits one writer at a time and a join is a write. A
// single transaction clearing a bucket that has been allowed to grow would hold
// that writer for the whole of it, and every person trying to join a call would
// wait. So a sweep is a series of small transactions with room between them,
// and the caller comes back for more.
//
// Why there is anything to sweep at all: a name is written down the first time
// somebody joins it and nothing has ever taken one away. Where anybody may open
// a room the only door to that is the rate limiter, which bounds how fast names
// arrive and not how many — measured at four hundred bytes apiece, a script
// spending its whole allowance writes a few hundred megabytes a day and nothing
// says a word.
//
// Ageing them is not merely a way of keeping the file small, though. A name
// nobody has spoken in a month is not a room in use, and calling it one is the
// less honest reading of the two: it leaves a room open for good because
// somebody said its name once, last year.
//
// A record this build cannot read is left exactly where it is. Its age is
// unknown, and under a policy where a missing record is a closed door, deleting
// on an unknown age is the wrong way to be wrong.
func (s *Store) Forget(since time.Time, limit int) (int, error) {
	if limit <= 0 {
		return 0, nil
	}

	gone := 0

	err := s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(rooms)
		if bucket == nil {
			return nil
		}

		// Gathered before anything is removed. Deleting through a cursor while
		// walking it is a question bbolt answers for its own iterator with
		// "undefined behaviour", and a bounded pass makes the list small enough
		// that there is nothing to be gained by asking.
		stale := make([][]byte, 0, limit)

		err := bucket.ForEach(func(name, raw []byte) error {
			if len(stale) >= limit {
				return errEnough
			}

			var tally Room
			if err := json.Unmarshal(raw, &tally); err != nil {
				return nil
			}

			if tally.Seen.Before(since) {
				stale = append(stale, append([]byte(nil), name...))
			}

			return nil
		})
		if err != nil && !errors.Is(err, errEnough) {
			return err
		}

		for _, name := range stale {
			if err := bucket.Delete(name); err != nil {
				return err
			}
			gone++
		}

		return nil
	})

	if err != nil {
		return 0, fmt.Errorf("forget rooms last joined before %s: %w", since.Format(time.RFC3339), err)
	}

	return gone, nil
}

// errEnough stops a walk that has found as much as it was asked for. Never
// returned to a caller: a full batch is an ordinary outcome, and the caller
// learns of it from the count.
var errEnough = errors.New("enough")

// Opening is who may use a name nobody has used before.
//
// Kept here rather than in the configuration because it is changed from the
// management pages, and those cannot edit a file. What the configuration holds
// is the value this answers before anybody has changed it — see AdoptOpening.
//
// An absent or unreadable setting reads as room.ByAnyone, on the same principle
// as an unreadable tally reading as absent. The default is the state every
// deployment that never touched this is in, and a failure to read one key is
// not a reason to start turning people away from meetings.
func (s *Store) Opening() room.Opening {
	var opening room.Opening

	_ = s.db.View(func(tx *bolt.Tx) error {
		if bucket := tx.Bucket(settings); bucket != nil {
			opening = room.Opening(bucket.Get(openedBy))
		}

		return nil
	})

	if !opening.Valid() {
		return room.ByAnyone
	}

	return opening
}

// SetOpening changes who may open a room.
func (s *Store) SetOpening(opening room.Opening) error {
	if !opening.Valid() {
		return fmt.Errorf("%q is not a way of opening rooms", opening)
	}

	err := s.db.Update(func(tx *bolt.Tx) error {
		bucket, err := tx.CreateBucketIfNotExists(settings)
		if err != nil {
			return err
		}

		return bucket.Put(openedBy, []byte(opening))
	})

	if err != nil {
		return fmt.Errorf("set who may open a room: %w", err)
	}

	return nil
}

// AdoptOpening takes the configured value where nothing has been chosen yet, and
// returns what is in effect either way.
//
// So that a configuration file still describes what a fresh deployment does,
// without a file being able to quietly undo a choice somebody made from the
// management pages. The file is where this starts; after that the store is the
// answer, and the runtime panel shows both so that the difference is visible to
// whoever is reading the file and wondering why it is not being obeyed.
func (s *Store) AdoptOpening(configured room.Opening) (room.Opening, error) {
	var opening room.Opening

	err := s.db.Update(func(tx *bolt.Tx) error {
		bucket, err := tx.CreateBucketIfNotExists(settings)
		if err != nil {
			return err
		}

		if held := room.Opening(bucket.Get(openedBy)); held.Valid() {
			opening = held
			return nil
		}

		opening = configured

		return bucket.Put(openedBy, []byte(configured))
	})

	if err != nil {
		return room.ByAnyone, fmt.Errorf("adopt who may open a room: %w", err)
	}

	return opening, nil
}

// Named pairs a room with the name it is filed under.
type Named struct {
	Name string
	Room Room
}

// Rooms lists every room ever joined, most recently seen first.
func (s *Store) Rooms() ([]Named, error) {
	var found []Named

	err := s.db.View(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(rooms)
		if bucket == nil {
			// Nothing has ever been written, so there is nothing to list.
			return nil
		}

		return bucket.ForEach(func(name, raw []byte) error {
			var tally Room
			if err := json.Unmarshal(raw, &tally); err != nil {
				return nil
			}
			found = append(found, Named{Name: string(name), Room: tally})
			return nil
		})
	})

	if err != nil {
		return nil, fmt.Errorf("list rooms: %w", err)
	}

	sort.Slice(found, func(a, b int) bool {
		return found[a].Room.Seen.After(found[b].Room.Seen)
	})

	return found, nil
}

// HoldRoom records which relay a room is being held on.
//
// Written after a join is authorised, so it reflects where somebody was
// actually sent. Failure is not reported upward: this is a note that makes a
// later join tidier, and a call should not be refused because a note could not
// be kept.
func (s *Store) HoldRoom(name, relay string) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(rooms)
		if bucket == nil {
			return nil
		}

		raw := bucket.Get([]byte(name))
		if raw == nil {
			return nil
		}

		var tally Room
		if err := json.Unmarshal(raw, &tally); err != nil {
			return nil
		}

		if tally.Relay == relay {
			return nil
		}

		tally.Relay = relay

		encoded, err := json.Marshal(tally)
		if err != nil {
			return err
		}

		return bucket.Put([]byte(name), encoded)
	})
}

// How long a note about where a room is stays worth believing.
//
// A meeting lives on one server for as long as somebody is in it, and this
// server has no cheap way to ask whether anybody still is — the media server
// knows, and asking it means a request to every relay on every join.
//
// So the note expires instead. Two hours without anybody joining is a room that
// has almost certainly emptied, and the cost of being wrong either way is
// small: too eager, and somebody is sent to a relay the meeting is not on, where
// the media server forwards them to it and only their measurement was wasted;
// too patient, and a room that ended hours ago sends the next meeting of the
// same name back to a machine it need not use.
//
// What must not happen is the note lasting forever, which is what it did when
// it was first written: every room would return to whichever relay it first
// landed on, for good, and choosing a server would stop meaning anything the
// second time a name was used.
const heldFor = 2 * time.Hour

// HeldOn says which relay a room is being held on, while that is still worth
// believing.
func (s *Store) HeldOn(name string) string {
	var relay string

	_ = s.db.View(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(rooms)
		if bucket == nil {
			return nil
		}

		raw := bucket.Get([]byte(name))
		if raw == nil {
			return nil
		}

		var tally Room
		if err := json.Unmarshal(raw, &tally); err != nil {
			return nil
		}

		if time.Since(tally.Seen) > heldFor {
			return nil
		}

		relay = tally.Relay

		return nil
	})

	return relay
}

// ReleaseRoom forgets where a room was being held.
//
// The timed expiry in HeldOn is what covers the ordinary case — a meeting that
// ends leaves nobody to say so — and this is for the two cases a clock cannot
// answer. An operator taking a relay out of service wants the rooms on it picked
// again now rather than in two hours; and a test needs to arrange a room that
// has gone quiet without waiting for it to.
func (s *Store) ReleaseRoom(name string) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(rooms)
		if bucket == nil {
			return nil
		}

		raw := bucket.Get([]byte(name))
		if raw == nil {
			return nil
		}

		var tally Room
		if err := json.Unmarshal(raw, &tally); err != nil {
			return nil
		}

		tally.Relay = ""

		encoded, err := json.Marshal(tally)
		if err != nil {
			return err
		}

		return bucket.Put([]byte(name), encoded)
	})
}

// SetHost records who a room answers to.
//
// Written against a room that already exists and quietly does nothing where one
// does not: the caller is either the join that just opened it or a transfer from
// somebody already in it, and neither should create a record by asking.
func (s *Store) SetHost(name, mark string) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(rooms)
		if bucket == nil {
			return nil
		}

		raw := bucket.Get([]byte(name))
		if raw == nil {
			return nil
		}

		var tally Room
		if err := json.Unmarshal(raw, &tally); err != nil {
			return nil
		}

		tally.Host = mark

		encoded, err := json.Marshal(tally)
		if err != nil {
			return err
		}

		return bucket.Put([]byte(name), encoded)
	})
}

// HostOf says which mark a room answers to, or "" where it answers to nobody.
func (s *Store) HostOf(name string) string {
	var mark string

	_ = s.db.View(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(rooms)
		if bucket == nil {
			return nil
		}

		raw := bucket.Get([]byte(name))
		if raw == nil {
			return nil
		}

		var tally Room
		if err := json.Unmarshal(raw, &tally); err == nil {
			mark = tally.Host
		}

		return nil
	})

	return mark
}

// PinEntry records which relay somebody should come in through next time.
//
// Against the room and the identity together, because that is what it is about:
// where a person enters is theirs, separately from where the room is held, and
// the same person in two meetings may want two different doors.
//
// Written onto the arrival, which already holds what was seen of them at the
// last one. It is read at the next join and cleared there, so it moves somebody
// once rather than pinning them for good — an operator moving a person out of a
// bad path means this call, and a pin that outlived it would quietly overrule
// every choice they made afterwards.
func (s *Store) PinEntry(room, identity, relay string) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		bucket, err := tx.CreateBucketIfNotExists(arrivals)
		if err != nil {
			return err
		}

		key := arrivalKey(room, identity)

		var arrival Arrival
		if raw := bucket.Get(key); raw != nil {
			_ = json.Unmarshal(raw, &arrival)
		}

		arrival.Pinned = relay

		if arrival.At.IsZero() {
			arrival.At = time.Now().UTC()
		}

		encoded, err := json.Marshal(arrival)
		if err != nil {
			return err
		}

		return bucket.Put(key, encoded)
	})
}

// TakePin reads a pinned entry and clears it, so it moves somebody once.
func (s *Store) TakePin(room, identity string) string {
	var relay string

	_ = s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(arrivals)
		if bucket == nil {
			return nil
		}

		key := arrivalKey(room, identity)

		raw := bucket.Get(key)
		if raw == nil {
			return nil
		}

		var arrival Arrival
		if err := json.Unmarshal(raw, &arrival); err != nil || arrival.Pinned == "" {
			return nil
		}

		relay = arrival.Pinned
		arrival.Pinned = ""

		encoded, err := json.Marshal(arrival)
		if err != nil {
			return err
		}

		return bucket.Put(key, encoded)
	})

	return relay
}
