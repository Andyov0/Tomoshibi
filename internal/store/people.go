package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	bolt "go.etcd.io/bbolt"
)

/*
The people who keep coming back.

There are no accounts here and this does not invent any. What it records is the
one thing about a visitor that is already stable and already provable: the
signature their passphrase produces, which travels inside the identity the media
server enforces and prints beside their name in every room they join.

So this is a register rather than a directory. Somebody appears in it the first
time they join with a passphrase and is not in it at all if they never set one —
an anonymous visitor's signature is drawn from nothing and is different in every
tab, and writing those down would be a list of tabs.

What it is for is the one thing an operator actually needs to do about a person:
stop them. A room can be closed and a participant removed, and both are undone
the moment they rejoin. Blocking is the door, and it is checked at the join,
which is the only moment anybody asks to come in.
*/

var peopleBucket = []byte("people")

// Person is somebody who has joined with a passphrase.
type Person struct {
	// Trip is the signature their passphrase produces, and the key here.
	//
	// Not the passphrase, which this server is never told, and not a name: a
	// display name is chosen per visit and two people may pick the same one.
	Trip string `json:"trip"`

	// Name is what they last called themselves, for a page that has to show
	// something a person recognises. Nothing is decided by it.
	Name string `json:"name"`

	// Rooms is how many joins have been seen from this signature, which is the
	// difference between somebody who visited once and somebody who is here
	// every day.
	Rooms int `json:"rooms"`

	FirstSeen time.Time `json:"firstSeen"`
	LastSeen  time.Time `json:"lastSeen"`

	// Blocked refuses their joins.
	//
	// Refused at the join rather than by removing them from rooms, because
	// removing somebody is undone by their rejoining and this is meant to be
	// the door. Their existing calls are not ended: this server could not end
	// them and has no business doing so, and the setting means "not again"
	// rather than "not now".
	Blocked bool `json:"blocked,omitempty"`

	// Note is whatever the operator wants to remember about why.
	Note string `json:"note,omitempty"`
}

var (
	ErrNoSuchPerson = errors.New("nobody with that signature has been here")
	ErrPersonNoTrip = errors.New("a person is identified by a signature")
)

// Seen records a join, creating the person if this is their first.
//
// Called on every join that carries a proven signature and on no other, so an
// anonymous visitor leaves nothing behind. Failure is not reported upward: a
// register that cannot be written is not a reason to refuse somebody a call.
func (s *Store) Seen(trip, name string, at time.Time) error {
	trip = strings.TrimSpace(trip)
	if trip == "" {
		return ErrPersonNoTrip
	}

	return s.db.Update(func(tx *bolt.Tx) error {
		bucket, err := tx.CreateBucketIfNotExists(peopleBucket)
		if err != nil {
			return err
		}

		person := Person{Trip: trip, FirstSeen: at}

		if raw := bucket.Get([]byte(trip)); raw != nil {
			// An unreadable entry is replaced rather than preserved. It cannot
			// be shown and it cannot block anybody, so keeping it would only
			// mean the register never healing.
			_ = json.Unmarshal(raw, &person)
		}

		person.Trip = trip
		person.Rooms++
		person.LastSeen = at

		if name = strings.TrimSpace(name); name != "" {
			person.Name = name
		}

		if person.FirstSeen.IsZero() {
			person.FirstSeen = at
		}

		encoded, err := json.Marshal(person)
		if err != nil {
			return err
		}

		return bucket.Put([]byte(trip), encoded)
	})
}

// Blocked reports whether this signature is refused.
//
// The whole of the check the join makes, and deliberately the cheapest thing in
// this file: it runs on every join, including everybody who is not blocked,
// which is almost everybody.
func (s *Store) Blocked(trip string) bool {
	if strings.TrimSpace(trip) == "" {
		return false
	}

	blocked := false

	_ = s.db.View(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(peopleBucket)
		if bucket == nil {
			return nil
		}

		raw := bucket.Get([]byte(trip))
		if raw == nil {
			return nil
		}

		var person Person
		if err := json.Unmarshal(raw, &person); err == nil {
			blocked = person.Blocked
		}

		return nil
	})

	return blocked
}

// People lists everybody the register knows, most recently seen first.
//
// That order rather than by name, because the question this page answers is
// almost always about somebody who was just here.
func (s *Store) People() ([]Person, error) {
	var list []Person

	err := s.db.View(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(peopleBucket)
		if bucket == nil {
			return nil
		}

		return bucket.ForEach(func(_, raw []byte) error {
			var person Person
			if err := json.Unmarshal(raw, &person); err == nil {
				list = append(list, person)
			}

			return nil
		})
	})

	if err != nil {
		return nil, fmt.Errorf("read the people: %w", err)
	}

	sort.Slice(list, func(i, j int) bool { return list[i].LastSeen.After(list[j].LastSeen) })

	return list, nil
}

// SetBlocked refuses or readmits somebody.
func (s *Store) SetBlocked(trip string, blocked bool, note string) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(peopleBucket)
		if bucket == nil {
			return ErrNoSuchPerson
		}

		raw := bucket.Get([]byte(trip))
		if raw == nil {
			return ErrNoSuchPerson
		}

		var person Person
		if err := json.Unmarshal(raw, &person); err != nil {
			return err
		}

		person.Blocked = blocked
		person.Note = strings.TrimSpace(note)

		encoded, err := json.Marshal(person)
		if err != nil {
			return err
		}

		return bucket.Put([]byte(trip), encoded)
	})
}

// ForgetPerson removes somebody from the register.
//
// Which is not the same as readmitting them: this drops what is known, and
// somebody blocked who is forgotten can join again. Both are offered because
// they answer different questions — one is "they may come back", the other is
// "there is no reason to keep this".
func (s *Store) ForgetPerson(trip string) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(peopleBucket)
		if bucket == nil {
			return ErrNoSuchPerson
		}

		if bucket.Get([]byte(trip)) == nil {
			return ErrNoSuchPerson
		}

		return bucket.Delete([]byte(trip))
	})
}
