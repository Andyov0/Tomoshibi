// Package limit bounds how fast rooms can be asked for.
//
// A room exists because somebody named it, so asking to join one that nobody is
// using succeeds exactly like asking to join one that is busy. There is no
// failure to count and no lockout to trip: the only thing standing between a
// script and somebody else's meeting is how many names it can try per second,
// and that number is set here.
package limit

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

// idle is how long a caller's budget is kept after their last request.
//
// Long enough that a real person's budget survives a pause in a meeting, short
// enough that a script cycling through addresses cannot grow the map without
// bound. Sweeping on write rather than on a timer keeps this free when nothing
// is happening.
const idle = 10 * time.Minute

type budget struct {
	limiter *rate.Limiter
	seen    time.Time
}

// Limiter charges requests against a per-caller budget.
type Limiter struct {
	rate       rate.Limit
	burst      int
	trustProxy bool

	mu       sync.Mutex
	budgets  map[string]*budget
	lastKeep time.Time
}

// New builds a limiter allowing perSecond requests a second, bursting to burst.
//
// The burst is what carries a meeting: thirty people opening the same link at
// the top of the hour arrive together, and a limit describing only the steady
// rate would turn that into a queue.
func New(perSecond float64, burst int, trustProxy bool) *Limiter {
	return &Limiter{
		rate:       rate.Limit(perSecond),
		burst:      burst,
		trustProxy: trustProxy,
		budgets:    make(map[string]*budget),
		lastKeep:   time.Now(),
	}
}

// Allow charges one request, reporting whether it is within budget.
func (l *Limiter) Allow(r *http.Request) bool {
	key := l.client(r)
	now := time.Now()

	l.mu.Lock()
	defer l.mu.Unlock()

	l.sweep(now)

	held, ok := l.budgets[key]
	if !ok {
		held = &budget{limiter: rate.NewLimiter(l.rate, l.burst)}
		l.budgets[key] = held
	}
	held.seen = now

	return held.limiter.Allow()
}

// client works out who to charge.
//
// Behind a proxy that sets X-Forwarded-For, each caller gets a budget of its
// own. Without one the header is whatever the caller typed, so trusting it would
// let anybody mint unlimited budgets by varying a string; the peer address is
// used instead, which they cannot choose.
func (l *Limiter) client(r *http.Request) string {
	return Caller(r, l.trustProxy)
}

// Caller is the address a request came from, as this deployment resolves it.
//
// The same rule the rate limiter charges by, exported because the join has to
// write it down and the two must never disagree: an operator reading an address
// beside somebody's name is reading the one the limits were applied to.
func Caller(r *http.Request, trustProxy bool) string {
	if trustProxy {
		if forwarded := r.Header.Get("X-Forwarded-For"); forwarded != "" {
			// Proxies append, so the original client is the first entry and the
			// rest are hops it passed through on the way here.
			first, _, _ := strings.Cut(forwarded, ",")
			if address := strings.TrimSpace(first); address != "" {
				return address
			}
		}
	}

	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}

	return host
}

// sweep drops budgets nobody has drawn on recently.
//
// Called under the lock on every request but does its work at most once a
// minute, so the common path pays one comparison.
func (l *Limiter) sweep(now time.Time) {
	if now.Sub(l.lastKeep) < time.Minute {
		return
	}
	l.lastKeep = now

	for key, held := range l.budgets {
		if now.Sub(held.seen) > idle {
			delete(l.budgets, key)
		}
	}
}
