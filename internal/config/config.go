// Package config loads one document describing the whole process: this
// server's own settings alongside the media server's.
//
// They cannot be unmarshalled together. LiveKit's loader can be asked to reject
// keys it does not recognise, and a shared document would make that check
// useless, so the `meet` section is lifted out first and what remains is handed
// over untouched. One file, one deletion, and no fighting the upstream type.
package config

import (
	"bytes"
	"crypto/subtle"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"tomoshibi/internal/room"

	livekit "github.com/livekit/livekit-server/pkg/config"
	"gopkg.in/yaml.v3"
)

// Meet is everything the media server has no opinion about.
type Meet struct {
	// Listen is the address serving the client, the API, and the signalling
	// proxy. The one port anybody outside this machine talks to over TCP.
	Listen string `yaml:"listen"`

	// WebRoot serves the client from a directory instead of the copy built into
	// the binary. Useful while working on the client; unset in a deployment.
	WebRoot string `yaml:"web_root"`

	// Database is the key-value file recording which rooms have been used.
	Database string `yaml:"database"`

	// TripcodeKey signs the passphrases that turn a display name into one
	// nobody else can wear. Created on first use.
	//
	// Its own file rather than the API credentials, because the two have
	// opposite lifetimes: those should be rotated, and rotating this one
	// silently changes everybody's signature, which is the one thing a
	// signature must never do.
	TripcodeKey string `yaml:"tripcode_key"`

	// PublicURL overrides the address clients are told to dial. Only needed
	// behind a proxy or a name the request does not already carry.
	PublicURL string `yaml:"public_url"`

	// TokenTTL is how long a join token stays valid. Short by design: it is
	// spent on the next connect and never reused.
	TokenTTL time.Duration `yaml:"token_ttl"`

	// JoinRate and JoinBurst bound how fast rooms can be asked for. A room
	// exists because somebody named it, so asking for an unused one succeeds
	// exactly like asking for a busy one. There is no failure to count, which
	// leaves the rate as the only thing between a script and somebody's meeting.
	JoinRate  float64 `yaml:"join_rate"`
	JoinBurst int     `yaml:"join_burst"`

	// TrustProxy believes `X-Forwarded-For` and `X-Forwarded-Host`. Only true
	// behind a proxy that sets them; exposed directly they are whatever the
	// caller typed, and believing them would let anyone claim a fresh rate-limit
	// budget per request.
	TrustProxy bool `yaml:"trust_proxy"`

	// Admins may open the management pages. Empty, which is the default, means
	// there are none and those pages do not exist.
	Admins []Admin `yaml:"admins"`

	// Rooms is what may be done with a name nobody has used.
	Rooms Rooms `yaml:"rooms"`
}

// Rooms is the policy for names nobody has used.
type Rooms struct {
	// OpenedBy is who may use one for the first time.
	//
	// The starting value alone. It is written into the store the first time the
	// server runs, and from then on the management pages are what change it —
	// so editing this afterwards changes nothing, and the runtime panel shows
	// the two side by side for whoever is reading the file and wondering why.
	OpenedBy room.Opening `yaml:"opened_by"`
}

// What an administrator is allowed to do.
//
// Two levels rather than one, because the two halves of this differ by more
// than degree. Watching costs nothing and answers the question anybody debugging
// a call actually has; removing somebody from a room changes what another person
// is experiencing, at once and without warning. Bound together, the choice
// becomes give everybody the dangerous half or give nobody the useful one.
const (
	// Observe reads: what is happening now, which rooms exist, who is in them
	// and what they are sending, whether the server is healthy.
	Observe = "observe"

	// Moderate acts: remove a participant, mute a track, close a room.
	Moderate = "moderate"
)

// Admin is somebody who may open the management pages.
//
// Identified by the signature their passphrase produces rather than by the
// passphrase itself. A passphrase in a configuration file is a credential lying
// in plain sight — on disk, in every backup, and in whatever holds the
// deployment's history. A signature is public: it is printed beside its owner's
// name in every room they join, and knowing it grants nothing.
type Admin struct {
	// Trip is the signature, without the kind prefix the identity carries.
	Trip string `yaml:"trip"`

	// Name appears in the audit log. Not used for anything else, because
	// nothing here is authorised by a name.
	Name string `yaml:"name"`

	// Can lists what this administrator may do. Empty means Observe alone,
	// which is the safe reading of an entry somebody wrote in a hurry.
	Can []string `yaml:"can"`
}

// Allows reports whether this administrator holds a capability.
func (a Admin) Allows(capability string) bool {
	if capability == Observe {
		return true
	}

	for _, held := range a.Can {
		if held == capability {
			return true
		}
	}

	return false
}

// Config is both halves, resolved.
type Config struct {
	Meet    Meet
	LiveKit *livekit.Config

	// Key and Secret are the API credentials the embedded media server verifies
	// with, and therefore the ones this server signs with. Read back out of the
	// resolved LiveKit config rather than configured separately, so there is no
	// second place for them to drift.
	Key    string
	Secret string
}

// Defaults every field falls back to.
//
// Chosen so that running the binary with no configuration at all produces a
// working server. The burst covers a large meeting arriving at once; the rate is
// what a script is left with afterwards.
var defaults = Meet{
	Listen:      ":8080",
	Database:    "meet.db",
	TripcodeKey: "tripcode.key",
	TokenTTL:    5 * time.Minute,
	JoinRate:    10,
	JoinBurst:   120,
	TrustProxy:  false,
	Rooms:       Rooms{OpenedBy: room.ByAnyone},
}

// Load reads the configuration from path, or returns the defaults if path is
// empty.
func Load(path string) (*Config, error) {
	document := []byte{}

	if path != "" {
		read, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("read %s: %w", path, err)
		}
		document = read
	}

	meet, rest, err := split(document)
	if err != nil {
		return nil, err
	}

	// Strict: a typo in a LiveKit key should be an error rather than a setting
	// that silently did nothing. Ours is checked the same way, in split.
	lk, err := livekit.NewConfig(string(rest), true, nil, nil)
	if err != nil {
		return nil, fmt.Errorf("load the media server configuration: %w", err)
	}

	key, secret, err := credentials(lk)
	if err != nil {
		return nil, err
	}

	if err := checkAdmins(meet.Admins); err != nil {
		return nil, err
	}

	if !meet.Rooms.OpenedBy.Valid() {
		return nil, fmt.Errorf(
			"rooms.opened_by: %q is not who a room can be opened by. The two are %q and %q",
			meet.Rooms.OpenedBy, room.ByAnyone, room.ByAdmins)
	}

	return &Config{Meet: meet, LiveKit: lk, Key: key, Secret: secret}, nil
}

// checkAdmins refuses an administrator entry that cannot mean what it says.
//
// At startup rather than at the moment somebody tries to sign in, because the
// two failures look nothing alike from the outside: a mistyped signature is a
// door that opens for nobody, and whoever finds that out is standing at it
// wondering whether they have forgotten their own passphrase.
func checkAdmins(admins []Admin) error {
	seen := make(map[string]bool, len(admins))

	for i, admin := range admins {
		where := fmt.Sprintf("admins[%d]", i)
		if admin.Name != "" {
			where = fmt.Sprintf("%s (%s)", where, admin.Name)
		}

		switch {
		case admin.Trip == "":
			return fmt.Errorf("%s has no trip. Run `tomoshibi admin new` to make one", where)

		case len(admin.Trip) != room.TripLength:
			return fmt.Errorf(
				"%s: a trip is %d characters, and this one is %d. The kind prefix and "+
					"the dash that follow it in an identity are not part of it",
				where, room.TripLength, len(admin.Trip))

		case !tripCharacters(admin.Trip):
			return fmt.Errorf(
				"%s: a trip is lowercase letters and the digits 2 to 7. This one holds "+
					"something else", where)

		case seen[admin.Trip]:
			return fmt.Errorf("%s: this trip is listed twice, which can only be a mistake", where)
		}

		for _, capability := range admin.Can {
			if capability != Observe && capability != Moderate {
				return fmt.Errorf(
					"%s: %q is not something an administrator can be allowed. The two are %q and %q",
					where, capability, Observe, Moderate)
			}
		}

		seen[admin.Trip] = true
	}

	return nil
}

// Administrator finds the administrator a passphrase belongs to.
//
// The signature is derived exactly as a participant's is, with the same key, so
// an administrator's credential is the one they already have: they type it to
// join a call and it prints beside their name. What is listed here is that
// printed signature and never the passphrase.
//
// Every entry is compared even after one matches. The work is a handful of
// string comparisons, and stopping at the first match would leak, through the
// time taken, how far down the list a signature sits.
func Administrator(admins []Admin, passphrase room.Passphrase, tripKey []byte) (Admin, bool) {
	if passphrase.Empty() {
		return Admin{}, false
	}

	trip := []byte(room.Trip(tripKey, strings.TrimSpace(string(passphrase))))

	var found Admin
	matched := false

	for _, admin := range admins {
		if subtle.ConstantTimeCompare([]byte(admin.Trip), trip) == 1 {
			found = admin
			matched = true
		}
	}

	return found, matched
}

// tripCharacters says whether a signature holds only what one is made of. The
// alphabet lives in the package that makes them; this is the one thing about it
// worth checking here, and checking it here is what turns a mistyped entry into
// a message at startup rather than a door that opens for nobody.
func tripCharacters(trip string) bool {
	for _, r := range trip {
		if (r < 'a' || r > 'z') && (r < '2' || r > '7') {
			return false
		}
	}

	return true
}

// split separates the `meet` section from the rest of the document.
//
// The remainder is re-encoded rather than edited in place, because YAML is not
// a format one can safely cut a section out of with string operations: anchors,
// flow style, and comments all make the textual boundaries of a section
// something only a parser knows.
func split(document []byte) (Meet, []byte, error) {
	meet := defaults

	if len(document) == 0 {
		return meet, nil, nil
	}

	var whole map[string]yaml.Node
	if err := yaml.Unmarshal(document, &whole); err != nil {
		return meet, nil, fmt.Errorf("parse the configuration: %w", err)
	}

	if section, ok := whole["meet"]; ok {
		// Round-tripped through bytes rather than decoded from the node, because
		// only a Decoder can be told to reject unknown fields, and a typo in our
		// half deserves the same error as a typo in theirs.
		raw, err := yaml.Marshal(&section)
		if err != nil {
			return meet, nil, fmt.Errorf("re-encode the meet section: %w", err)
		}

		decoder := yaml.NewDecoder(bytes.NewReader(raw))
		decoder.KnownFields(true)

		if err := decoder.Decode(&meet); err != nil && err != io.EOF {
			return meet, nil, fmt.Errorf("parse the meet section: %w", err)
		}

		delete(whole, "meet")
	}

	rest, err := yaml.Marshal(whole)
	if err != nil {
		return meet, nil, fmt.Errorf("re-encode the configuration: %w", err)
	}

	return meet, rest, nil
}

// credentials pulls the one API key pair out of the resolved config.
//
// Exactly one, because this server signs with it: several would mean choosing,
// and a choice nobody made is a choice that will surprise somebody.
func credentials(lk *livekit.Config) (string, string, error) {
	switch len(lk.Keys) {
	case 0:
		return "", "", fmt.Errorf(
			"no API key: add one under `keys` in the configuration, " +
				"or run `tomoshibi keygen` to generate a pair",
		)
	case 1:
		for key, secret := range lk.Keys {
			return key, secret, nil
		}
	}

	return "", "", fmt.Errorf(
		"%d API keys configured, but this server signs its own tokens and can only use one: "+
			"leave a single entry under `keys`", len(lk.Keys),
	)
}
