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

	offered := chosen.offered()
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

	if got := len(chosen.offered()); got != 2 {
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
	if got := len(chosen.offered()); got != 2 {
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

/*
What a total blackout means, and what it does not.

This deployment's control node sits on a residential line in Tokyo. Over one
week it lost the network thirty-two times, for twenty to forty seconds each, and
every time it did the reachability sweep marked all eleven relays unreachable —
machines in mainland China, Hong Kong, Singapore, Japan and Los Angeles, which
share no path with each other but the last one into this house. The relays were
fine. The list every client is offered went empty anyway, so a twenty-second
blip on somebody's home connection became a deployment with nowhere to hold a
call, and the log said eleven relays had failed.

The rule these guard is that a sweep in which nothing answered is a measurement
of this end. The asymmetry decides it: wrongly keeping a dead fleet listed costs
a client one failed connection and a retry, which it would have paid anyway;
wrongly dropping a live one costs everybody the ability to call at all.
*/

func TestNothingAnsweringIsReadAsThisMachineAndNotTheFleet(t *testing.T) {
	fleet := []store.Relay{
		{Name: "tokyo", URL: "wss://jp.invalid", Enabled: true},
		{Name: "hongkong", URL: "wss://hk.invalid", Enabled: true},
		{Name: "losangeles", URL: "wss://lax.invalid", Enabled: true},
	}

	answering := true
	watch := newReach(func(context.Context, string) (bool, time.Duration, string) {
		return answering, time.Millisecond, "timed out"
	})

	watch.look(context.Background(), fleet)

	if got := len(watch.only(fleet)); got != 3 {
		t.Fatalf("%d relays answering while everything answered, want 3", got)
	}

	// The line goes out.
	answering = false
	watch.look(context.Background(), fleet)

	// only(), not keep(). keep() has long returned everything when nothing is
	// left, which is what stopped a blackout from emptying the list clients are
	// offered — so asserting on keep() here would pass with this rule removed
	// and prove nothing. What was wrong is one layer down: the readings
	// themselves were being overwritten, so the picker's own view went empty
	// and every relay was logged as having failed.
	if got := len(watch.only(fleet)); got != 3 {
		t.Errorf("%d relays recorded as answering after a sweep that reached none of them, "+
			"want 3: three machines on three continents did not fail together, and writing "+
			"that down makes the log say eleven relays died every time this house loses its "+
			"line", got)
	}

	// And a real failure, of one machine, is still believed.
	answering = true
	watch.look(context.Background(), fleet)

	one := 0
	watch2 := newReach(func(_ context.Context, url string) (bool, time.Duration, string) {
		one++
		return url != "wss://hk.invalid", time.Millisecond, "timed out"
	})
	watch2.look(context.Background(), fleet)

	kept := watch2.only(fleet)
	if len(kept) != 2 {
		t.Errorf("%d relays kept when one of three was down, want 2: the rule is about "+
			"everything failing at once, not about any failure", len(kept))
	}

	for _, relay := range kept {
		if relay.Name == "hongkong" {
			t.Error("the relay that was actually down is still offered")
		}
	}
}

// And the readings come back by themselves, without needing a restart.
func TestReadingsResumeWhenTheLineComesBack(t *testing.T) {
	fleet := []store.Relay{
		{Name: "tokyo", URL: "wss://jp.invalid", Enabled: true},
		{Name: "hongkong", URL: "wss://hk.invalid", Enabled: true},
	}

	answering := false
	watch := newReach(func(context.Context, string) (bool, time.Duration, string) {
		return answering, time.Millisecond, "timed out"
	})

	// Out for a while, which must not accumulate into anything.
	for range 5 {
		watch.look(context.Background(), fleet)
	}

	if watch.blind != 5 {
		t.Errorf("counted %d blind sweeps, want 5", watch.blind)
	}

	answering = true
	watch.look(context.Background(), fleet)

	if watch.blind != 0 {
		t.Error("the count did not clear when the line came back, so the next outage would " +
			"be reported as part of this one")
	}

	if got := len(watch.only(fleet)); got != 2 {
		t.Errorf("%d relays recorded as answering after the line came back, want 2", got)
	}
}
