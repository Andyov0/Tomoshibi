package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	bolt "go.etcd.io/bbolt"

	"tomoshibi/internal/config"
)

// adminsBucket holds the people who may open the management pages.
//
// In the store rather than only in the configuration file, for the reason the
// relays are: an administrator is added when somebody joins the team and removed
// when they leave, and both happen while the deployment is running. Editing a
// file and restarting to add one would drop every call in progress, which is a
// strange price for a change that alters nothing about the calls themselves.
//
// The configuration file remains the starting value, adopted the first time this
// runs. That matters more here than anywhere else: it is how the first
// administrator exists at all, and a deployment that lost its store must be able
// to get back in by editing a file on the host.
var adminsBucket = []byte("admins")

// Admin is one administrator, as the deployment knows them.
type Admin struct {
	// Trip is the signature their passphrase produces, and the key here.
	//
	// The passphrase itself is never stored, sent, or seen by this server: the
	// signature is what a client proves it can produce, and it is public — it
	// prints beside its owner's name in every room they join. Which is also how
	// somebody being added finds out what to hand over.
	Trip string `json:"trip"`

	// Name appears in the audit log and beside the entry on the page. Nothing
	// is authorised by it.
	Name string `json:"name"`

	// Can lists what they may do. Empty means observe alone, which is the safe
	// reading of an entry somebody wrote in a hurry.
	Can []string `json:"can"`

	// Added is when somebody put them here, for a page that wants to say so.
	Added time.Time `json:"added"`
}

// What an administrator can be wrong in.
var (
	ErrAdminNoTrip   = errors.New("an administrator needs a signature")
	ErrAdminBadTrip  = errors.New("a signature is ten lowercase letters and digits")
	ErrAdminLongName = errors.New("an administrator name is at most 64 characters")
	ErrAdminBadCan   = errors.New("an administrator may observe or moderate, and nothing else")
	ErrAdminExists   = errors.New("somebody with that signature is already an administrator")
	ErrNoSuchAdmin   = errors.New("nobody with that signature is an administrator here")

	// ErrLastModerator guards the one mistake that cannot be undone from the
	// page it is made on: removing the last person who can add anybody back.
	// Recovering from it means editing a file on the host and restarting, which
	// ends every call in progress.
	ErrLastModerator = errors.New("this is the last administrator who can change anything")
)

// tripLength is what room.Trip produces, without the kind prefix.
const tripLength = 10

// Valid reports whether this is an administrator the deployment can use.
func (a Admin) Valid() error {
	switch {
	case strings.TrimSpace(a.Trip) == "":
		return ErrAdminNoTrip

	case len(a.Trip) != tripLength || strings.ToLower(a.Trip) != a.Trip || !alphanumeric(a.Trip):
		return ErrAdminBadTrip

	case len(a.Name) > 64:
		return ErrAdminLongName
	}

	for _, can := range a.Can {
		if can != config.Observe && can != config.Moderate {
			return ErrAdminBadCan
		}
	}

	return nil
}

func alphanumeric(s string) bool {
	for _, r := range s {
		if (r < 'a' || r > 'z') && (r < '0' || r > '9') {
			return false
		}
	}

	return true
}

// Admins lists everybody, by signature.
//
// Sorted so that a page redrawn after a change does not reorder itself under
// whoever is reading it.
func (s *Store) Admins() ([]Admin, error) {
	var list []Admin

	err := s.db.View(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(adminsBucket)
		if bucket == nil {
			return nil
		}

		return bucket.ForEach(func(_, raw []byte) error {
			var admin Admin
			if err := json.Unmarshal(raw, &admin); err != nil {
				// One unreadable entry should not take the list with it, and a
				// list that came back short would lock everybody out.
				return nil
			}

			list = append(list, admin)
			return nil
		})
	})

	if err != nil {
		return nil, fmt.Errorf("read the administrators: %w", err)
	}

	sort.Slice(list, func(i, j int) bool { return list[i].Trip < list[j].Trip })

	return list, nil
}

// AddAdmin records a new one.
func (s *Store) AddAdmin(admin Admin) error {
	if err := admin.Valid(); err != nil {
		return err
	}

	admin.Trip = strings.TrimSpace(admin.Trip)
	admin.Name = strings.TrimSpace(admin.Name)

	if admin.Added.IsZero() {
		admin.Added = time.Now().UTC()
	}

	return s.db.Update(func(tx *bolt.Tx) error {
		bucket, err := tx.CreateBucketIfNotExists(adminsBucket)
		if err != nil {
			return err
		}

		if bucket.Get([]byte(admin.Trip)) != nil {
			return ErrAdminExists
		}

		encoded, err := json.Marshal(admin)
		if err != nil {
			return err
		}

		return bucket.Put([]byte(admin.Trip), encoded)
	})
}

// UpdateAdmin changes what somebody may do, or what they are called.
//
// The signature is the key and cannot be changed: it is not a label but the
// thing being recognised, and changing it would be removing one administrator
// and adding another under cover of an edit.
func (s *Store) UpdateAdmin(admin Admin) error {
	if err := admin.Valid(); err != nil {
		return err
	}

	admin.Name = strings.TrimSpace(admin.Name)

	return s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(adminsBucket)
		if bucket == nil {
			return ErrNoSuchAdmin
		}

		raw := bucket.Get([]byte(admin.Trip))
		if raw == nil {
			return ErrNoSuchAdmin
		}

		var existing Admin
		if err := json.Unmarshal(raw, &existing); err == nil {
			admin.Added = existing.Added
		}

		// Losing the last moderator is checked here rather than at the API,
		// because the store is what the running deployment reads and this is the
		// one change that cannot be undone from the page that made it.
		if existing.Allows(config.Moderate) && !admin.Allows(config.Moderate) {
			if lastModerator(bucket, admin.Trip) {
				return ErrLastModerator
			}
		}

		encoded, err := json.Marshal(admin)
		if err != nil {
			return err
		}

		return bucket.Put([]byte(admin.Trip), encoded)
	})
}

// RemoveAdmin forgets somebody.
//
// Their open session is not ended here — sessions are held in memory by whoever
// keeps them — but it expires within the half hour and cannot be renewed,
// because renewing asks this list again.
func (s *Store) RemoveAdmin(trip string) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(adminsBucket)
		if bucket == nil {
			return ErrNoSuchAdmin
		}

		if bucket.Get([]byte(trip)) == nil {
			return ErrNoSuchAdmin
		}

		if lastModerator(bucket, trip) {
			return ErrLastModerator
		}

		return bucket.Delete([]byte(trip))
	})
}

// lastModerator reports whether removing this signature's moderate capability
// would leave nobody holding it.
func lastModerator(bucket *bolt.Bucket, trip string) bool {
	others := 0

	_ = bucket.ForEach(func(key, raw []byte) error {
		if string(key) == trip {
			return nil
		}

		var admin Admin
		if err := json.Unmarshal(raw, &admin); err != nil {
			return nil
		}

		if admin.Allows(config.Moderate) {
			others++
		}

		return nil
	})

	return others == 0
}

// Allows reports whether this administrator holds a capability.
//
// Delegated to the configuration's own answer so that there is one rule rather
// than two: the join endpoint asks the same question of the same shape, and two
// answers to one question is one of them waiting to drift.
func (a Admin) Allows(capability string) bool {
	return config.Admin{Trip: a.Trip, Can: a.Can}.Allows(capability)
}

// Configured turns a stored administrator into the shape the rest of the
// deployment recognises people by.
func (a Admin) Configured() config.Admin {
	return config.Admin{Trip: a.Trip, Name: a.Name, Can: a.Can}
}

// AdoptAdmins writes the configured administrators in, the first time this runs.
//
// The same bargain the relays strike, and the reason it matters more: this is
// how the first administrator comes to exist, and a deployment whose store was
// lost has to be able to get back in by editing a file on the host. Adopted only
// when the bucket has never existed, so that a deployment which deliberately
// removed somebody does not have them put back on the next restart.
func (s *Store) AdoptAdmins(configured []config.Admin) (adopted bool, err error) {
	err = s.db.Update(func(tx *bolt.Tx) error {
		if tx.Bucket(adminsBucket) != nil {
			return nil
		}

		bucket, err := tx.CreateBucketIfNotExists(adminsBucket)
		if err != nil {
			return err
		}

		for _, one := range configured {
			admin := Admin{Trip: one.Trip, Name: one.Name, Can: one.Can, Added: time.Now().UTC()}

			if err := admin.Valid(); err != nil {
				return fmt.Errorf("administrator %q from the configuration: %w", one.Name, err)
			}

			encoded, err := json.Marshal(admin)
			if err != nil {
				return err
			}

			if err := bucket.Put([]byte(admin.Trip), encoded); err != nil {
				return err
			}
		}

		adopted = true
		return nil
	})

	if err != nil {
		return false, fmt.Errorf("adopt the configured administrators: %w", err)
	}

	return adopted, nil
}
