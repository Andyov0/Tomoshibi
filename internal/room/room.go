// Package room turns a requested name into an authorisation to join it.
//
// There is no room object anywhere on the server and no membership table. A room
// exists because somebody named it, and stops existing when the last participant
// leaves. What this package produces is a signed statement that the bearer may
// join one particular room under one particular identity, and nothing else.
package room

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strings"
	"time"

	"github.com/livekit/protocol/auth"
)

// MaxDisplayName is the longest display name accepted.
//
// Trimmed rather than refused, because a name is the one field where a caller's
// intent is obvious and an error would be pedantic.
const MaxDisplayName = 40

// MaxName is the longest room name accepted.
//
// Long enough for a generated name with room to spare, short enough that a name
// stays something a person can repeat over the phone.
const MaxName = 64

// guest prefixes an unsigned identity this server minted, so one can be told
// from a name a caller invented. A signed identity uses its own prefix; see
// [Trip].
const guest = "g-"

// random is how many hex characters of randomness every identity carries.
//
// Present even on a signed identity, so that one person joining twice is two
// participants who happen to share a signature rather than one who keeps
// evicting themselves.
const random = 32

// ValidName reports whether name is one this server will authorise.
//
// Lowercase letters, digits, and inner dashes. Narrow on purpose: the name
// travels in URLs, gets read aloud, and gets typed from memory, and every
// character class left out is a class of transcription error that cannot happen.
func ValidName(name string) bool {
	if name == "" || len(name) > MaxName {
		return false
	}

	if strings.HasPrefix(name, "-") || strings.HasSuffix(name, "-") {
		return false
	}

	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '-':
		default:
			return false
		}
	}

	return true
}

// ValidIdentity reports whether identity is one MintIdentity could have made.
//
// A caller returning something else is given a fresh one rather than refused:
// they get a working session instead of an error they cannot act on, and cannot
// smuggle in an identity of their own choosing.
func ValidIdentity(identity string) bool {
	if trip, ok := TripOf(identity); ok {
		return isTrip(trip) && isRandom(identity[len(signed)+TripLength+1:])
	}

	rest, ok := strings.CutPrefix(identity, guest)
	return ok && isRandom(rest)
}

// MintIdentity returns a fresh identity, carrying trip when there is one.
//
// The signature goes into the identity rather than beside it because the
// identity is signed into the token and enforced by the media server: it is the
// one field about a participant that nobody, including that participant, can
// change after the fact. A signature sent any other way would be a claim.
func MintIdentity(trip string) string {
	var raw [random / 2]byte
	if _, err := rand.Read(raw[:]); err != nil {
		// crypto/rand does not fail on any platform this runs on, and a
		// predictable identity is worse than not starting.
		panic(fmt.Sprintf("read random bytes: %v", err))
	}

	if trip == "" {
		return guest + hex.EncodeToString(raw[:])
	}

	return signed + trip + "-" + hex.EncodeToString(raw[:])
}

func isRandom(hex string) bool {
	if len(hex) != random {
		return false
	}

	for _, r := range hex {
		switch {
		case r >= '0' && r <= '9', r >= 'a' && r <= 'f':
		default:
			return false
		}
	}

	return true
}

func isTrip(trip string) bool {
	if len(trip) != TripLength {
		return false
	}

	for _, r := range trip {
		switch {
		case r >= 'a' && r <= 'z', r >= '2' && r <= '7':
		default:
			return false
		}
	}

	return true
}

// Grant is what a client needs to join.
type Grant struct {
	// Token authorises exactly one room and one identity.
	Token string
	// Identity is what the client will be known as, to be sent back on the next
	// join so a reload keeps the same one.
	Identity string
}

// Request is what a caller asks to be authorised for.
type Request struct {
	// Room is the name they want to join.
	Room string
	// Identity they were given previously, if any.
	Identity string
	// Display is what they would like to be called.
	Display string
	// Passphrase signs the display name, when they gave one.
	Passphrase Passphrase
	// TripKey signs passphrases for this deployment.
	TripKey []byte
	// TTL is how long the token stays valid.
	TTL time.Duration
}

// Authorise signs a token for one participant in one room.
//
// The grant is scoped as tightly as the protocol allows: one room, publishing
// and subscribing within it, and nothing about any other room. Admin rights are
// deliberately absent, so a leaked token cannot be used to inspect or close
// anything.
//
// The display name is signed in rather than set by the client after connecting.
// Two things follow: nobody can rename themselves to somebody else mid-call, and
// the name is there in the first roster update, so no one is ever briefly
// labelled with a raw identity.
func Authorise(key, secret string, req Request) (Grant, error) {
	if !ValidName(req.Room) {
		return Grant{}, fmt.Errorf("invalid room name")
	}

	// A signature the caller cannot influence: it comes from their passphrase
	// and this deployment's key, and nothing else.
	trip := ""
	if !req.Passphrase.Empty() {
		trip = Trip(req.TripKey, strings.TrimSpace(string(req.Passphrase)))
	}

	// Kept only when it still matches, so changing or dropping a passphrase
	// takes effect immediately rather than being masked by the identity a client
	// happens to be holding.
	identity := req.Identity
	if !ValidIdentity(identity) || tripOrEmpty(identity) != trip {
		identity = MintIdentity(trip)
	}

	token := auth.NewAccessToken(key, secret).
		SetIdentity(identity).
		SetName(display(req.Display, identity)).
		SetVideoGrant(&auth.VideoGrant{
			RoomJoin:     true,
			Room:         req.Room,
			CanPublish:   ptr(true),
			CanSubscribe: ptr(true),
			// Data messages carry the client's own signalling, which it has no
			// way to send otherwise.
			CanPublishData: ptr(true),
		}).
		SetValidFor(req.TTL)

	signed, err := token.ToJWT()
	if err != nil {
		return Grant{}, fmt.Errorf("sign a join token: %w", err)
	}

	return Grant{Token: signed, Identity: identity}, nil
}

// display cleans up what the caller asked to be called.
//
// Falls back to the identity rather than to an empty label, which would leave a
// tile with nothing under it and no way to tell who it belongs to.
func display(wanted, identity string) string {
	trimmed := strings.TrimSpace(wanted)

	if runes := []rune(trimmed); len(runes) > MaxDisplayName {
		trimmed = strings.TrimSpace(string(runes[:MaxDisplayName]))
	}

	if trimmed == "" {
		return identity
	}

	return trimmed
}

// tripOrEmpty is the signature an identity carries, or "" for an unsigned one.
func tripOrEmpty(identity string) string {
	trip, _ := TripOf(identity)
	return trip
}

func ptr[T any](value T) *T {
	return &value
}
