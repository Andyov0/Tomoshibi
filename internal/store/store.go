// Package store keeps the handful of observations worth surviving a restart.
//
// Nothing here is authoritative. Who is in a room is the media server's to know,
// and a token is signed rather than stored, so everything below could be lost
// without changing what the server does. That single property is what lets this
// stay small: there is no migration framework, no schema version, and no startup
// check, because a record this build cannot read is simply one it does not have.
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
type Room struct {
	// Created is when the name was first seen.
	Created time.Time `json:"created"`
	// Seen is when it was last joined.
	Seen time.Time `json:"seen"`
	// Joins counts every join since the beginning.
	Joins uint64 `json:"joins"`
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
