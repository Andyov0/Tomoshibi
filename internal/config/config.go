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

// Role is which half of a split deployment this process is.
//
// One binary, three ways to run it. Undivided is what upstream does and stays
// the default: a single process holding the client, the join endpoint, and the
// media. The other two exist because media and web have opposite requirements —
// media wants to sit close to the people sending it and is charged by the byte,
// while the client wants a name, a certificate, and somewhere cheap to serve a
// few kilobytes from. Splitting them lets each go where it belongs.
type Role string

const (
	// RoleFull serves everything from one process. The default, and what a
	// deployment that has not thought about this wants.
	RoleFull Role = "full"

	// RoleRelay carries media and nothing else: the embedded media server and
	// the signalling paths in front of it. No client, no join endpoint, no
	// store, no management pages. Several of these sit behind one control.
	RoleRelay Role = "relay"

	// RoleControl serves the client, the join endpoint, and the management
	// pages, and starts no media server of its own. It signs the tokens the
	// relays verify and tells each client which relay to dial.
	RoleControl Role = "control"
)

// Valid reports whether a role is one this binary knows how to be.
func (r Role) Valid() bool {
	switch r {
	case RoleFull, RoleRelay, RoleControl:
		return true
	}
	return false
}

// Relay is one media server a control node can hand clients to.
type Relay struct {
	// URL is what a client dials, as a WebSocket origin: `wss://sh.example.com`.
	// Handed to the client verbatim, so it must be reachable from a browser
	// rather than from the control node.
	URL string `yaml:"url"`

	// Name identifies this relay in logs and on the management pages.
	Name string `yaml:"name"`

	// Region is a label this deployment gives a place. Compared against a
	// client's own, never interpreted, so whatever vocabulary a deployment
	// already uses works: `cn-east`, `hk`, `eu`.
	Region string `yaml:"region"`
}

// How a control node picks which relay a client is told to dial.
const (
	// PickSticky sends everybody in a room to the same relay, chosen by the
	// room's name.
	//
	// The default, and the one that costs least. Media between two people on
	// one relay never leaves it; between two relays it is carried twice, once
	// to cross and once to deliver. On metered egress that difference is the
	// whole bill, so participants are gathered unless something asks otherwise.
	PickSticky = "sticky"

	// PickNearest sends each client to the relay whose region matches their
	// own, falling back to sticky when nothing matches.
	//
	// Trades the saving above for latency: a meeting spread over three regions
	// becomes three relays forwarding to each other. Worth it when the people
	// are genuinely far apart, and only then.
	PickNearest = "nearest"

	// PickRoundRobin spreads clients over the relays in turn, ignoring both
	// room and region. For levelling load across identical machines.
	PickRoundRobin = "round_robin"

	// PickProbe lets the client measure the relays and say which answered
	// fastest, falling back to sticky when it does not say.
	//
	// The only policy that knows what a network is actually doing. A region
	// label is somebody's belief about where the packets go, written once and
	// wrong the day a route changes; a measurement is the route as it is this
	// minute, taken from the one place that can see it — the browser making the
	// call. It costs one small request per relay before joining, in parallel,
	// which is nothing beside a call that is about to run for an hour.
	//
	// What a client sends is a name from the list it was given, never an
	// address: a policy that took a URL from the request would let anybody be
	// told to send their meeting anywhere.
	PickProbe = "probe"
)

// Meet is everything the media server has no opinion about.
type Meet struct {
	// Role is which half of a split deployment this is. Empty means full.
	Role Role `yaml:"role"`

	// Relays are the media servers a control node hands clients to. Only read
	// under RoleControl; a full deployment is its own relay and a relay is
	// never asked to choose one.
	Relays []Relay `yaml:"relays"`

	// RelayPolicy is how a control node chooses between them.
	RelayPolicy string `yaml:"relay_policy"`

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

	// SourceURL is where the code running here can be read.
	//
	// Shown to everybody who opens the client, because this is licensed under
	// the AGPL and its thirteenth section obliges whoever offers a program over
	// a network to offer its source to the people using it that way. Set it to
	// wherever a changed copy lives: a link to somebody else's repository is
	// not an offer of the source anybody is actually running.
	SourceURL string `yaml:"source_url"`
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

	// Remember is how long a name stays used after the last time it was joined.
	//
	// Two things at once, and they agree. A name is written down on first use
	// and nothing ever took one away, so the store grew for as long as anybody
	// asked it for names — bounded by the rate limiter in how fast and by
	// nothing at all in how many. And a name nobody has spoken in a month is
	// not a room in use; treating it as one leaves a room open for good because
	// somebody said its name once, last year.
	//
	// Under `admins` this is therefore how long a room stays open unattended.
	// Zero keeps every name for ever, which is what this did before the setting
	// existed and is still available to anybody who wants it.
	Remember time.Duration `yaml:"remember"`
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
	Role:        RoleFull,
	RelayPolicy: PickSticky,
	Listen:      ":8080",
	Database:    "meet.db",
	TripcodeKey: "tripcode.key",
	TokenTTL:    5 * time.Minute,
	JoinRate:    10,
	JoinBurst:   120,
	TrustProxy:  false,
	// Thirty days: long enough that a fortnightly meeting keeps its room, short
	// enough that a name nobody has used since is not still holding one.
	Rooms:     Rooms{OpenedBy: room.ByAnyone, Remember: 30 * 24 * time.Hour},
	SourceURL: "https://github.com/5t-RawBeRry/Tomoshibi",
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

	if meet.Rooms.Remember < 0 {
		return nil, fmt.Errorf(
			"rooms.remember: %s is not a length of time to keep a name for. Use zero to keep them for ever",
			meet.Rooms.Remember)
	}

	if !meet.Rooms.OpenedBy.Valid() {
		return nil, fmt.Errorf(
			"rooms.opened_by: %q is not who a room can be opened by. The two are %q and %q",
			meet.Rooms.OpenedBy, room.ByAnyone, room.ByAdmins)
	}

	if err := checkRole(&meet); err != nil {
		return nil, err
	}

	return &Config{Meet: meet, LiveKit: lk, Key: key, Secret: secret}, nil
}

// checkRole refuses a split that cannot work, at startup.
//
// Every one of these is a configuration that starts cleanly and then fails at
// the moment somebody tries to join — a control node with nowhere to send them,
// a relay policy nobody implements. The failure is far from the cause by then,
// and the person reading the logs is looking at a join that broke rather than
// at the file that broke it.
func checkRole(meet *Meet) error {
	if meet.Role == "" {
		meet.Role = RoleFull
	}

	if !meet.Role.Valid() {
		return fmt.Errorf(
			"meet.role: %q is not a role. The three are %q, %q and %q",
			meet.Role, RoleFull, RoleRelay, RoleControl)
	}

	if meet.RelayPolicy == "" {
		meet.RelayPolicy = PickSticky
	}

	switch meet.RelayPolicy {
	case PickSticky, PickNearest, PickRoundRobin, PickProbe:
	default:
		return fmt.Errorf(
			"meet.relay_policy: %q is not a way to choose a relay. The four are %q, %q, %q and %q",
			meet.RelayPolicy, PickSticky, PickNearest, PickRoundRobin, PickProbe)
	}

	switch meet.Role {
	case RoleControl:
		if len(meet.Relays) == 0 {
			return fmt.Errorf(
				"meet.role is %q, which starts no media server of its own, and no relays are "+
					"listed under `meet.relays` — every join would authorise somebody for a "+
					"meeting with nowhere to hold it", RoleControl)
		}

		seen := make(map[string]bool, len(meet.Relays))
		named := make(map[string]bool, len(meet.Relays))
		for i, relay := range meet.Relays {
			where := fmt.Sprintf("meet.relays[%d]", i)
			if relay.Name != "" {
				where = fmt.Sprintf("%s (%s)", where, relay.Name)
			}

			// A name is how a client refers to a relay it has measured, and how
			// an operator recognises one in a log. Required under probe because
			// the protocol turns on it; checked for collisions always, since two
			// relays answering to one name make both the client's choice and the
			// log ambiguous.
			if relay.Name == "" && meet.RelayPolicy == PickProbe {
				return fmt.Errorf(
					"meet.relay_policy is %q, where a client measures the relays and names the "+
						"one that answered fastest, but meet.relays[%d] has no name to send back",
					PickProbe, i)
			}

			if relay.Name != "" {
				if named[relay.Name] {
					return fmt.Errorf("%s: the name %q is used by another relay", where, relay.Name)
				}
				named[relay.Name] = true
			}

			if relay.URL == "" {
				return fmt.Errorf("%s has no url. A client is handed this verbatim, so it "+
					"needs the address a browser would dial, like wss://relay.example.com", where)
			}

			if !strings.HasPrefix(relay.URL, "ws://") && !strings.HasPrefix(relay.URL, "wss://") {
				return fmt.Errorf(
					"%s: %q is not a WebSocket address. It is dialled by a browser, so it "+
						"begins ws:// or wss://", where, relay.URL)
			}

			if seen[relay.URL] {
				return fmt.Errorf("%s: %q is listed twice", where, relay.URL)
			}
			seen[relay.URL] = true
		}

		if meet.RelayPolicy == PickNearest {
			for i, relay := range meet.Relays {
				if relay.Region == "" {
					return fmt.Errorf(
						"meet.relay_policy is %q, which chooses by region, but meet.relays[%d] "+
							"has none. A relay without one can never be the nearest and would "+
							"only ever be reached by the fallback", PickNearest, i)
				}
			}
		}

	case RoleRelay:
		if len(meet.Relays) > 0 {
			return fmt.Errorf(
				"meet.role is %q and `meet.relays` is set. A relay carries media; choosing "+
					"between relays is the control node's job, and listing them here would do "+
					"nothing", RoleRelay)
		}

		if len(meet.Admins) > 0 {
			return fmt.Errorf(
				"meet.role is %q and administrators are listed. A relay serves no management "+
					"pages, so these would grant nothing — put them on the control node", RoleRelay)
		}
	}

	return nil
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
