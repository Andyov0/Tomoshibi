package store

import (
	"encoding/json"
	"strings"
	"time"

	bolt "go.etcd.io/bbolt"
)

/*
What was seen of somebody at the door.

The media server knows who is in a room and what they are sending, and it does
not know either of the two things an operator asks first: where they came from,
and which machine they came in through. It cannot — by the time it sees them
they arrived over a signalling socket from a relay, and the relay is what it
would report.

This server saw both, once, at the join: the address the request came from, and
the machine it chose for them. Neither is recoverable afterwards, so it is
written down there and nowhere else.

Kept against the identity rather than the name. A name is typed and can be
anything; the identity is signed into the token and is the one field about a
participant that nobody, including them, can change afterwards — which is what
makes the row worth reading at all.

These expire. An arrival is a note about a call in progress and stops being true
the moment somebody leaves, and nothing tells this server when that happens: the
media server holds the room and this one is not in it. So they are swept on age
rather than on departure, and a row older than a long meeting is a row about
nobody.
*/

var arrivals = []byte("arrivals")

// How long an arrival is kept.
//
// Longer than any meeting anybody holds here, because the cost of keeping one
// too long is a stale line on a management page and the cost of dropping one too
// early is a person in a call with no address beside their name.
const arrivalFor = 12 * time.Hour

// Arrival is what was known about somebody when they were let in.
type Arrival struct {
	// Address is where the request came from, as the deployment resolved it —
	// through a proxy where one is trusted, and from the socket where none is.
	Address string `json:"address,omitempty"`
	// Relay is the machine they were sent to: the door, not necessarily the room.
	Relay string `json:"relay,omitempty"`
	// Holding is the machine the meeting is on, where that is a different one.
	Holding string `json:"holding,omitempty"`
	// Forwarded says their media is being carried through Relay to Holding.
	Forwarded bool `json:"forwarded,omitempty"`
	// At is when they arrived, and is what ages the row out.
	At time.Time `json:"at"`
}

func arrivalKey(room, identity string) []byte {
	// A separator that cannot occur in either half: room names are checked
	// against a narrow alphabet and an identity is a mark and hex. Without one,
	// two different pairs could share a key.
	return []byte(room + "\x00" + identity)
}

// Arrived writes down what was seen of somebody at the join.
func (s *Store) Arrived(room, identity string, arrival Arrival) error {
	encoded, err := json.Marshal(arrival)
	if err != nil {
		return err
	}

	return s.db.Update(func(tx *bolt.Tx) error {
		bucket, err := tx.CreateBucketIfNotExists(arrivals)
		if err != nil {
			return err
		}

		return bucket.Put(arrivalKey(room, identity), encoded)
	})
}

// Arrivals reads back everybody seen arriving at one room.
//
// Returned by identity, so a caller holding the media server's roster can put
// the two together without a second pass. A room nobody arrived at is an empty
// map rather than an error: the store is not the authority on who is in a room
// and must not answer as if it were.
func (s *Store) Arrivals(room string) map[string]Arrival {
	found := make(map[string]Arrival)
	prefix := room + "\x00"

	_ = s.db.View(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(arrivals)
		if bucket == nil {
			return nil
		}

		cursor := bucket.Cursor()
		for key, raw := cursor.Seek([]byte(prefix)); key != nil &&
			strings.HasPrefix(string(key), prefix); key, raw = cursor.Next() {
			var arrival Arrival
			if err := json.Unmarshal(raw, &arrival); err != nil {
				continue
			}

			if time.Since(arrival.At) > arrivalFor {
				continue
			}

			found[strings.TrimPrefix(string(key), prefix)] = arrival
		}

		return nil
	})

	return found
}

// SweepArrivals removes the ones that have aged out.
//
// On the same timer as the sessions, and for the same reason: without it the
// file grows by one entry per join forever, and the entries are about calls that
// ended months ago.
func (s *Store) SweepArrivals(now time.Time) (gone int, err error) {
	err = s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(arrivals)
		if bucket == nil {
			return nil
		}

		var stale [][]byte

		if err := bucket.ForEach(func(key, raw []byte) error {
			var arrival Arrival
			if err := json.Unmarshal(raw, &arrival); err != nil ||
				now.Sub(arrival.At) > arrivalFor {
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

	return gone, err
}
