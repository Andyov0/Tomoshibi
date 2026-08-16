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

// relaysBucket holds the media servers this deployment hands clients to.
//
// In the store rather than in the configuration file, for the reason
// rooms.opened_by is: a relay is added when a machine is brought up and removed
// when it is taken away, and both happen while the deployment is running.
// Editing a file and restarting to add one would drop every call in progress on
// the control node, which is a strange price for an operation that changes
// nothing about the calls already being held elsewhere.
//
// The configuration file remains the starting value, adopted the first time
// this runs, exactly as the opening policy is.
var relaysBucket = []byte("relays")

// Relay is one media server, as the deployment knows it.
type Relay struct {
	// Name identifies it: to an operator reading a log, and to a client naming
	// the one it measured as fastest. Immutable once created — a rename would
	// silently orphan every client that had measured the old one.
	Name string `json:"name"`

	// URL is the WebSocket origin a browser dials. Handed to clients verbatim.
	URL string `json:"url"`

	// Region is this deployment's own label for where the machine is. Compared
	// against a client's, never interpreted.
	Region string `json:"region,omitempty"`

	// Enabled is whether clients are sent here.
	//
	// The reason this is a flag rather than a deletion: taking a relay out of
	// service should stop new calls from arriving without ending the ones it is
	// already holding, and should be reversible by somebody who did not write
	// down its address first.
	Enabled bool `json:"enabled"`

	// Added is when somebody put it here, for a page that wants to say so.
	Added time.Time `json:"added"`
}

// What a relay can be wrong in.
//
// Sentinels rather than sentences, because the sentence belongs to whoever is
// showing it: these travel to a management page that says them in the reader's
// own language, and an English string returned from here would arrive on screen
// untranslated. The text on each is for a log and for whoever is reading a stack
// trace, and is never what a person is shown.
var (
	ErrRelayNoName   = errors.New("a relay needs a name")
	ErrRelayLongName = errors.New("a relay name is at most 64 characters")
	ErrRelayNoURL    = errors.New("a relay needs a url")
	ErrRelayBadURL   = errors.New("a relay url must begin ws:// or wss://")
	ErrRelayLongTag  = errors.New("a relay region is at most 64 characters")
	ErrRelayExists   = errors.New("a relay with that name is already here")
	ErrNoSuchRelay   = errors.New("no relay by that name is here")
)

// Valid reports whether a relay is one this deployment can use.
//
// Checked here rather than only at the API, because the store is what the
// running deployment reads: a relay that got in by any route at all has to be
// one a client can be handed.
func (r Relay) Valid() error {
	switch {
	case strings.TrimSpace(r.Name) == "":
		return ErrRelayNoName

	case len(r.Name) > 64:
		return ErrRelayLongName

	case strings.TrimSpace(r.URL) == "":
		return ErrRelayNoURL

	case !strings.HasPrefix(r.URL, "ws://") && !strings.HasPrefix(r.URL, "wss://"):
		return ErrRelayBadURL

	case len(r.Region) > 64:
		return ErrRelayLongTag
	}

	return nil
}

// Relays lists every relay, enabled or not, by name.
//
// Sorted so that a page redrawn after a change does not reorder itself under
// whoever is reading it, and so that two control nodes show the same list.
func (s *Store) Relays() ([]Relay, error) {
	var list []Relay

	err := s.db.View(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(relaysBucket)
		if bucket == nil {
			return nil
		}

		return bucket.ForEach(func(_, raw []byte) error {
			var relay Relay
			if err := json.Unmarshal(raw, &relay); err != nil {
				// One unreadable entry should not take the list with it: the
				// page is how somebody would find out and fix it.
				return nil
			}

			list = append(list, relay)
			return nil
		})
	})

	if err != nil {
		return nil, fmt.Errorf("read the relays: %w", err)
	}

	sort.Slice(list, func(i, j int) bool { return list[i].Name < list[j].Name })

	return list, nil
}

// AddRelay records a new one.
//
// Refuses a name already in use rather than overwriting it. The two operations
// read the same in a hurry and mean opposite things: adding a relay somebody
// else added is a mistake worth hearing about, and silently replacing its
// address would move every future call without anybody asking.
func (s *Store) AddRelay(relay Relay) error {
	if err := relay.Valid(); err != nil {
		return err
	}

	relay.Name = strings.TrimSpace(relay.Name)
	relay.URL = strings.TrimSpace(relay.URL)
	relay.Region = strings.TrimSpace(relay.Region)

	if relay.Added.IsZero() {
		relay.Added = time.Now().UTC()
	}

	return s.db.Update(func(tx *bolt.Tx) error {
		bucket, err := tx.CreateBucketIfNotExists(relaysBucket)
		if err != nil {
			return err
		}

		if bucket.Get([]byte(relay.Name)) != nil {
			return ErrRelayExists
		}

		encoded, err := json.Marshal(relay)
		if err != nil {
			return err
		}

		return bucket.Put([]byte(relay.Name), encoded)
	})
}

// UpdateRelay changes one that is already here.
//
// The name is the key and cannot be changed: a client that measured "shanghai"
// a minute ago will name it at the join, and a rename would leave that client
// falling back as though it had never measured anything.
func (s *Store) UpdateRelay(relay Relay) error {
	if err := relay.Valid(); err != nil {
		return err
	}

	relay.URL = strings.TrimSpace(relay.URL)
	relay.Region = strings.TrimSpace(relay.Region)

	return s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(relaysBucket)
		if bucket == nil {
			return ErrNoSuchRelay
		}

		raw := bucket.Get([]byte(relay.Name))
		if raw == nil {
			return ErrNoSuchRelay
		}

		// The date it was added belongs to the original entry; an edit is not
		// a re-adding and should not look like one.
		var existing Relay
		if err := json.Unmarshal(raw, &existing); err == nil {
			relay.Added = existing.Added
		}

		encoded, err := json.Marshal(relay)
		if err != nil {
			return err
		}

		return bucket.Put([]byte(relay.Name), encoded)
	})
}

// RemoveRelay forgets one.
//
// Calls already being held on it are not ended: this server has no way to end
// them and no business doing so. What stops is being sent there — which is why
// disabling is the gentler operation and this one is for a machine that is gone.
func (s *Store) RemoveRelay(name string) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(relaysBucket)
		if bucket == nil {
			return ErrNoSuchRelay
		}

		if bucket.Get([]byte(name)) == nil {
			return ErrNoSuchRelay
		}

		return bucket.Delete([]byte(name))
	})
}

// AdoptRelays writes the configured relays in, the first time this runs.
//
// The same bargain rooms.opened_by strikes: the file is the starting value and
// the management pages are what change it afterwards. Adopted only when the
// bucket has never existed, rather than when it is empty — a deployment that
// deliberately removed its last relay should not have the file's put back on
// the next restart.
func (s *Store) AdoptRelays(configured []Relay) (adopted bool, err error) {
	err = s.db.Update(func(tx *bolt.Tx) error {
		if tx.Bucket(relaysBucket) != nil {
			return nil
		}

		bucket, err := tx.CreateBucketIfNotExists(relaysBucket)
		if err != nil {
			return err
		}

		for _, relay := range configured {
			if err := relay.Valid(); err != nil {
				return fmt.Errorf("relay %q from the configuration: %w", relay.Name, err)
			}

			relay.Enabled = true
			if relay.Added.IsZero() {
				relay.Added = time.Now().UTC()
			}

			encoded, err := json.Marshal(relay)
			if err != nil {
				return err
			}

			if err := bucket.Put([]byte(relay.Name), encoded); err != nil {
				return err
			}
		}

		adopted = true
		return nil
	})

	if err != nil {
		return false, fmt.Errorf("adopt the configured relays: %w", err)
	}

	return adopted, nil
}
