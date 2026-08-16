package app

import (
	"context"
	"testing"
	"time"

	"tomoshibi/internal/config"
	"tomoshibi/internal/store"
)

/*
What these guard is a relay winning a race by being broken.

The browser measures every relay it is offered and names the fastest, and it
cannot tell a relay that refused from one that was never reachable: both arrive
as an error event carrying nothing, by design. That would be tolerable if the
two took similar amounts of time. They do not. A relay that refuses an untokened
upgrade completes a TLS handshake and answers an HTTP request first; a relay
whose connection is reset answers in one round trip. The broken one is measured
as nearest, is chosen, and the call fails.

So the control node opens a connection of its own and keeps the ones that
answer, and what is asserted here is both halves of that: a relay that does not
answer is not offered, and a deployment where nothing answers still holds calls.
The second is the one that would be quietly wrong — it only shows up on the day
the control node's own network is having trouble, which is the worst possible
day to also stop naming any relay at all.
*/

func fixed(up map[string]bool) Check {
	return func(_ context.Context, url string) (bool, time.Duration, string) {
		if up[url] {
			return true, 5 * time.Millisecond, ""
		}

		return false, 0, "refused"
	}
}

var (
	near = store.Relay{Name: "guangzhou", URL: "wss://gz.example:1", Enabled: true}
	far  = store.Relay{Name: "tokyo", URL: "wss://jp.example:1", Enabled: true}
	held = store.Relay{Name: "hongkong", URL: "wss://hk.example:1", Enabled: true, Fallback: true}
)

func withReach(t *testing.T, list []store.Relay, up map[string]bool) *relays {
	t.Helper()

	conf := &config.Config{}
	conf.Meet.RelayPolicy = config.PickSticky

	chosen := newRelays(conf, &listed{relays: list})
	chosen.reach = newReach(fixed(up))
	chosen.reach.look(context.Background(), list)

	return chosen
}

func TestARelayThatDoesNotAnswerIsNotOffered(t *testing.T) {
	chosen := withReach(t, []store.Relay{near, far}, map[string]bool{far.URL: true})

	offered := chosen.offered(false)
	if len(offered) != 1 || offered[0].Name != "tokyo" {
		t.Fatalf("offered %v; a relay the control node cannot open a connection to must "+
			"not be measured, because the browser cannot tell it from a slow one and it "+
			"answers sooner than a working relay does", names(offered))
	}
}

func TestARelayThatDoesNotAnswerIsNotChosen(t *testing.T) {
	chosen := withReach(t, []store.Relay{near, far}, map[string]bool{far.URL: true})

	// Named by the client, which is the path that trusts a measurement. Even
	// asked for outright, a relay known not to answer is not where a call goes.
	for _, room := range []string{"standup", "retro", "one-to-one", "all-hands"} {
		if got := chosen.pick(room, "", nil, false, false); got.Name != "tokyo" {
			t.Fatalf("room %q went to %q; only one relay answered", room, got.Name)
		}
	}
}

// The one that fails on the worst possible day. A control node that has lost its
// own network sees every relay as gone, and must not conclude there is nowhere
// to hold a call.
func TestNothingAnsweringIsNotAnOutage(t *testing.T) {
	chosen := withReach(t, []store.Relay{near, far}, map[string]bool{})

	if got := len(chosen.offered(false)); got != 2 {
		t.Errorf("offered %d relays when none answered, wanted all %d: a control node that "+
			"has lost its own network sees exactly this, and naming no relay turns its bad "+
			"minute into everybody's", got, 2)
	}

	if got := chosen.pick("standup", "", nil, false, false); got.Name == "" {
		t.Error("no relay was chosen when none answered; a call has to be held somewhere")
	}
}

// Reachability is asked before the reserve, not after. A working relay held back
// for emergencies is still the answer when the ordinary one has gone.
func TestTheReserveIsUsedWhenTheOrdinaryOneIsUnreachable(t *testing.T) {
	chosen := withReach(t, []store.Relay{near, held}, map[string]bool{held.URL: true})

	if got := chosen.pick("standup", "", nil, false, false); got.Name != "hongkong" {
		t.Fatalf("chose %q; the only relay answering was the reserve, and a reserve exists "+
			"for exactly this", got.Name)
	}
}

// And not before that. A reserve is a relay whose cost is paid in distance, so
// while anything else is answering it stays where it is.
func TestTheReserveIsLeftAloneWhileTheOrdinaryOneAnswers(t *testing.T) {
	chosen := withReach(t, []store.Relay{near, held}, map[string]bool{near.URL: true, held.URL: true})

	for _, room := range []string{"standup", "retro", "one-to-one", "all-hands"} {
		if got := chosen.pick(room, "", nil, false, false); got.Name != "guangzhou" {
			t.Fatalf("room %q went to the reserve while the ordinary relay was answering", room)
		}
	}
}

func TestARelayNobodyHasLookedAtYetIsOffered(t *testing.T) {
	conf := &config.Config{}
	conf.Meet.RelayPolicy = config.PickSticky

	chosen := newRelays(conf, &listed{relays: []store.Relay{near, far}})
	chosen.reach = newReach(fixed(map[string]bool{}))

	// Nothing has been checked. A relay added a moment ago has not been looked
	// at, and hiding it until a ticker comes round looks like a broken save to
	// whoever just added it.
	if got := len(chosen.offered(false)); got != 2 {
		t.Errorf("offered %d of 2 relays before any had been checked", got)
	}
}

func names(list []store.Relay) []string {
	out := make([]string, 0, len(list))
	for _, relay := range list {
		out = append(out, relay.Name)
	}

	return out
}
