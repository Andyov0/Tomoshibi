package store

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"time"

	bolt "go.etcd.io/bbolt"
)

/*
Signed-in sessions, kept across a restart.

They were held in memory and nowhere else, on the reasoning that a session
should not outlive the configuration that authorised it. That was true when the
administrators were a section of a configuration file and changing them meant a
restart. It stopped being true when the list moved into the store: signing
somebody out now happens by removing them, which takes effect on the next
request, and a restart no longer changes who may be here.

What the old behaviour actually did was sign everybody out whenever the process
was upgraded — which, during an afternoon of deployments, is every few minutes,
and reads as the sign-in being broken rather than as the server having been
restarted.

The token is not stored. What is stored is its SHA-256, so a copy of this file
is not a set of working credentials: an attacker who reads it holds the hash of a
cookie somebody has, which is worth nothing without the cookie. The comparison is
by lookup rather than by scan, which is constant-time in the useful sense — the
work does not depend on how close a wrong token was to a right one.
*/

var sessionsBucket = []byte("sessions")

// Session is somebody signed in, as the store keeps them.
type Session struct {
	Trip string   `json:"trip"`
	Name string   `json:"name"`
	Can  []string `json:"can"`
	// Opened is when they signed in, and is what any ceiling is measured from.
	Opened time.Time `json:"opened"`
	// Expires moves forward each time the session is used.
	Expires time.Time `json:"expires"`
}

// held turns a token into the key it is stored under.
//
// Hashed rather than kept, so that this file is not a set of usable cookies.
func held(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	out := make([]byte, hex.EncodedLen(len(sum)))
	hex.Encode(out, sum[:])

	return out
}

// KeepSession writes one down, replacing whatever was there.
func (s *Store) KeepSession(token string, session Session) error {
	encoded, err := json.Marshal(session)
	if err != nil {
		return err
	}

	return s.db.Update(func(tx *bolt.Tx) error {
		bucket, err := tx.CreateBucketIfNotExists(sessionsBucket)
		if err != nil {
			return err
		}

		return bucket.Put(held(token), encoded)
	})
}

// Session reads one back, or says there is none.
func (s *Store) Session(token string) (Session, bool) {
	var session Session
	found := false

	_ = s.db.View(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(sessionsBucket)
		if bucket == nil {
			return nil
		}

		raw := bucket.Get(held(token))
		if raw == nil {
			return nil
		}

		if err := json.Unmarshal(raw, &session); err == nil {
			found = true
		}

		return nil
	})

	return session, found
}

// DropSession forgets one, which is what signing out is.
func (s *Store) DropSession(token string) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(sessionsBucket)
		if bucket == nil {
			return nil
		}

		return bucket.Delete(held(token))
	})
}

// SweepSessions removes the ones that have run out.
//
// Called on a timer rather than on every read: an expired session is already
// refused by whoever reads it, so this is housekeeping and not a gate. What it
// prevents is a file that grows by one entry per sign-in forever.
func (s *Store) SweepSessions(now time.Time) (gone int, err error) {
	err = s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(sessionsBucket)
		if bucket == nil {
			return nil
		}

		var stale [][]byte

		if err := bucket.ForEach(func(key, raw []byte) error {
			var session Session
			if err := json.Unmarshal(raw, &session); err != nil || now.After(session.Expires) {
				// An unreadable entry goes too. It cannot authorise anybody, so
				// keeping it only means carrying it.
				stale = append(stale, append([]byte(nil), key...))
			}

			return nil
		}); err != nil {
			return err
		}

		for _, key := range stale {
			if err := bucket.Delete(key); err != nil {
				return err
			}
		}

		gone = len(stale)
		return nil
	})

	if err != nil {
		return 0, fmt.Errorf("sweep the sessions: %w", err)
	}

	return gone, nil
}
