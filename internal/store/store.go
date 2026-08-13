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

	bolt "go.etcd.io/bbolt"
)

// rooms is the only bucket. Named once, here, because the name lives in the file
// and outlives any refactor of this package.
var rooms = []byte("rooms")

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

// TouchRoom records a join and returns the tally including it.
func (s *Store) TouchRoom(name string) (Room, error) {
	var room Room
	now := time.Now().UTC()

	err := s.db.Update(func(tx *bolt.Tx) error {
		bucket, err := tx.CreateBucketIfNotExists(rooms)
		if err != nil {
			return err
		}

		// A record this build cannot read is treated as one that is not there.
		// Losing a tally is the whole cost, and it beats refusing to let anybody
		// into a meeting over a stale row.
		if raw := bucket.Get([]byte(name)); raw != nil {
			if err := json.Unmarshal(raw, &room); err != nil {
				room = Room{}
			}
		}

		room.Joins++
		room.Seen = now
		if room.Created.IsZero() {
			room.Created = now
		}

		encoded, err := json.Marshal(room)
		if err != nil {
			return err
		}

		return bucket.Put([]byte(name), encoded)
	})

	if err != nil {
		return Room{}, fmt.Errorf("record a join for %q: %w", name, err)
	}

	return room, nil
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
			var room Room
			if err := json.Unmarshal(raw, &room); err != nil {
				return nil
			}
			found = append(found, Named{Name: string(name), Room: room})
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
