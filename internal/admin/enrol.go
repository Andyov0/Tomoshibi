package admin

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strings"

	"tomoshibi/internal/store"
)

/*
Bringing a relay up by hand is five things that must agree: the binary, the
deployment's credentials, the redis address, the certificate, and a DNS name
pointing at the machine. Getting any one wrong produces a relay that starts
cleanly and fails in a way that looks like something else — the wrong secret
answers 401 to every join, no redis makes an island whose calls cannot hear the
others, and a name that does not resolve is refused by browsers with nothing in
the relay's own log to say why.

So all five are done by the machine itself, from a script, against the control
node that already holds every one of them. What somebody types is a prefix.

The secret in that script is the whole of the security here, and what it buys is
the credential every relay signs with. The script is therefore not a public
document: it is fetched from the management pages by somebody signed in, and
anybody holding a copy can enrol a relay into this deployment. That trade is
made deliberately — the alternative is a per-machine token that has to be
minted, carried, and pasted inside its lifetime, which is the ceremony this
exists to remove.
*/

// Naming is where a relay's DNS record goes.
//
// Created by the control node rather than by hand, because a relay whose name
// does not resolve is indistinguishable from the outside from one that is down,
// and the machine cannot create the record itself without holding credentials
// to the whole zone.
type Naming interface {
	Point(host, addr string) error
	Unpoint(host string) error
}

// Enrolment is what a control node tells a new relay.
type Enrolment struct {
	// Secret is what the install script proves it has. Long-lived, because the
	// script is meant to be kept and pasted into whatever machine comes next.
	Secret string

	// Domain is the zone relays are named under: a prefix of `tokyo` under
	// `relay.shota.sg` makes `tokyo.relay.shota.sg`.
	Domain string

	// PublicURL is where a new machine fetches from.
	PublicURL string

	RedisAddr     string
	RedisPassword string

	CertPath string
	KeyPath  string

	ListenPort int
	UDPPort    int
	TCPPort    int

	// Naming creates the DNS record. Optional: without it a relay still enrols
	// and whoever ran the script is told to point the name themselves.
	Naming Naming
}

// Configured reports whether a relay can be brought up from a script.
func (e *Enrolment) Configured() bool {
	return e != nil && e.Secret != "" && e.Domain != ""
}

func (e *Enrolment) hostFor(prefix string) string {
	return prefix + "." + strings.Trim(e.Domain, ".")
}

// validPrefix says whether a prefix can be a DNS label.
//
// Checked rather than trusted: it becomes a name in a zone this deployment
// controls, sent by a machine somebody is in the middle of setting up. A typo
// should be a sentence rather than a record to be found and removed later.
func validPrefix(prefix string) bool {
	if len(prefix) == 0 || len(prefix) > 63 {
		return false
	}

	if prefix[0] == '-' || prefix[len(prefix)-1] == '-' {
		return false
	}

	for _, r := range prefix {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '-':
		default:
			return false
		}
	}

	return true
}

// enrolPackage is what a relay is handed once it has proved the secret.
type enrolPackage struct {
	Name   string `json:"name"`
	Host   string `json:"host"`
	URL    string `json:"url"`
	Region string `json:"region,omitempty"`

	APIKey    string `json:"apiKey"`
	APISecret string `json:"apiSecret"`

	RedisAddr     string `json:"redisAddr"`
	RedisPassword string `json:"redisPassword,omitempty"`

	Cert string `json:"cert"`
	Key  string `json:"key"`

	ListenPort int `json:"listenPort"`
	UDPPort    int `json:"udpPort"`
	TCPPort    int `json:"tcpPort"`

	// Named says whether the control node created the DNS record. False means
	// the machine is otherwise ready and somebody has to point the name.
	Named bool `json:"named"`
}

// claim is what the install script calls.
//
// Authenticated by the secret rather than by a session: the machine running
// this has no administrator sitting at it. Rate limited by the same limiter the
// sign-in page uses, because an endpoint exchanging a string for the
// deployment's credentials is worth guessing at.
func (a *API) claim(w http.ResponseWriter, r *http.Request) {
	if !a.enrolment.Configured() || a.relays == nil {
		refuse(w, http.StatusServiceUnavailable, "no_enrolment")
		return
	}

	caller := addressOf(r, a.conf.Meet.TrustProxy)
	if !a.sessions.limit.Allow(caller) {
		refuse(w, http.StatusTooManyRequests, "too_many_attempts")
		return
	}

	var body struct {
		Secret  string `json:"secret"`
		Prefix  string `json:"prefix"`
		Region  string `json:"region"`
		Address string `json:"address"`
		// Replace says this prefix is meant to be taken over.
		//
		// Off by default, which is the change that matters: a prefix somebody
		// typed twice by accident used to quietly move an existing relay's
		// address to the new machine, and the relay it belonged to went on
		// holding calls at a name that no longer pointed at it. Nothing said
		// so. Now it is refused and the script asks for another.
		Replace bool `json:"replace"`
	}

	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&body); err != nil {
		refuse(w, http.StatusBadRequest, "unreadable")
		return
	}

	// Constant time: this is the one comparison standing between a stranger and
	// the credential every relay in this deployment signs with.
	if subtle.ConstantTimeCompare([]byte(body.Secret), []byte(a.enrolment.Secret)) != 1 {
		a.log.Record(Entry{
			Action: "enrol", Trip: "-", Target: body.Prefix,
			Failed: true, Reason: "wrong secret",
		})
		refuse(w, http.StatusForbidden, "wrong_secret")
		return
	}

	prefix := strings.ToLower(strings.TrimSpace(body.Prefix))
	if !validPrefix(prefix) {
		refuse(w, http.StatusBadRequest, "bad_prefix")
		return
	}

	// The address the machine names, and otherwise the one this request came
	// from. A machine behind NAT knows its public address and this server sees
	// it; on a machine with several, the one it names is the one it means.
	address := strings.TrimSpace(body.Address)
	if address == "" {
		address = callerIP(caller)
	}

	if net.ParseIP(address) == nil {
		refuse(w, http.StatusBadRequest, "bad_address")
		return
	}

	host := a.enrolment.hostFor(prefix)

	relay := store.Relay{
		Name:    prefix,
		Region:  strings.TrimSpace(body.Region),
		URL:     fmt.Sprintf("wss://%s:%d", host, a.enrolment.ListenPort),
		Enabled: true,
	}

	if err := relay.Valid(); err != nil {
		refuse(w, http.StatusBadRequest, relayReason(err))
		return
	}

	cert, err := os.ReadFile(a.enrolment.CertPath)
	if err != nil {
		slog.Error("failed to read the certificate for an enrolment", "error", err)
		refuse(w, http.StatusInternalServerError, "no_certificate")
		return
	}

	key, err := os.ReadFile(a.enrolment.KeyPath)
	if err != nil {
		slog.Error("failed to read the certificate key for an enrolment", "error", err)
		refuse(w, http.StatusInternalServerError, "no_certificate")
		return
	}

	// Whether this prefix is taken, checked before anything is changed. The DNS
	// record used to be created first, so a prefix that was then refused had
	// already had the name moved to the new machine — the refusal was honest
	// and the damage was done.
	if taken, err := a.prefixTaken(relay.Name); err == nil && taken && !body.Replace {
		a.log.Record(Entry{
			Action: "enrol", Trip: "-", Target: relay.Name,
			Failed: true, Reason: "prefix already in use",
		})
		refuse(w, http.StatusConflict, "relay_exists")
		return
	}

	named := false
	if a.enrolment.Naming != nil {
		if err := a.enrolment.Naming.Point(host, address); err != nil {
			// Not fatal. Everything else about this relay is correct, and a
			// name added by hand finishes it — a better end than refusing an
			// install that has already done the work.
			slog.Error("failed to create the DNS record for a relay",
				"host", host, "address", address, "error", err)
		} else {
			named = true
			slog.Info("pointed a relay's name at it", "host", host, "address", address)
		}
	}

	// A prefix already in use is refused unless somebody said to take it over.
	//
	// The dangerous case is not the deliberate rebuild — it is the typo. Two
	// machines given one prefix means the name points at the second while the
	// first goes on holding calls at an address that no longer reaches it, and
	// nothing anywhere says so. Refusing costs a rebuild one extra word and
	// costs a typo nothing at all.
	if err := a.relays.AddRelay(relay); errors.Is(err, store.ErrRelayExists) {
		if !body.Replace {
			a.log.Record(Entry{
				Action: "enrol", Trip: "-", Target: relay.Name,
				Failed: true, Reason: "prefix already in use",
			})
			refuse(w, http.StatusConflict, "relay_exists")
			return
		}

		if err := a.relays.UpdateRelay(relay); err != nil {
			refuse(w, http.StatusInternalServerError, relayReason(err))
			return
		}

		slog.Info("a relay took over a prefix already in use", "name", relay.Name)
	} else if err != nil {
		refuse(w, http.StatusInternalServerError, relayReason(err))
		return
	}

	a.changed()
	a.log.Record(Entry{Action: "enrol", Trip: "-", Target: relay.Name})

	respond(w, enrolPackage{
		Name: relay.Name, Host: host, URL: relay.URL, Region: relay.Region,
		APIKey: a.conf.Key, APISecret: a.conf.Secret,
		RedisAddr: a.enrolment.RedisAddr, RedisPassword: a.enrolment.RedisPassword,
		Cert: string(cert), Key: string(key),
		ListenPort: a.enrolment.ListenPort,
		UDPPort:    a.enrolment.UDPPort,
		TCPPort:    a.enrolment.TCPPort,
		Named:      named,
	})
}

// callerIP strips the port an address may carry.
func callerIP(caller string) string {
	if host, _, err := net.SplitHostPort(caller); err == nil {
		return host
	}
	return caller
}

// installScript is what somebody pastes into a new machine.
//
// Served to a signed-in administrator rather than publicly, because it carries
// the enrolment secret. What it does is deliberately readable: anybody about to
// run something as root should be able to see all of it, and every step is one
// they would otherwise be doing by hand.
func (a *API) installScript(_ Session, w http.ResponseWriter, _ *http.Request) {
	if !a.enrolment.Configured() {
		refuse(w, http.StatusServiceUnavailable, "no_enrolment")
		return
	}

	w.Header().Set("Content-Disposition", `attachment; filename="add-relay.sh"`)

	a.writeInstall(w, a.enrolment.Secret)
}

// installCommand is the one line somebody types on the new machine.
//
// The script is still there to be read — anything about to run as root should
// be readable first, and it is what the download beside this serves. What this
// gives is the shape that gets used: one command, copied, pasted, done. Moving
// a file onto a machine that has no keys on it yet is the step this whole path
// exists to remove, and leaving it as the only option left it half removed.
//
// Behind a session, because the command carries the enrolment secret.
func (a *API) installCommand(_ Session, w http.ResponseWriter, _ *http.Request) {
	if !a.enrolment.Configured() {
		refuse(w, http.StatusServiceUnavailable, "no_enrolment")
		return
	}

	control := strings.TrimRight(a.enrolment.PublicURL, "/")

	respond(w, map[string]any{
		"command": fmt.Sprintf("bash <(curl -fLSs %s/install) <prefix> %s", control, a.enrolment.Secret),
		"domain":  a.enrolment.Domain,
		"port":    a.enrolment.ListenPort,
	})
}

// PublicInstall serves the same script to anybody, without the secret in it.
//
// So that bringing a relay up is one command copied onto a fresh machine rather
// than a file moved onto it by hand. The secret is not in what is served and not
// in the address either — it travels in the operator's own command, as ENROL, so
// that no proxy log, no CDN, and no shell history on a machine that has not been
// enrolled yet ever holds it.
//
// Public on purpose. What is served is a shell script with this deployment's
// address and ports in it, which is not a secret: the addresses are handed to
// every client that joins, and without the enrolment secret the script can do
// nothing but ask and be refused.
func (a *API) PublicInstall(w http.ResponseWriter, _ *http.Request) {
	if a.enrolment == nil || !a.enrolment.Configured() {
		refuse(w, http.StatusServiceUnavailable, "no_enrolment")
		return
	}

	a.writeInstall(w, "")
}

func (a *API) writeInstall(w http.ResponseWriter, secret string) {
	w.Header().Set("Content-Type", "text/x-shellscript; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")

	fmt.Fprintf(w, installTemplate,
		strings.TrimRight(a.enrolment.PublicURL, "/"),
		a.enrolment.Domain,
		secret,
		a.enrolment.ListenPort, a.enrolment.UDPPort, a.enrolment.TCPPort)
}

// prefixTaken says whether a relay already answers to this name.
func (a *API) prefixTaken(name string) (bool, error) {
	list, err := a.relays.Relays()
	if err != nil {
		return false, err
	}

	for _, relay := range list {
		if relay.Name == name {
			return true, nil
		}
	}

	return false, nil
}

// taken answers whether a prefix is free, for a script about to ask somebody to
// type one.
//
// Behind the enrolment secret, because the list of relay names is not something
// to hand to whoever asks — and whoever holds the secret can read the whole list
// by enrolling anyway.
func (a *API) taken(w http.ResponseWriter, r *http.Request) {
	if !a.enrolment.Configured() || a.relays == nil {
		refuse(w, http.StatusServiceUnavailable, "no_enrolment")
		return
	}

	caller := addressOf(r, a.conf.Meet.TrustProxy)
	if !a.sessions.limit.Allow(caller) {
		refuse(w, http.StatusTooManyRequests, "too_many_attempts")
		return
	}

	var body struct {
		Secret string `json:"secret"`
		Prefix string `json:"prefix"`
	}

	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
		refuse(w, http.StatusBadRequest, "unreadable")
		return
	}

	if subtle.ConstantTimeCompare([]byte(body.Secret), []byte(a.enrolment.Secret)) != 1 {
		refuse(w, http.StatusForbidden, "wrong_secret")
		return
	}

	prefix := strings.ToLower(strings.TrimSpace(body.Prefix))
	if !validPrefix(prefix) {
		refuse(w, http.StatusBadRequest, "bad_prefix")
		return
	}

	held, err := a.prefixTaken(prefix)
	if err != nil {
		refuse(w, http.StatusInternalServerError, "store_unavailable")
		return
	}

	respond(w, map[string]any{"prefix": prefix, "taken": held})
}
