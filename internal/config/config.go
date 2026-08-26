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
	"crypto/tls"
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

	// Enrol lets a new relay bring itself up from a script.
	Enrol Enrol `yaml:"enrol"`

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

	// PublicAddresses are addresses this machine answers on that its interfaces
	// do not carry.
	//
	// Only a control node reads these, and only to recognise its own relay. It
	// reaches a relay by the name that relay publishes; where that relay is this
	// same machine, the name resolves to a public address which NAT maps rather
	// than assigns — so reading the interfaces finds the private address and
	// misses the one being dialled. The connection then goes out to the network
	// and, on most hosts, never comes back: not refused, just waiting.
	//
	// Measured on the deployment that prompted this: twelve seconds per
	// management call, and a 502 on the busiest page because the proxy in front
	// gave up first. Declaring the address here makes it eleven milliseconds.
	PublicAddresses []string `yaml:"public_addresses"`

	// Silent answers nothing but a WebSocket upgrade.
	//
	// For a relay on a network that decides what a machine is by asking it.
	// Mainland Chinese hosts are probed with an ordinary HTTPS request, and any
	// answer — 204, 401, even 404 — identifies the port as a website, which an
	// unregistered domain is not allowed to be. A WebSocket endpoint owes no
	// answer to a request that is not an upgrade, so under this it gives none:
	// the connection is closed without a status line.
	//
	// The cost is the health endpoint, which a control node's page and a
	// client's own measurement both use. A relay elsewhere should leave this
	// off and stay readable.
	Silent bool `yaml:"silent"`

	// ProbePort answers STUN binding requests, so a browser can time one round
	// trip over the transport a call uses.
	//
	// The picker's other measurement opens the signalling socket, which is TCP:
	// a handshake, a TLS handshake and an HTTP upgrade, so about three round
	// trips. It ranks relays correctly and reads as three times too slow, and a
	// number nobody believes is a number nobody uses.
	//
	// Zero is off. Deliberately not 3478: the standard STUN port is scanned
	// continuously and answering on it is an invitation, so every deployment
	// should pick something unremarkable.
	ProbePort int `yaml:"probe_port"`

	// TLSCert and TLSKey serve this listener over TLS directly, without a proxy
	// in front.
	//
	// Present because a relay usually has no proxy to put there and often
	// cannot get one. Browsers refuse a plaintext WebSocket from a page loaded
	// over HTTPS, so a relay dialled from a real deployment has to be wss —
	// and the machines that make the best relays are frequently the ones where
	// installing anything is hardest: a package mirror that will not answer, a
	// port 80 the network never delivers, a host that cannot be issued a
	// certificate locally at all.
	//
	// A certificate copied in from elsewhere, served by the one binary that was
	// already going to be copied in, removes all of that. A deployment that does
	// have a proxy leaves both empty and nothing changes.
	TLSCert string `yaml:"tls_cert"`
	TLSKey  string `yaml:"tls_key"`

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

// Enrol is what a machine running the install script is told.
//
// Off unless a secret is set. What an enrolment hands over is the credential
// every relay signs with, the redis password and a private key, so a deployment
// that has not said it wants this does not get an endpoint that gives them away.
type Enrol struct {
	// Secret is what the install script proves it has. Long-lived, because the
	// script is meant to be kept and pasted into whatever machine comes next —
	// which makes the script itself a credential.
	Secret string `yaml:"secret"`

	// Domain is what a prefix is added to: `tokyo` under `relay.example.com`
	// becomes `tokyo.relay.example.com`.
	//
	// ⚠ It must not be a name that already carries a CNAME. A CNAME shadows
	// every name beneath it, so records created under one are never answered —
	// the zone shows them and the world does not.
	Domain string `yaml:"domain"`

	// PublicURL is where a new machine fetches the binary and claims its
	// configuration: this deployment as the outside reaches it.
	PublicURL string `yaml:"public_url"`

	// Ports every relay in this deployment listens on. Sent to each new machine
	// so they agree without anybody having to remember.
	ListenPort int `yaml:"listen_port"`
	UDPPort    int `yaml:"udp_port"`
	TCPPort    int `yaml:"tcp_port"`

	// ProbePort is written into every new relay's configuration, and is the
	// reason the picker can show a number anybody believes.
	//
	// It was not, and the effect was quiet: the enrolment wrote no probe port,
	// zero is off, so every machine brought up by the script answered no STUN
	// and was timed over the signalling socket instead — three round trips
	// against one. A relay given a probe port by hand afterwards then won the
	// ranking against nearer machines on nothing but the measurement it had
	// been allowed. That comparison is fixed in the client, which now measures
	// the whole list one way; this is what makes the fast way available at all.
	//
	// Zero is off, and the same reasoning as the field it becomes applies: not
	// 3478, which is scanned continuously.
	ProbePort int `yaml:"probe_port"`

	// CertFile and KeyFile are the certificate handed to a new relay. Empty
	// takes the listener's own, which is what a control node serving TLS
	// directly already holds.
	CertFile string `yaml:"cert_file"`
	KeyFile  string `yaml:"key_file"`

	// RedisAddr is how a *relay* reaches redis, which is not how this node
	// does.
	//
	// A control node running redis beside it says 127.0.0.1, and sending that
	// to another machine points it at its own loopback — where there is nothing,
	// so the relay fails to start with an error about redis that names an
	// address it was never meant to try. Empty falls back to this node's own,
	// which is right only when redis is somewhere else entirely.
	RedisAddr string `yaml:"redis_addr"`

	// Binary is the file served to a new relay. The control node hands out the
	// build it is running, so a fleet cannot drift apart by version.
	Binary string `yaml:"binary"`

	// Cloudflare creates each relay's DNS record. Optional: without it a relay
	// still enrols and whoever ran the script points the name themselves.
	CloudflareToken string `yaml:"cloudflare_token"`
	CloudflareZone  string `yaml:"cloudflare_zone"`
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
	Rooms: Rooms{OpenedBy: room.ByAnyone, Remember: 30 * 24 * time.Hour},
	Enrol: Enrol{ListenPort: 13377, UDPPort: 13378, TCPPort: 13379},
	// Empty rather than a repository somebody else runs.
	//
	// Section 13 is the reason this field exists: whoever offers this over a
	// network owes its source to the people using it that way, and the join page
	// carries a link to satisfy that. A default pointing at the upstream project
	// makes that link an offer of code the deployment is not running, which is
	// worse than no link -- it looks like compliance and is not, and nobody
	// reading their own page would notice, because the link works.
	//
	// Empty, the startup check says so and the page says the source has not been
	// named. A deployment that has not been told where its code is cannot be
	// made to answer that question correctly by guessing.
	SourceURL: "",
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
			// All three, because there are three. This listed two and left out
			// the middle one, so somebody who mistyped "signed" was told by the
			// error message that the setting they wanted does not exist.
			"rooms.opened_by: %q is not who a room can be opened by. The three are %q, %q and %q",
			meet.Rooms.OpenedBy, room.ByAnyone, room.BySigned, room.ByAdmins)
	}

	if err := checkRole(&meet); err != nil {
		return nil, err
	}

	if err := checkTLS(&meet); err != nil {
		return nil, err
	}

	return &Config{Meet: meet, LiveKit: lk, Key: key, Secret: secret}, nil
}

// checkTLS refuses a certificate that cannot be served, at startup.
//
// Every failure here is one that would otherwise appear as a listener that
// never came up, or worse, one that came up plaintext on a deployment that
// believed it was encrypted — and the browser refusing to connect is a long way
// from the file that was misspelled.
func checkTLS(meet *Meet) error {
	switch {
	case meet.TLSCert == "" && meet.TLSKey == "":
		return nil

	case meet.TLSCert == "":
		return fmt.Errorf("meet.tls_key is set and meet.tls_cert is not; both are needed to " +
			"serve TLS, and neither alone does anything")

	case meet.TLSKey == "":
		return fmt.Errorf("meet.tls_cert is set and meet.tls_key is not; both are needed to " +
			"serve TLS, and neither alone does anything")
	}

	// Loaded rather than merely stat'd, so that a certificate which does not
	// match its key, or a file holding something other than a certificate, is a
	// message here rather than a listener that fails to start later.
	if _, err := tls.LoadX509KeyPair(meet.TLSCert, meet.TLSKey); err != nil {
		return fmt.Errorf("meet.tls_cert and meet.tls_key: %w", err)
	}

	return nil
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
	return NamedAdministrator(admins, "", passphrase, tripKey)
}

// NamedAdministrator is the same question with a name attached.
//
// The management sign-in asks for both, and it asks for a reason: a passphrase
// alone is a single secret that anybody may guess at, and every guess is checked
// against every administrator at once. A list of leaked passphrases run at this
// endpoint would find a match if any one person on the deployment had reused
// one. Requiring the name means a guess has to be aimed at somebody, which turns
// one pool into as many separate ones as there are administrators.
//
// The room join is the other caller and passes no name, because there is nobody
// to name: somebody opening a room proves they hold an administrator's
// passphrase and nothing more is asked of them.
//
// An administrator with no name recorded is matched by passphrase alone, as
// before. Refusing them would lock out any deployment upgrading into this, and
// the fix is to give them a name — which the management pages now do.
func NamedAdministrator(
	admins []Admin,
	name string,
	passphrase room.Passphrase,
	tripKey []byte,
) (Admin, bool) {
	if passphrase.Empty() {
		return Admin{}, false
	}

	trip := []byte(room.Trip(tripKey, strings.TrimSpace(string(passphrase))))
	wanted := strings.ToLower(strings.TrimSpace(name))

	var found Admin
	matched := false

	for _, admin := range admins {
		// Compared in full rather than skipped early, so that the work done is
		// the same whether or not a name was right. A loop that returned as soon
		// as the name missed would answer faster for a name nobody has, which is
		// a way to enumerate who does.
		right := subtle.ConstantTimeCompare([]byte(admin.Trip), trip)

		named := 1
		if wanted != "" && admin.Name != "" {
			named = subtle.ConstantTimeCompare(
				[]byte(strings.ToLower(strings.TrimSpace(admin.Name))),
				[]byte(wanted),
			)
		}

		if right == 1 && named == 1 {
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

// Cert and Key are the certificate handed to a new relay.
//
// The listener's own by default. A control node serving TLS directly already
// holds exactly the pair every relay needs, and naming it twice is one more
// place for the two to drift apart.
func (e Enrol) Cert(fallback string) string {
	if e.CertFile != "" {
		return e.CertFile
	}
	return fallback
}

func (e Enrol) Key(fallback string) string {
	if e.KeyFile != "" {
		return e.KeyFile
	}
	return fallback
}
