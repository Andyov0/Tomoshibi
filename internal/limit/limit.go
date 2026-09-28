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
func (l *Limiter) client(r *http.Request) string {
	return Client(r, l.trustProxy)
}

// Client is the address a request is charged to, shared by everything here that
// counts callers so that no two gates can disagree about who somebody is.
//
// Behind a proxy that sets X-Forwarded-For, each caller gets a budget of its
// own. Without one the header is whatever the caller typed, so trusting it would
// let anybody mint unlimited budgets by varying a string; the peer address is
// used instead, which they cannot choose.
//
// Behind one, it is the last entry that is believed, not the first. Proxies
// append the address they saw to whatever the header already said, and what it
// already said is the caller's to write: nginx's $proxy_add_x_forwarded_for,
// Caddy, and most load balancers all pass a forged prefix through untouched. The
// first entry is therefore exactly as choosable as an untrusted header, and
// reading it undid the whole point of trusting the proxy -- a script sending a
// fresh X-Forwarded-For per request got a fresh budget per request, both here
// and at the administrator sign-in. The last entry is the one the proxy in front
// of this server wrote, which is the one thing in the header nobody else could
// have. A chain of two proxies is then charged as one caller, which is the safe
// way to be wrong.
func Client(r *http.Request, trustProxy bool) string {
	if trustProxy {
		if forwarded := r.Header.Get("X-Forwarded-For"); forwarded != "" {
			last := forwarded
			if comma := strings.LastIndexByte(forwarded, ','); comma >= 0 {
				last = forwarded[comma+1:]
			}
			if address := strings.TrimSpace(last); address != "" {
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
