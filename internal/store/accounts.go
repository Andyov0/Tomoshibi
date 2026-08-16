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
Accounts, for the people who are meant to be here.

Until now this deployment had two kinds of person: administrators, listed by the
signature their passphrase produces, and everybody else, who was whoever they
said they were. That is the right model for an anonymous meeting link and the
wrong one for a group of people who all come back — there was no way to give
somebody a name that was theirs without making them an administrator.

An account is a username bound to a signature. The passphrase is never stored
and never sent anywhere that keeps it: an administrator setting one has it
turned into a signature at the moment they type it, and from then on the account
is the signature. So the database holds nothing that can be used to sign in as
anybody, which is the same bargain the administrators have always had.

The username is the key because it is what a person types. The signature is
unique as well, and refused when it is not: two accounts producing the same
signature would be one identity wearing two names, and every place that
recognises somebody — the room, the register, the token — would have to pick one
of them.
*/

var accountsBucket = []byte("accounts")

// Account is somebody who was given a way in.
type Account struct {
	// Name is the username, as it was typed. The key is its lowercase form, so
	// signing in is not a spelling test.
	Name string `json:"name"`

	// Trip is the signature their passphrase produces.
	//
	// The whole of what is stored about their credential. It is also what a
	// room recognises them by, so an account and the person in the meeting are
	// the same person without anything having to be looked up mid-call.
	Trip string `json:"trip"`

	// Avatar is a small image, as a data URI, or empty.
	//
	// Held here rather than as a file because it is small, changes rarely, and
	// belongs to the record it is part of: a file would be one more thing to
	// back up, to serve, and to leave behind when an account is deleted.
	Avatar string `json:"avatar,omitempty"`

	Created  time.Time `json:"created"`
	LastSeen time.Time `json:"lastSeen,omitempty"`

	// Blocked refuses their joins, exactly as it does for anybody else.
	Blocked bool   `json:"blocked,omitempty"`
	Note    string `json:"note,omitempty"`
}

var (
	ErrAccountExists    = errors.New("somebody already has that name")
	ErrAccountTripTaken = errors.New("somebody already uses that passphrase")
	ErrNoSuchAccount    = errors.New("nobody here has that name")
	ErrAccountNoName    = errors.New("an account needs a name")
	ErrAccountLongName  = errors.New("a name is at most 32 characters")
	ErrAccountBadName   = errors.New("a name may use letters, digits, dots, dashes and underscores")
	ErrAvatarTooLarge   = errors.New("an avatar is at most 64 kilobytes")
)

// How large an avatar may be.
//
// Sixty-four kilobytes, which is generous for the size it is shown at and small
// enough that a hundred accounts is a database somebody can still copy about.
// The client is expected to have scaled it down long before this; the limit is
// here because a limit the server does not enforce is a suggestion.
const maxAvatar = 64 << 10

// Key is what an account is stored and looked up under.
//
// Lowercase, because signing in should not be a spelling test and because two
// accounts differing only in case would be an invitation rather than a feature.
func accountKey(name string) []byte {
	return []byte(strings.ToLower(strings.TrimSpace(name)))
}

// Valid reports whether this is an account the deployment can use.
func (a Account) Valid() error {
	name := strings.TrimSpace(a.Name)

	switch {
	case name == "":
		return ErrAccountNoName

	case len([]rune(name)) > 32:
		return ErrAccountLongName

	case !plainName(name):
		return ErrAccountBadName

	case len(a.Avatar) > maxAvatar:
		return ErrAvatarTooLarge
	}

	// The signature is checked by the same rule the administrators use, so a
	// name cannot be admitted with something that is not one.
	return Admin{Trip: a.Trip, Name: name}.Valid()
}

// plainName keeps a username to what can be typed, said aloud and looked up.
//
// No spaces, because a name with one is a name somebody will type differently
// every time. Nothing exotic, because two names that look identical and are not
// is the oldest impersonation there is.
func plainName(name string) bool {
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '.' || r == '-' || r == '_':
		default:
			return false
		}
	}

	return true
}

// Accounts lists everybody, by name.
func (s *Store) Accounts() ([]Account, error) {
	var list []Account

	err := s.db.View(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(accountsBucket)
		if bucket == nil {
			return nil
		}

		return bucket.ForEach(func(_, raw []byte) error {
			var account Account
			if err := json.Unmarshal(raw, &account); err == nil {
				list = append(list, account)
			}

			return nil
		})
	})

	if err != nil {
		return nil, fmt.Errorf("read the accounts: %w", err)
	}

	sort.Slice(list, func(i, j int) bool {
		return strings.ToLower(list[i].Name) < strings.ToLower(list[j].Name)
	})

	return list, nil
}

// AddAccount records a new one.
func (s *Store) AddAccount(account Account) error {
	if err := account.Valid(); err != nil {
		return err
	}

	account.Name = strings.TrimSpace(account.Name)

	if account.Created.IsZero() {
		account.Created = time.Now().UTC()
	}

	return s.db.Update(func(tx *bolt.Tx) error {
		bucket, err := tx.CreateBucketIfNotExists(accountsBucket)
		if err != nil {
			return err
		}

		if bucket.Get(accountKey(account.Name)) != nil {
			return ErrAccountExists
		}

		if taken(bucket, account.Trip, "") {
			return ErrAccountTripTaken
		}

		encoded, err := json.Marshal(account)
		if err != nil {
			return err
		}

		return bucket.Put(accountKey(account.Name), encoded)
	})
}

// taken reports whether a signature already belongs to somebody else.
//
// Checked on every write rather than only on creation, because the way two
// accounts come to share a signature is not somebody typing the same password
// twice at the start — it is one of them changing theirs later to something
// another already uses.
func taken(bucket *bolt.Bucket, trip, except string) bool {
	found := false

	_ = bucket.ForEach(func(key, raw []byte) error {
		if string(key) == except {
			return nil
		}

		var other Account
		if err := json.Unmarshal(raw, &other); err == nil && other.Trip == trip {
			found = true
		}

		return nil
	})

	return found
}

// Account reads one by name.
func (s *Store) Account(name string) (Account, bool) {
	var account Account
	found := false

	_ = s.db.View(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(accountsBucket)
		if bucket == nil {
			return nil
		}

		raw := bucket.Get(accountKey(name))
		if raw == nil {
			return nil
		}

		if err := json.Unmarshal(raw, &account); err == nil {
			found = true
		}

		return nil
	})

	return account, found
}

// AccountBySignature finds whoever a signature belongs to.
//
// Used where somebody is already recognised and the question is what to call
// them: a join carries a signature, and an account gives it a name and a face.
func (s *Store) AccountBySignature(trip string) (Account, bool) {
	var account Account
	found := false

	if strings.TrimSpace(trip) == "" {
		return account, false
	}

	_ = s.db.View(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(accountsBucket)
		if bucket == nil {
			return nil
		}

		return bucket.ForEach(func(_, raw []byte) error {
			if found {
				return nil
			}

			var one Account
			if err := json.Unmarshal(raw, &one); err == nil && one.Trip == trip {
				account, found = one, true
			}

			return nil
		})
	})

	return account, found
}

// UpdateAccount writes a changed account back, keyed by its current name.
//
// The name may change: it is what somebody is called, not what they are, and a
// person who wants to be known differently should not need a new account. The
// signature may change too, which is what changing a passphrase is. Both are
// checked against everybody else first.
func (s *Store) UpdateAccount(was string, account Account) error {
	if err := account.Valid(); err != nil {
		return err
	}

	account.Name = strings.TrimSpace(account.Name)

	return s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(accountsBucket)
		if bucket == nil {
			return ErrNoSuchAccount
		}

		old := accountKey(was)

		raw := bucket.Get(old)
		if raw == nil {
			return ErrNoSuchAccount
		}

		var existing Account
		if err := json.Unmarshal(raw, &existing); err == nil {
			account.Created = existing.Created
			account.LastSeen = existing.LastSeen
		}

		key := accountKey(account.Name)

		if string(key) != string(old) && bucket.Get(key) != nil {
			return ErrAccountExists
		}

		if taken(bucket, account.Trip, string(old)) {
			return ErrAccountTripTaken
		}

		encoded, err := json.Marshal(account)
		if err != nil {
			return err
		}

		if err := bucket.Put(key, encoded); err != nil {
			return err
		}

		if string(key) != string(old) {
			return bucket.Delete(old)
		}

		return nil
	})
}

// RemoveAccount forgets somebody.
func (s *Store) RemoveAccount(name string) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(accountsBucket)
		if bucket == nil {
			return ErrNoSuchAccount
		}

		key := accountKey(name)

		if bucket.Get(key) == nil {
			return ErrNoSuchAccount
		}

		return bucket.Delete(key)
	})
}

// AccountSeen notes that somebody used their account.
func (s *Store) AccountSeen(trip string, at time.Time) {
	account, ok := s.AccountBySignature(trip)
	if !ok {
		return
	}

	account.LastSeen = at
	_ = s.UpdateAccount(account.Name, account)
}
