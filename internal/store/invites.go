package store

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"time"

	bolt "go.etcd.io/bbolt"
)

/*
A link that lets one person into one room, once, without a passphrase.

The two ways in here are otherwise both about knowing something: a passphrase, or
a name nobody has told anybody else. Neither suits somebody being invited to one
meeting — handing over a passphrase gives them the account, and handing over the
room name gives them every future meeting held under it, because a room here is a
name and nothing else.

So an invite is a third thing, and its whole value is in what it does not carry.
It names one room, it stops working, and it proves nothing about who redeems it:
whoever arrives gets an issued mark, which says only that they are not the other
people in the call. It is not a credential and it is not an identity, which is
exactly right for somebody who was sent a link.

Single use is the default and it is a real constraint rather than a gesture: a
link pasted into a group chat lets in the first person and no one else. What it
must not do is lock out the person who redeemed it — a reload, a dropped
connection, a phone that slept — so redeeming records the identity it was spent
on, and that identity may come back through the same invite for as long as it
lasts. The link is spent on a person, not on a page load.
*/

var invites = []byte("invites")

// What an invite can be wrong in, from the point of view of somebody holding one.
//
// Three answers rather than one, because they are three different sentences to
// the person reading them and only one of them means "ask for another link".
var (
	ErrNoSuchInvite  = errors.New("no invite by that token is here")
	ErrInviteExpired = errors.New("that invite has run out")
	ErrInviteSpent   = errors.New("that invite has already been used")
)

// Invite is a one-off way into one room.
type Invite struct {
	// Room is the only room it opens. Checked on redemption rather than trusted
	// from the request, or a token for one meeting would open any of them.
	Room string `json:"room"`
	// By is the signature of whoever made it, for a log and for a page that
	// wants to say who invited whom.
	By string `json:"by,omitempty"`
	// Created and Expires bound it in time.
	Created time.Time `json:"created"`
	Expires time.Time `json:"expires"`
	// Uses is how many people it admits. One, unless somebody asked otherwise.
	Uses int `json:"uses"`
	// Spent is how many have come through.
	Spent int `json:"spent,omitempty"`
	// Holders are the identities it was spent on.
	//
	// Kept so that redeeming is spent on a person rather than on a page load: a
	// reload, a dropped connection or a phone that slept all come back with the
	// identity they were given, and being turned away then would be the invite
	// working exactly as specified and failing at what it is for.
	Holders []string `json:"holders,omitempty"`
}

// Live reports whether an invite is still worth anything at all.
func (i Invite) Live(now time.Time) bool {
	return now.Before(i.Expires) && i.Spent < i.Uses
}

// Admits reports whether this identity may come through, spent or not.
func (i Invite) Admits(identity string) bool {
	for _, held := range i.Holders {
		if held == identity {
			return true
		}
	}

	return false
}

// NewInviteToken draws one nobody can guess.
//
// Long, and from crypto/rand, because this is the whole of the check: an invite
// carries no second factor and names no person, so a token somebody could
// enumerate would be a room anybody could walk into.
func NewInviteToken() (string, error) {
	raw := make([]byte, 24)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}

	return base64.RawURLEncoding.EncodeToString(raw), nil
}

// KeepInvite writes one down.
func (s *Store) KeepInvite(token string, invite Invite) error {
	encoded, err := json.Marshal(invite)
	if err != nil {
		return err
	}

	return s.db.Update(func(tx *bolt.Tx) error {
		bucket, err := tx.CreateBucketIfNotExists(invites)
		if err != nil {
			return err
		}

		return bucket.Put(held(token), encoded)
	})
}

// Invite reads one back without spending it.
//
// For the page somebody lands on, which has to say which room they were invited
// to before they have typed a name — and must not consume the invite for having
// been looked at, or a preview would burn the link.
func (s *Store) Invite(token string) (Invite, bool) {
	var invite Invite
	found := false

	_ = s.db.View(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(invites)
		if bucket == nil {
			return nil
		}

		raw := bucket.Get(held(token))
		if raw == nil {
			return nil
		}

		if err := json.Unmarshal(raw, &invite); err == nil {
			found = true
		}

		return nil
	})

	return invite, found
}

// Redeem spends an invite on one identity, or says why it cannot be.
//
// The whole check happens inside one transaction. Reading, deciding and writing
// separately would let two people holding the same link both read a live invite
// and both be admitted, which is the one thing single use exists to prevent and
// the one case a link pasted into a group chat produces.
func (s *Store) Redeem(token, room, identity string, now time.Time) (Invite, error) {
	var invite Invite

	err := s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(invites)
		if bucket == nil {
			return ErrNoSuchInvite
		}

		raw := bucket.Get(held(token))
		if raw == nil {
			return ErrNoSuchInvite
		}

		if err := json.Unmarshal(raw, &invite); err != nil {
			return ErrNoSuchInvite
		}

		// The room the invite names, never the room that was asked for. Without
		// this a token for one meeting would open any of them, which is the
		// difference between an invitation and a key.
		if invite.Room != room {
			return ErrNoSuchInvite
		}

		if !now.Before(invite.Expires) {
			return ErrInviteExpired
		}

		// Already through, coming back. A reload must not be turned away.
		if invite.Admits(identity) {
			return nil
		}

		if invite.Spent >= invite.Uses {
			return ErrInviteSpent
		}

		invite.Spent++
		invite.Holders = append(invite.Holders, identity)

		encoded, err := json.Marshal(invite)
		if err != nil {
			return err
		}

		return bucket.Put(held(token), encoded)
	})

	return invite, err
}

// Invites lists the live ones for a room, with their tokens.
//
// The token is returned because whoever made an invite has to be able to copy
// the link again, and it is not recoverable any other way — what is stored is
// its hash. So this is only ever answered to somebody who may already read the
// room, and it returns nothing for a room that has none.
func (s *Store) Invites(room string, now time.Time) []Invite {
	var live []Invite

	_ = s.db.View(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(invites)
		if bucket == nil {
			return nil
		}

		return bucket.ForEach(func(_, raw []byte) error {
			var invite Invite
			if err := json.Unmarshal(raw, &invite); err != nil {
				return nil
			}

			if invite.Room == room && invite.Live(now) {
				live = append(live, invite)
			}

			return nil
		})
	})

	return live
}

// SweepInvites removes the ones nobody can use.
func (s *Store) SweepInvites(now time.Time) (gone int, err error) {
	err = s.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(invites)
		if bucket == nil {
			return nil
		}

		var stale [][]byte

		if err := bucket.ForEach(func(key, raw []byte) error {
			var invite Invite
			if err := json.Unmarshal(raw, &invite); err != nil || !now.Before(invite.Expires) {
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
