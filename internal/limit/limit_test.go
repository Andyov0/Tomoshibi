package limit

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func request(peer, forwarded string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/api/rooms/demo/join", nil)
	r.RemoteAddr = peer

	if forwarded != "" {
		r.Header.Set("X-Forwarded-For", forwarded)
	}

	return r
}

func TestABurstIsAllowedAndThenRefused(t *testing.T) {
	limiter := New(1, 3, false)

	for i := range 3 {
		if !limiter.Allow(request("192.0.2.1:1000", "")) {
			t.Fatalf("request %d was refused within the burst", i+1)
		}
	}

	if limiter.Allow(request("192.0.2.1:1000", "")) {
		t.Error("a request past the burst was allowed")
	}
}

// Without a proxy the peer address is the only thing a caller cannot choose.
func TestEachPeerHasItsOwnBudget(t *testing.T) {
	limiter := New(1, 1, false)

	if !limiter.Allow(request("192.0.2.1:1000", "")) {
		t.Fatal("the first request was refused")
	}
	if !limiter.Allow(request("192.0.2.2:1000", "")) {
		t.Error("a different peer was charged to the first one's budget")
	}
	if limiter.Allow(request("192.0.2.1:1000", "")) {
		t.Error("the first peer's budget was not spent")
	}
}

// Ports change between requests from one caller, so charging them apart would
// hand out a fresh budget every time.
func TestThePortIsNotPartOfTheIdentity(t *testing.T) {
	limiter := New(1, 1, false)

	if !limiter.Allow(request("192.0.2.1:1000", "")) {
		t.Fatal("the first request was refused")
	}
	if limiter.Allow(request("192.0.2.1:2000", "")) {
		t.Error("a new source port bought a new budget")
	}
}

func TestATrustedProxyIdentifiesTheClient(t *testing.T) {
	limiter := New(1, 1, true)

	if !limiter.Allow(request("10.0.0.1:1000", "192.0.2.1")) {
		t.Fatal("the first client was refused")
	}
	if !limiter.Allow(request("10.0.0.1:1000", "192.0.2.2")) {
		t.Error("a second client behind the same proxy shared the first one's budget")
	}
	if limiter.Allow(request("10.0.0.1:1000", "192.0.2.1")) {
		t.Error("the first client's budget was not spent")
	}
}

// Proxies append, so the original client is the first entry and the rest are
// hops it passed through.
func TestTheOriginalClientIsReadFromAChain(t *testing.T) {
	limiter := New(1, 1, true)

	if !limiter.Allow(request("10.0.0.1:1000", "192.0.2.1, 203.0.113.9")) {
		t.Fatal("the first request was refused")
	}
	if limiter.Allow(request("10.0.0.1:1000", "192.0.2.1, 198.51.100.7")) {
		t.Error("the same client through a different proxy got a new budget")
	}
}

// Untrusted, the header is whatever the caller typed, so varying it must not
// conjure a fresh budget.
func TestAnUntrustedHeaderCannotBuyANewBudget(t *testing.T) {
	limiter := New(1, 1, false)

	if !limiter.Allow(request("192.0.2.1:1000", "10.0.0.1")) {
		t.Fatal("the first request was refused")
	}
	if limiter.Allow(request("192.0.2.1:1000", "10.0.0.2")) {
		t.Error("a claimed address bought a budget the peer had already spent")
	}
}

// Budgets nobody has drawn on are dropped, so a script cycling through addresses
// cannot grow the map without bound.
func TestIdleBudgetsAreSweptAway(t *testing.T) {
	limiter := New(1, 1, false)

	limiter.Allow(request("192.0.2.1:1000", ""))
	if len(limiter.budgets) != 1 {
		t.Fatalf("held %d budgets, want 1", len(limiter.budgets))
	}

	// Backdate both the budget and the last sweep, which is the state the
	// limiter would be in after a quiet stretch.
	limiter.budgets["192.0.2.1"].seen = time.Now().Add(-2 * idle)
	limiter.lastKeep = time.Now().Add(-2 * time.Minute)

	limiter.Allow(request("192.0.2.9:1000", ""))

	if _, held := limiter.budgets["192.0.2.1"]; held {
		t.Error("an idle budget survived the sweep")
	}
}
