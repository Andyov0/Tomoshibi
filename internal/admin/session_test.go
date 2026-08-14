package admin

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"tomoshibi/internal/config"
	"tomoshibi/internal/room"
)

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
	sessions := NewSessions(listed, key)

	session, token, ok := sessions.Open("correct")
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
	sessions := NewSessions(listed, key)

	// The trip is public — it is printed beside its owner's name in every room
	// they join. Somebody who has read it off a screen and types it in has
	// offered a name, not a secret.
	for _, attempt := range []string{"", " ", "wrong", "Correct", trips[0]} {
		if _, _, ok := sessions.Open(room.Passphrase(attempt)); ok {
			t.Errorf("%q opened a session", attempt)
		}
	}
}

func TestASignatureIsOnlyGoodOnItsOwnDeployment(t *testing.T) {
	listed, _ := admins(t, "correct")

	// The same passphrase against a different key produces a different mark,
	// which is what stops one deployment's signatures being worth anything on
	// another.
	elsewhere := NewSessions(listed, []byte("a different deployment's key"))

	if _, _, ok := elsewhere.Open("correct"); ok {
		t.Error("a passphrase from one deployment opened a session on another")
	}
}

func TestWatchingAndActingAreSeparate(t *testing.T) {
	listed, _ := admins(t, "moderator", "watcher")
	sessions := NewSessions(listed, key)

	moderator, _, _ := sessions.Open("moderator")
	watcher, _, _ := sessions.Open("watcher")

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
	sessions := NewSessions(listed, key)

	_, token, _ := sessions.Open("correct")

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
	sessions := NewSessions(listed, key)

	_, token, _ := sessions.Open("correct")

	request := httptest.NewRequest(http.MethodDelete, "/api/admin/session", nil)
	request.AddCookie(&http.Cookie{Name: cookieName, Value: token})

	sessions.Close(request)

	if _, ok := sessions.Of(request); ok {
		t.Error("a session survived being signed out of")
	}
}

func TestASessionExpires(t *testing.T) {
	listed, _ := admins(t, "correct")
	sessions := NewSessions(listed, key)

	_, token, _ := sessions.Open("correct")

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
	if NewSessions(nil, key).Configured() {
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

func TestAttemptsAreForgotten(t *testing.T) {
	limit := newAttempts()

	for i := 0; i < perAddress; i++ {
		limit.Failed("10.0.0.3")
	}

	limit.mu.Lock()
	for i := range limit.byCaller["10.0.0.3"] {
		limit.byCaller["10.0.0.3"][i] = time.Now().Add(-window - time.Second)
	}
	for i := range limit.all {
		limit.all[i] = time.Now().Add(-window - time.Second)
	}
	limit.mu.Unlock()

	if !limit.Allow("10.0.0.3") {
		t.Error("a caller was locked out past the window")
	}

	limit.mu.Lock()
	remaining := len(limit.byCaller)
	limit.mu.Unlock()

	if remaining != 0 {
		t.Errorf("%d callers kept after ageing out; the map grows without bound", remaining)
	}
}
