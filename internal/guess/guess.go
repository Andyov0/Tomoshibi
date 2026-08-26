// Package guess bounds how fast a passphrase can be tried.
//
// Its own package because more than one door takes a passphrase and they have
// to share a budget. A limit on the management sign-in and none on the room
// join is not two limits, it is none: the same secret is checked at both, and
// an attacker uses whichever is cheaper. This deployment had exactly that —
// ten a minute at one door and ten a second with no ceiling at the other,
// sixty times the rate, and the second door answered the same question.
package guess

import (
	"strings"
	"sync"
	"time"

	"golang.org/x/time/rate"
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
//
// Expressed as a bucket that refills rather than as a count inside a window,
// because that is what the rest of this server already uses and one idea is
// cheaper to hold than two. The shapes differ slightly — a window forgives all
// ten at once where a bucket returns them one at a time — and for a limit whose
// job is to make guessing slow, returning them gradually is if anything the
// better behaviour.
// PerAddress and Overall are exported so a test can assert the numbers rather
// than a behaviour that happens to follow from them.
const (
	PerAddress    = 10
	perAddressAll = rate.Limit(PerAddress) / rate.Limit(time.Minute/time.Second)

	Overall    = 30
	overallAll = rate.Limit(Overall) / rate.Limit(time.Minute/time.Second)
)

// idle is how long a caller's bucket is kept after their last failure.
//
// Only failures create one, so a map of these is a map of people who have got
// it wrong recently. Swept on write rather than on a timer, which keeps it free
// when nobody is trying.
const idle = 10 * time.Minute

// Attempts bounds failed guesses, by address and in total.
//
// In total as well as by address, because by address alone is not a limit. The
// budget is per caller and an attacker chooses how many callers to be: a
// thousand hosts is a thousand budgets, and the guessing rate rises with the
// price of renting them. A ceiling on the whole endpoint has no such give.
//
// The cost of that ceiling is that a determined stranger can lock out the
// administrator. That is the right way round: this door being shut for a minute
// is an inconvenience, and it being open is the end of every other control.
type Attempts struct {
	mu       sync.Mutex
	byCaller map[string]*budget
	all      *rate.Limiter
	swept    time.Time
}

type budget struct {
	limiter *rate.Limiter
	seen    time.Time
}

func New() *Attempts {
	return &Attempts{
		byCaller: make(map[string]*budget),
		all:      rate.NewLimiter(overallAll, Overall),
	}
}

// Allow reports whether this address may try again, without spending anything.
//
// Asked rather than taken, because a successful sign-in should cost nothing:
// somebody who proves who they are has demonstrated they were not guessing, and
// charging them for it makes an administrator's day harder than an attacker's.
func (a *Attempts) Allow(caller string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()

	held, known := a.byCaller[caller]

	return (!known || held.limiter.Tokens() >= 1) && a.all.Tokens() >= 1
}

// Failed records a refusal, spending from both buckets.
func (a *Attempts) Failed(caller string) {
	a.mu.Lock()
	defer a.mu.Unlock()

	now := time.Now()
	a.sweep(now)

	held, known := a.byCaller[caller]
	if !known {
		held = &budget{limiter: rate.NewLimiter(perAddressAll, PerAddress)}
		a.byCaller[caller] = held
	}

	held.seen = now
	held.limiter.Allow()
	a.all.Allow()
}

// sweep drops callers who have not failed in a while, so that a script cycling
// through addresses cannot grow the map without bound.
func (a *Attempts) sweep(now time.Time) {
	if now.Sub(a.swept) < time.Minute {
		return
	}
	a.swept = now

	for caller, held := range a.byCaller {
		if now.Sub(held.seen) > idle {
			delete(a.byCaller, caller)
		}
	}
}

func trimSpace(s string) string {
	return strings.TrimSpace(s)
}
