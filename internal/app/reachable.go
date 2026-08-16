package app

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"tomoshibi/internal/store"
)

/*
Keeping a relay nobody can reach out of the choosing.

The browser measures every relay it is offered and names the fastest, and that
measurement cannot tell a relay that is there and refusing from one that is not
there at all. Both arrive as an error event with nothing readable on it —
deliberately, because a page that could tell the difference could map a network
it was never given. So the two are indistinguishable from the one place that
would most like to know.

Which would be a curiosity, except that it inverts. A relay refusing an
untokened upgrade has to complete a TLS handshake and answer an HTTP request
before it can refuse; a relay whose connection is reset answers in one round
trip and answers sooner. The broken one wins the measurement, wins the room, and
the call fails — and it wins by more the more thoroughly it is broken.

The control node has the answer the browser cannot get: it opens a TCP
connection to each relay and sees whether it completes. So the two are split.
This decides which relays are worth offering, and the browser decides which of
those is nearest.

Checked here on a ticker and not per request. Answering a join must not wait on
a network round trip to a machine in another country, and a list read by every
client on every join would otherwise become one connection per relay per join —
which is how the last measurement got a relay blocked.
*/

// How often each relay is looked at.
//
// Slower than it could be. What this catches is a machine that has gone away,
// and a machine that goes away stays away for longer than this; what it costs
// is a connection per relay, which is the thing to be sparing with. Half a
// minute of sending clients to a relay that has just died is a worse experience
// than none, and a great deal better than the reverse mistake.
const reachEvery = 30 * time.Second

// How long a check may take before the relay counts as unreachable.
//
// Generously long compared to any real answer — a TCP handshake across the
// Pacific is under half a second — because the cost of being wrong is
// asymmetric. Calling a slow relay dead removes it from the rotation; waiting
// four seconds to find out costs a background goroutine four seconds.
const reachWithin = 4 * time.Second

// Check is what the control node uses to see whether a relay is there.
//
// The signature [rtc.Cluster.Check] already has. An interface of one function
// rather than the concrete type, so that the choosing can be tested against a
// relay that is up or down by saying so, rather than by binding a port.
type Check func(ctx context.Context, url string) (bool, time.Duration, string)

// reach remembers which relays answered the last time they were asked.
type reach struct {
	check Check

	mu   sync.RWMutex
	down map[string]bool
}

func newReach(check Check) *reach {
	return &reach{check: check, down: map[string]bool{}}
}

// up reports whether a relay is worth offering.
//
// Unknown counts as up, which is the important half. A relay added a moment ago
// has not been looked at yet, and a deployment that hid every new relay until a
// ticker came round would look broken to whoever just added one.
func (r *reach) up(url string) bool {
	if r == nil {
		return true
	}

	r.mu.RLock()
	defer r.mu.RUnlock()

	return !r.down[url]
}

// only returns the relays that answered, which may be none of them.
func (r *reach) only(list []store.Relay) []store.Relay {
	if r == nil {
		return list
	}

	live := make([]store.Relay, 0, len(list))
	for _, relay := range list {
		if r.up(relay.URL) {
			live = append(live, relay)
		}
	}

	return live
}

// keep returns the relays worth offering, out of the ones given.
//
// Everything, when nothing answered. A deployment whose relays have all gone
// quiet is more likely to be one whose control node lost its own network than
// one where every machine died at once, and refusing to name any relay turns a
// suspicion into an outage. The client will find out soon enough, from the only
// vantage point that counts.
func (r *reach) keep(list []store.Relay) []store.Relay {
	live := r.only(list)
	if len(live) == 0 {
		return list
	}

	return live
}

// look asks each relay once.
func (r *reach) look(ctx context.Context, list []store.Relay) {
	for _, relay := range list {
		asking, cancel := context.WithTimeout(ctx, reachWithin)
		ok, took, detail := r.check(asking, relay.URL)
		cancel()

		r.mu.Lock()
		was := r.down[relay.URL]
		r.down[relay.URL] = !ok
		r.mu.Unlock()

		// Said once on the change rather than every half minute, so that a relay
		// which has been down all night is one line in the log and not two
		// thousand.
		switch {
		case !ok && !was:
			slog.Warn("a relay stopped answering and is no longer offered to clients",
				"relay", relay.Name, "url", relay.URL, "detail", detail)
		case ok && was:
			slog.Info("a relay is answering again",
				"relay", relay.Name, "url", relay.URL, "took", took)
		}
	}
}

// watching keeps the reading current until the deployment stops.
func (a *App) watching() {
	ticker := time.NewTicker(reachEvery)
	defer ticker.Stop()

	for {
		a.reach.look(context.Background(), a.relays.live())

		select {
		case <-a.stop:
			return
		case <-ticker.C:
		}
	}
}
