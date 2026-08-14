package admin

import (
	"strings"
	"sync"
	"time"
)

// How hard the sign-in may be pushed.
//
// Far tighter than the join endpoint, and deliberately so. Joining is something
// people do; signing in as an administrator is something one person does
// occasionally and an attacker does continuously, and the two do not deserve the
// same allowance.
//
// The numbers come from what they have to defeat. A generated passphrase is
// fifty bits and out of reach at any rate, but nothing here can tell a generated
// passphrase from one somebody thought of, and against the second kind the rate
// is the whole defence. Ten a minute leaves a dictionary of ten million taking
// nineteen centuries.
const (
	perAddress = 10
	overall    = 30
	window     = time.Minute
)

// attempts counts failed sign-ins, by address and in total.
//
// In total as well as by address, because by address alone is not a limit. The
// budget is per caller and an attacker chooses how many callers to be: a
// thousand hosts is a thousand budgets, and the guessing rate rises with the
// price of renting them. A ceiling on the whole endpoint has no such give.
//
// The cost of that ceiling is that a determined stranger can lock out the
// administrator. That is the right way round: this door being shut for a minute
// is an inconvenience, and it being open is the end of every other control.
type attempts struct {
	mu       sync.Mutex
	byCaller map[string][]time.Time
	all      []time.Time
}

func newAttempts() *attempts {
	return &attempts{byCaller: make(map[string][]time.Time)}
}

// Allow reports whether this address may try again, without counting the try.
func (a *attempts) Allow(caller string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()

	now := time.Now()
	a.forget(now)

	return len(a.byCaller[caller]) < perAddress && len(a.all) < overall
}

// Failed records a refusal. Only failures are counted: somebody signing in
// successfully has proved they are not guessing, and charging them for it would
// make an administrator's own day harder than an attacker's.
func (a *attempts) Failed(caller string) {
	a.mu.Lock()
	defer a.mu.Unlock()

	now := time.Now()
	a.forget(now)

	a.byCaller[caller] = append(a.byCaller[caller], now)
	a.all = append(a.all, now)
}

// forget drops what has aged out of the window. Called under the lock by both
// paths, so the maps cannot grow without bound on an endpoint nobody is using
// legitimately.
func (a *attempts) forget(now time.Time) {
	cutoff := now.Add(-window)

	a.all = after(a.all, cutoff)

	for caller, times := range a.byCaller {
		kept := after(times, cutoff)
		if len(kept) == 0 {
			delete(a.byCaller, caller)
			continue
		}
		a.byCaller[caller] = kept
	}
}

func after(times []time.Time, cutoff time.Time) []time.Time {
	kept := times[:0]
	for _, at := range times {
		if at.After(cutoff) {
			kept = append(kept, at)
		}
	}

	return kept
}

func trimSpace(s string) string {
	return strings.TrimSpace(s)
}
