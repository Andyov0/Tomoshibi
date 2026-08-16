package admin

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"tomoshibi/internal/config"
	"tomoshibi/internal/room"
	"tomoshibi/internal/store"
)

/*
This endpoint exchanges a string for the credential every relay in the
deployment signs with, the redis password, and a private key. It is the most
valuable thing this server will hand to an unauthenticated caller, and the only
thing in front of it is one comparison.

So what is tested here is mostly refusal: a wrong secret, an empty one, a prefix
that would become something other than a DNS label, an address that is not one.
Each of those is a way somebody could arrive at the credentials, and each has to
end in the same place.

The rest is the property the automation exists for — that a machine which runs
the script is, afterwards, a relay this deployment knows about and points a name
at.
*/

// relayList is a store of relays somebody wrote down.
type relayList struct {
	mu     sync.Mutex
	relays []store.Relay
}

func (r *relayList) Relays() ([]store.Relay, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]store.Relay(nil), r.relays...), nil
}

func (r *relayList) AddRelay(relay store.Relay) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	for _, existing := range r.relays {
		if existing.Name == relay.Name {
			return store.ErrRelayExists
		}
	}

	r.relays = append(r.relays, relay)
	return nil
}

func (r *relayList) UpdateRelay(relay store.Relay) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	for i := range r.relays {
		if r.relays[i].Name == relay.Name {
			r.relays[i] = relay
			return nil
		}
	}

	return store.ErrNoSuchRelay
}

func (r *relayList) RemoveRelay(name string) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	for i := range r.relays {
		if r.relays[i].Name == name {
			r.relays = append(r.relays[:i], r.relays[i+1:]...)
			return nil
		}
	}

	return store.ErrNoSuchRelay
}

// ReorderRelays puts them in the order given, so that a caller which claims to
// have reordered can be checked rather than believed.
func (r *relayList) ReorderRelays(names []string) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	at := make(map[string]int, len(names))
	for position, name := range names {
		at[name] = position + 1
	}

	for i := range r.relays {
		if position, ok := at[r.relays[i].Name]; ok {
			r.relays[i].Order = position
		}
	}

	return nil
}

// RenameRelay moves one, so that a test can check a rename happened rather than
// take a caller's word for it.
func (r *relayList) RenameRelay(from, to string) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	for i := range r.relays {
		if r.relays[i].Name == from {
			r.relays[i].Name = to
			return nil
		}
	}

	return store.ErrNoSuchRelay
}

// naming records what it was asked to point where.
type naming struct {
	mu      sync.Mutex
	pointed map[string]string
	fail    error
}

func (n *naming) Point(host, addr string) error {
	n.mu.Lock()
	defer n.mu.Unlock()

	if n.fail != nil {
		return n.fail
	}

	if n.pointed == nil {
		n.pointed = map[string]string{}
	}
	n.pointed[host] = addr

	return nil
}

func (n *naming) Unpoint(host string) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	delete(n.pointed, host)
	return nil
}

const enrolSecret = "a secret that lives in the install script"

func enrolling(t *testing.T) (*API, *relayList, *naming, http.Handler) {
	t.Helper()

	dir := t.TempDir()
	certPath := filepath.Join(dir, "cert.pem")
	keyPath := filepath.Join(dir, "key.pem")

	if err := os.WriteFile(certPath, []byte("-----BEGIN CERTIFICATE-----\nnot really\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyPath, []byte("-----BEGIN EC PRIVATE KEY-----\nnot really\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	key := make([]byte, 32)

	conf := &config.Config{
		Key:    "APIkey",
		Secret: "the deployment secret nobody unauthenticated should see",
		Meet: config.Meet{
			Role:      config.RoleControl,
			JoinRate:  1000,
			JoinBurst: 1000,
			Admins:    []config.Admin{{Trip: room.Trip(key, "a passphrase"), Name: "adam"}},
		},
	}

	api := New(conf, nil, nil, key)
	t.Cleanup(api.Close)

	relays := &relayList{}
	api.relays = relays

	names := &naming{}

	api.UseEnrolment(&Enrolment{
		Secret: enrolSecret, Domain: "relay.example.invalid",
		PublicURL: "https://meet.example.invalid",
		RedisAddr: "redis.invalid:6379", RedisPassword: "redis password",
		CertPath: certPath, KeyPath: keyPath,
		ListenPort: 13377, UDPPort: 13378, TCPPort: 13379,
		Naming: names,
	})

	mux := http.NewServeMux()
	api.MountEnrolment(mux)

	return api, relays, names, mux
}

func enrolRequest(body string) *http.Request {
	request := httptest.NewRequest(http.MethodPost, "/api/enrol", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.RemoteAddr = "203.0.113.7:5555"

	return request
}

func TestAMachineWithTheSecretIsEnrolled(t *testing.T) {
	_, relays, names, mux := enrolling(t)

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, enrolRequest(
		`{"secret":"`+enrolSecret+`","prefix":"tokyo","region":"jp","address":"198.51.100.9"}`))

	if recorder.Code != http.StatusOK {
		t.Fatalf("enrolment answered %d: %s", recorder.Code, recorder.Body)
	}

	var got enrolPackage
	if err := json.Unmarshal(recorder.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}

	if got.Host != "tokyo.relay.example.invalid" {
		t.Errorf("host came back as %q", got.Host)
	}

	if got.URL != "wss://tokyo.relay.example.invalid:13377" {
		t.Errorf("url came back as %q; a relay must be dialled over wss on the deployment's port",
			got.URL)
	}

	if got.APISecret == "" || got.RedisAddr == "" || got.Cert == "" || got.Key == "" {
		t.Error("the package is missing something a relay cannot start without")
	}

	if !got.Named {
		t.Error("the package says no name was created, and one was")
	}

	if names.pointed["tokyo.relay.example.invalid"] != "198.51.100.9" {
		t.Errorf("the name was pointed at %q", names.pointed["tokyo.relay.example.invalid"])
	}

	// The whole point of the automation: afterwards, this deployment knows
	// about the relay without anybody adding it.
	list, _ := relays.Relays()
	if len(list) != 1 || list[0].Name != "tokyo" || !list[0].Enabled {
		t.Errorf("the relay list is %+v; the machine should be in it and taking calls", list)
	}
}

// The trust boundary, and the only thing in front of the deployment's secret.
func TestAWrongSecretGetsNothing(t *testing.T) {
	_, relays, names, mux := enrolling(t)

	for _, secret := range []string{
		"",
		"wrong",
		enrolSecret + "x",
		strings.ToUpper(enrolSecret),
		enrolSecret[:len(enrolSecret)-1],
	} {
		recorder := httptest.NewRecorder()
		body, _ := json.Marshal(map[string]string{
			"secret": secret, "prefix": "tokyo", "address": "198.51.100.9",
		})
		mux.ServeHTTP(recorder, enrolRequest(string(body)))

		if recorder.Code != http.StatusForbidden {
			t.Errorf("secret %q answered %d, wanted 403", secret, recorder.Code)
		}

		if strings.Contains(recorder.Body.String(), "the deployment secret") {
			t.Fatalf("secret %q was refused and the answer carried the credentials anyway", secret)
		}
	}

	if list, _ := relays.Relays(); len(list) != 0 {
		t.Errorf("a refused machine was added to the relay list: %+v", list)
	}

	if len(names.pointed) != 0 {
		t.Errorf("a refused machine had a name pointed at it: %v", names.pointed)
	}
}

// A prefix becomes a name in a zone this deployment controls. Anything that is
// not a label has to be refused before it gets there.
func TestAPrefixThatIsNotALabelIsRefused(t *testing.T) {
	_, _, names, mux := enrolling(t)

	for _, prefix := range []string{
		"", "-leading", "trailing-", "has space", "has.dot", "under_score",
		"UPPER!", "*", "../escape", strings.Repeat("x", 64),
	} {
		recorder := httptest.NewRecorder()
		body, _ := json.Marshal(map[string]string{
			"secret": enrolSecret, "prefix": prefix, "address": "198.51.100.9",
		})
		mux.ServeHTTP(recorder, enrolRequest(string(body)))

		// The specific code, not merely "not 200": a route that does not exist
		// also answers something other than 200, and an earlier version of this
		// test passed against a 404 while the guard it names was never reached.
		if recorder.Code != http.StatusBadRequest {
			t.Errorf("prefix %q answered %d, wanted 400", prefix, recorder.Code)
		}
	}

	if len(names.pointed) != 0 {
		t.Errorf("a refused prefix reached the zone: %v", names.pointed)
	}
}

func TestAnAddressThatIsNotOneIsRefused(t *testing.T) {
	_, _, _, mux := enrolling(t)

	for _, address := range []string{"not-an-ip", "example.com", "999.1.1.1", "1.1.1.1;rm -rf /"} {
		recorder := httptest.NewRecorder()
		body, _ := json.Marshal(map[string]string{
			"secret": enrolSecret, "prefix": "tokyo", "address": address,
		})
		mux.ServeHTTP(recorder, enrolRequest(string(body)))

		if recorder.Code != http.StatusBadRequest {
			t.Errorf("address %q answered %d, wanted 400", address, recorder.Code)
		}
	}
}

// A machine that does not name its own address is pointed at the one the
// request came from, which is what a machine behind NAT needs.
func TestTheCallersAddressIsUsedWhenNoneIsGiven(t *testing.T) {
	_, _, names, mux := enrolling(t)

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, enrolRequest(
		`{"secret":"`+enrolSecret+`","prefix":"tokyo"}`))

	if recorder.Code != http.StatusOK {
		t.Fatalf("answered %d: %s", recorder.Code, recorder.Body)
	}

	if got := names.pointed["tokyo.relay.example.invalid"]; got != "203.0.113.7" {
		t.Errorf("the name was pointed at %q, wanted the address the request came from", got)
	}
}

// A prefix already in use is refused, and nothing is touched.
//
// The dangerous case is the typo rather than the deliberate rebuild. Two
// machines given one prefix means the name points at the second while the first
// goes on holding calls at an address that no longer reaches it — and nothing
// anywhere says so. This used to update silently.
func TestATakenPrefixIsRefusedAndChangesNothing(t *testing.T) {
	_, relays, names, mux := enrolling(t)

	first := httptest.NewRecorder()
	mux.ServeHTTP(first, enrolRequest(
		`{"secret":"`+enrolSecret+`","prefix":"tokyo","address":"198.51.100.9"}`))

	if first.Code != http.StatusOK {
		t.Fatalf("first enrolment answered %d", first.Code)
	}

	second := httptest.NewRecorder()
	mux.ServeHTTP(second, enrolRequest(
		`{"secret":"`+enrolSecret+`","prefix":"tokyo","address":"198.51.100.10"}`))

	if second.Code != http.StatusConflict {
		t.Fatalf("a second machine took the prefix %q and answered %d, wanted 409",
			"tokyo", second.Code)
	}

	// And crucially: the name still points where it did. An earlier version
	// created the record before checking, so the refusal was honest and the
	// existing relay had already been unreachable by then.
	if got := names.pointed["tokyo.relay.example.invalid"]; got != "198.51.100.9" {
		t.Errorf("the name moved to %q on a refused enrolment; the relay holding calls "+
			"there is now at an address nobody resolves", got)
	}

	list, _ := relays.Relays()
	if len(list) != 1 || list[0].URL != "wss://tokyo.relay.example.invalid:13377" {
		t.Errorf("the relay list changed on a refused enrolment: %+v", list)
	}
}

// Saying so takes it over, which is what a rebuilt machine needs.
func TestReplacingATakenPrefixIsAllowedWhenAsked(t *testing.T) {
	_, relays, names, mux := enrolling(t)

	first := httptest.NewRecorder()
	mux.ServeHTTP(first, enrolRequest(
		`{"secret":"`+enrolSecret+`","prefix":"tokyo","address":"198.51.100.9"}`))

	if first.Code != http.StatusOK {
		t.Fatalf("first enrolment answered %d", first.Code)
	}

	second := httptest.NewRecorder()
	mux.ServeHTTP(second, enrolRequest(
		`{"secret":"`+enrolSecret+`","prefix":"tokyo","address":"198.51.100.10","replace":true}`))

	if second.Code != http.StatusOK {
		t.Fatalf("an asked-for replacement answered %d: %s", second.Code, second.Body)
	}

	if list, _ := relays.Relays(); len(list) != 1 {
		t.Errorf("replacing produced %d relays, wanted 1", len(list))
	}

	if got := names.pointed["tokyo.relay.example.invalid"]; got != "198.51.100.10" {
		t.Errorf("the name still points at %q after the machine was replaced", got)
	}
}

// DNS failing must not fail the install. Everything else about the relay is
// correct and a name added by hand finishes it, which is a better end than
// refusing work that has already been done.
func TestAFailedNamingStillEnrols(t *testing.T) {
	_, relays, names, mux := enrolling(t)
	names.fail = errAsIf("cloudflare refused")

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, enrolRequest(
		`{"secret":"`+enrolSecret+`","prefix":"tokyo","address":"198.51.100.9"}`))

	if recorder.Code != http.StatusOK {
		t.Fatalf("a naming failure refused the whole enrolment: %d %s", recorder.Code, recorder.Body)
	}

	var got enrolPackage
	_ = json.Unmarshal(recorder.Body.Bytes(), &got)

	if got.Named {
		t.Error("the package claims a name was created and none was; the script would not " +
			"tell anybody to point it")
	}

	if list, _ := relays.Relays(); len(list) != 1 {
		t.Error("the relay was not recorded")
	}
}

type errAsIf string

func (e errAsIf) Error() string { return string(e) }

// The script carries the secret, so it is not a public document.
func TestTheScriptIsNotServedWithoutASession(t *testing.T) {
	api, _, _, _ := enrolling(t)

	mux := http.NewServeMux()
	api.Mount(mux)

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/admin/relays/script", nil))

	if recorder.Code == http.StatusOK {
		t.Fatal("the install script was served to a caller with no session, and it carries " +
			"the enrolment secret")
	}

	if strings.Contains(recorder.Body.String(), enrolSecret) {
		t.Fatal("the refusal carried the secret")
	}
}
