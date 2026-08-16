package admin

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"sync"
	"tomoshibi/internal/config"
	"tomoshibi/internal/room"
	"tomoshibi/internal/store"
)

// roster hands a fixed list to a Sessions that reads a live one.
//
// The list is read on every sign-in now, so that somebody added on a page can
// sign in without a restart and somebody removed cannot sign in again. These
// tests are about who is recognised rather than about when, so a constant does.
func roster(list []config.Admin) func() []config.Admin {
	return func() []config.Admin { return list }
}

/*
 * What these guard is a door.
 *
 * Every other test in this repository protects something a person would notice
 * being wrong: a picture that goes black, a phrase that comes out in the wrong
 * language. A hole here is not like that. It is silent by construction, it is
 * found by somebody who is not going to report it, and by then the log of what
 * they did is written by them.
 */

var key = []byte("a key for the tests, of no particular length")

func admins(t *testing.T, passphrases ...string) ([]config.Admin, []string) {
	t.Helper()

	made := make([]config.Admin, 0, len(passphrases))
	trips := make([]string, 0, len(passphrases))

	for i, passphrase := range passphrases {
		trip := room.Trip(key, passphrase)
		can := []string{config.Moderate}
		if i > 0 {
			can = nil
		}

		made = append(made, config.Admin{Trip: trip, Name: passphrase, Can: can})
		trips = append(trips, trip)
	}

	return made, trips
}

func TestTheRightPassphraseOpensASession(t *testing.T) {
	listed, trips := admins(t, "correct")
	sessions := NewSessions(roster(listed), key)

	session, token, ok := sessions.Open("", "correct")
	if !ok {
		t.Fatal("the configured passphrase was refused")
	}

	if session.Trip != trips[0] {
		t.Errorf("session carries trip %q, want %q", session.Trip, trips[0])
	}

	if token == "" {
		t.Error("a session was opened without a token to carry it")
	}
}

func TestEveryOtherPassphraseIsRefused(t *testing.T) {
	listed, trips := admins(t, "correct")
	sessions := NewSessions(roster(listed), key)

	// The trip is public — it is printed beside its owner's name in every room
	// they join. Somebody who has read it off a screen and types it in has
	// offered a name, not a secret.
	for _, attempt := range []string{"", " ", "wrong", "Correct", trips[0]} {
		if _, _, ok := sessions.Open("", room.Passphrase(attempt)); ok {
			t.Errorf("%q opened a session", attempt)
		}
	}
}

func TestASignatureIsOnlyGoodOnItsOwnDeployment(t *testing.T) {
	listed, _ := admins(t, "correct")

	// The same passphrase against a different key produces a different mark,
	// which is what stops one deployment's signatures being worth anything on
	// another.
	elsewhere := NewSessions(roster(listed), []byte("a different deployment's key"))

	if _, _, ok := elsewhere.Open("", "correct"); ok {
		t.Error("a passphrase from one deployment opened a session on another")
	}
}

func TestWatchingAndActingAreSeparate(t *testing.T) {
	listed, _ := admins(t, "moderator", "watcher")
	sessions := NewSessions(roster(listed), key)

	moderator, _, _ := sessions.Open("", "moderator")
	watcher, _, _ := sessions.Open("", "watcher")

	if !watcher.Allows(config.Observe) {
		t.Error("an administrator listed with nothing cannot even watch")
	}

	if watcher.Allows(config.Moderate) {
		t.Error("an administrator listed with nothing can remove people")
	}

	if !moderator.Allows(config.Moderate) {
		t.Error("an administrator listed to moderate cannot")
	}
}

func TestASessionIsCarriedByItsCookieAndNothingElse(t *testing.T) {
	listed, _ := admins(t, "correct")
	sessions := NewSessions(roster(listed), key)

	_, token, _ := sessions.Open("", "correct")

	bare := httptest.NewRequest(http.MethodGet, "/api/admin/now", nil)
	if _, ok := sessions.Of(bare); ok {
		t.Error("a request with no cookie was taken as signed in")
	}

	guessed := httptest.NewRequest(http.MethodGet, "/api/admin/now", nil)
	guessed.AddCookie(&http.Cookie{Name: cookieName, Value: "not the token"})
	if _, ok := sessions.Of(guessed); ok {
		t.Error("a made-up token was taken as signed in")
	}

	carried := httptest.NewRequest(http.MethodGet, "/api/admin/now", nil)
	carried.AddCookie(&http.Cookie{Name: cookieName, Value: token})
	if _, ok := sessions.Of(carried); !ok {
		t.Error("the token that was issued was not accepted")
	}
}

func TestSigningOutEndsIt(t *testing.T) {
	listed, _ := admins(t, "correct")
	sessions := NewSessions(roster(listed), key)

	_, token, _ := sessions.Open("", "correct")

	request := httptest.NewRequest(http.MethodDelete, "/api/admin/session", nil)
	request.AddCookie(&http.Cookie{Name: cookieName, Value: token})

	sessions.Close(request)

	if _, ok := sessions.Of(request); ok {
		t.Error("a session survived being signed out of")
	}
}

func TestASessionExpires(t *testing.T) {
	listed, _ := admins(t, "correct")
	sessions := NewSessions(roster(listed), key)

	_, token, _ := sessions.Open("", "correct")

	sessions.mu.Lock()
	held := sessions.open[token]
	held.Expires = time.Now().Add(-time.Second)
	sessions.open[token] = held
	sessions.mu.Unlock()

	request := httptest.NewRequest(http.MethodGet, "/api/admin/now", nil)
	request.AddCookie(&http.Cookie{Name: cookieName, Value: token})

	if _, ok := sessions.Of(request); ok {
		t.Error("an expired session was still accepted")
	}
}

func TestNobodyIsConfiguredByDefault(t *testing.T) {
	// The surface exists only where somebody asked for it. A door that opens
	// for nobody is still a door, and this deployment does not fit one.
	if NewSessions(roster(nil), key).Configured() {
		t.Error("a deployment with no administrators has a management surface")
	}
}

/*
 * The limiter is the whole defence against a passphrase somebody thought of
 * rather than generated. Fifty bits is out of reach at any rate; a dictionary
 * is not, and what stands between the two is the number below.
 */

func TestGuessingIsBoundedPerCaller(t *testing.T) {
	limit := newAttempts()

	for i := 0; i < perAddress; i++ {
		if !limit.Allow("10.0.0.1") {
			t.Fatalf("refused after %d attempts, before the limit of %d", i, perAddress)
		}
		limit.Failed("10.0.0.1")
	}

	if limit.Allow("10.0.0.1") {
		t.Error("guessing continued past the per-caller limit")
	}
}

func TestGuessingIsBoundedEvenFromManyAddresses(t *testing.T) {
	limit := newAttempts()

	// A budget per caller is not a limit: an attacker chooses how many callers
	// to be, and a thousand hosts is a thousand budgets. The ceiling on the
	// endpoint as a whole is what has no give in it.
	for i := 0; i < overall; i++ {
		caller := string(rune('a'+i%26)) + string(rune('a'+i/26))
		limit.Failed(caller)
	}

	if limit.Allow("a caller that has never tried before") {
		t.Error("a fresh address was let through after the endpoint's own ceiling")
	}
}

func TestSucceedingCostsNothing(t *testing.T) {
	limit := newAttempts()

	// Only failures are counted. Somebody who signs in has proved they are not
	// guessing, and charging them for it makes an administrator's day harder
	// than an attacker's.
	for i := 0; i < perAddress*3; i++ {
		if !limit.Allow("10.0.0.2") {
			t.Fatal("an address that never failed was refused")
		}
	}
}

func TestABudgetRefills(t *testing.T) {
	limit := newAttempts()

	for i := 0; i < perAddress; i++ {
		limit.Failed("10.0.0.3")
	}

	if limit.Allow("10.0.0.3") {
		t.Fatal("guessing continued past the limit")
	}

	// The bucket returns a token every six seconds, so nothing is forgiven at
	// once and a caller is never locked out for good. Advanced by hand rather
	// than waited for: a test that sleeps six seconds is a test somebody skips.
	limit.mu.Lock()
	limit.byCaller["10.0.0.3"].limiter.AllowN(time.Now().Add(time.Minute), 0)
	limit.mu.Unlock()

	if !limit.Allow("10.0.0.3") {
		t.Error("a caller was still refused a minute after their last attempt")
	}
}

func TestCallersAreForgotten(t *testing.T) {
	limit := newAttempts()

	// A script cycling through addresses is what this guards against, so the
	// test is that shape: many callers, each failing once and never returning.
	// Counting what is held afterwards is the only assertion that fails when
	// the sweep is removed — checking one absent key passes whether the others
	// were dropped or not.
	const strangers = 200

	for i := 0; i < strangers; i++ {
		limit.Failed(strconv.Itoa(i))
	}

	// Aged by moving the clock the sweep reads rather than by rewriting each
	// entry against `idle`: rewriting them relative to the constant makes the
	// test pass whatever that constant is, including a value that would keep
	// every caller for ever.
	limit.mu.Lock()
	stale := time.Now().Add(-24 * time.Hour)
	for _, held := range limit.byCaller {
		held.seen = stale
	}
	limit.swept = time.Now().Add(-2 * time.Minute)
	limit.mu.Unlock()

	limit.Failed("somebody still trying")

	limit.mu.Lock()
	held := len(limit.byCaller)
	limit.mu.Unlock()

	if held > 1 {
		t.Errorf("%d callers held after all but one aged out; the map grows without bound", held)
	}
}

/*
The name is not decoration on the sign-in form.

Without it, every attempt is checked against every administrator at once, so a
list of leaked passphrases run at this endpoint succeeds if any one person on the
deployment has ever reused one — and it succeeds without the attacker having to
know that anybody exists. With it, a guess has to be aimed at somebody: one pool
becomes as many separate pools as there are administrators.

The compatibility case is the one that would rot quietly. An administrator with
no name recorded is matched by passphrase alone, because refusing them would lock
out any deployment upgrading into this — and a test that only covered the happy
path would let somebody later "tidy up" that branch and take the deployment with
it.
*/

func TestSigningInNeedsTheRightName(t *testing.T) {
	listed := []config.Admin{
		{Trip: room.Trip(key, "correct"), Name: "andy", Can: []string{config.Moderate}},
		{Trip: room.Trip(key, "elsewhere"), Name: "sam"},
	}

	sessions := NewSessions(roster(listed), key)

	if _, _, ok := sessions.Open("andy", "correct"); !ok {
		t.Fatal("the right name and passphrase were refused")
	}

	// Somebody else's name with this passphrase. Both are real and the pairing
	// is not, which is exactly what a stuffed credential looks like.
	if _, _, ok := sessions.Open("sam", "correct"); ok {
		t.Error("a passphrase belonging to one administrator signed in as another")
	}

	if _, _, ok := sessions.Open("nobody", "correct"); ok {
		t.Error("a name nobody has signed in")
	}
}

func TestSigningInStillWorksForSomebodyWithNoName(t *testing.T) {
	listed := []config.Admin{{Trip: room.Trip(key, "correct")}}

	sessions := NewSessions(roster(listed), key)

	// Whatever is typed in the name field, including nothing. The alternative
	// is a deployment that upgraded into this and can no longer be signed into
	// at all.
	for _, name := range []string{"", "andy", "anything"} {
		if _, _, ok := sessions.Open(name, "correct"); !ok {
			t.Errorf("an administrator with no name recorded was refused with name %q", name)
		}
	}
}

// vault is somewhere sessions survive, standing in for the store.
type vault struct {
	mu   sync.Mutex
	held map[string]store.Session
}

func newVault() *vault { return &vault{held: map[string]store.Session{}} }

func (k *vault) KeepSession(token string, session store.Session) error {
	k.mu.Lock()
	defer k.mu.Unlock()

	k.held[token] = session
	return nil
}

func (k *vault) Session(token string) (store.Session, bool) {
	k.mu.Lock()
	defer k.mu.Unlock()

	session, ok := k.held[token]
	return session, ok
}

func (k *vault) DropSession(token string) error {
	k.mu.Lock()
	defer k.mu.Unlock()

	delete(k.held, token)
	return nil
}

/*
A restart used to sign everybody out.

Sessions were held in memory and nowhere else, on the reasoning that one should
not outlive the configuration that authorised it. That was true while the
administrators lived in a file and changing them meant a restart. Once the list
moved into the store it stopped being true — removing somebody takes effect on
the next request — and all the behaviour did was throw everybody out whenever
the process was upgraded, which during an afternoon of deployments is every few
minutes and reads as the sign-in being broken.
*/

func TestASessionSurvivesARestart(t *testing.T) {
	listed := []config.Admin{{Trip: room.Trip(key, "correct"), Name: "andy"}}

	vaulted := newVault()

	before := NewSessions(roster(listed), key)
	before.Remember(vaulted)

	_, token, ok := before.Open("andy", "correct")
	if !ok {
		t.Fatal("signing in was refused")
	}

	// A different Sessions with nothing in memory, which is what comes back up.
	after := NewSessions(roster(listed), key)
	after.Remember(vaulted)

	request := httptest.NewRequest(http.MethodGet, "/api/admin/now", nil)
	request.AddCookie(&http.Cookie{Name: cookieName, Value: token})

	if _, ok := after.Of(request); !ok {
		t.Error("a session did not survive a restart; every deployment signs everybody out")
	}
}

func TestSigningOutSurvivesARestartToo(t *testing.T) {
	listed := []config.Admin{{Trip: room.Trip(key, "correct"), Name: "andy"}}

	vaulted := newVault()

	sessions := NewSessions(roster(listed), key)
	sessions.Remember(vaulted)

	_, token, _ := sessions.Open("andy", "correct")

	request := httptest.NewRequest(http.MethodGet, "/api/admin/now", nil)
	request.AddCookie(&http.Cookie{Name: cookieName, Value: token})

	sessions.Close(request)

	// Otherwise signing out would last exactly until the next deployment.
	after := NewSessions(roster(listed), key)
	after.Remember(vaulted)

	if _, ok := after.Of(request); ok {
		t.Error("a session signed out came back after a restart")
	}
}
