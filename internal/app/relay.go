package app

import (
	"hash/fnv"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"tomoshibi/internal/admin"
	"tomoshibi/internal/config"
	"tomoshibi/internal/rtc"
	"tomoshibi/internal/store"
)

// Source is where the live list of relays comes from.
//
// An interface so that the choosing below can be tested against a list somebody
// wrote down, while the running deployment reads the store the management pages
// write to. The alternative — reading config.Meet.Relays directly — was what
// this did first, and it meant a relay added from a page did nothing until the
// process was restarted.
type Source interface {
	Relays() ([]store.Relay, error)
}

// relays chooses which media server a client is told to dial.
//
// Only a control node ever asks. A full deployment is its own relay and answers
// with its own address, which is what [App.signallingURL] already did and still
// does when nothing is listed here.
type relays struct {
	source Source
	policy string

	// reach is what the control node found when it last opened a connection to
	// each relay. Nil on a deployment that never wired a cluster in, which
	// means every relay counts as worth offering.
	reach *reach

	// turn carries the round-robin position. Atomic because joins arrive
	// concurrently and the only thing this counter must not do is hand two
	// callers the same answer by losing an increment.
	turn atomic.Uint64

	// cache holds the last list read, so that a join is not a database read.
	//
	// Short, because the point of keeping this in the store was that a change
	// takes effect without a restart, and a long cache would put the restart
	// back in a different costume. Two seconds is under what anybody notices
	// between pressing save and trying it.
	mu       sync.RWMutex
	cached   []store.Relay
	cachedAt time.Time
}

// How long a read of the relay list is reused.
const relayCacheFor = 2 * time.Second

func newRelays(conf *config.Config, source Source) *relays {
	return &relays{source: source, policy: conf.Meet.RelayPolicy}
}

// live returns the relays clients may be sent to, newest read or cached.
//
// Only the enabled ones. A relay that has been taken out of service still holds
// the calls already on it — this server could not end them and has no business
// doing so — but nobody new is sent there.
func (r *relays) live() []store.Relay {
	if r == nil || r.source == nil {
		return nil
	}

	r.mu.RLock()
	if time.Since(r.cachedAt) < relayCacheFor {
		list := r.cached
		r.mu.RUnlock()
		return list
	}
	r.mu.RUnlock()

	all, err := r.source.Relays()
	if err != nil {
		// The last good list rather than none. A store that will not answer is
		// a reason to keep working from what was already known, not a reason to
		// tell everybody there is nowhere to hold a call.
		slog.Error("failed to read the relays; using the last list", "error", err)

		r.mu.RLock()
		defer r.mu.RUnlock()
		return r.cached
	}

	enabled := make([]store.Relay, 0, len(all))
	for _, relay := range all {
		if relay.Enabled {
			enabled = append(enabled, relay)
		}
	}

	r.mu.Lock()
	r.cached, r.cachedAt = enabled, time.Now()
	r.mu.Unlock()

	return enabled
}

// forget drops the cache, so the next join reads the store.
//
// Called when the management pages change something. Without it a relay just
// added would not be offered for up to the cache's length, and the person who
// added it would be looking at a page that says it is there and a join that
// does not use it.
func (r *relays) forget() {
	if r == nil {
		return
	}

	r.mu.Lock()
	r.cachedAt = time.Time{}
	r.mu.Unlock()
}

// all is every relay, in service or not.
//
// Separate from live because they answer different questions: this is what a
// person should see, and live is what a call may be sent to. Conflating them is
// how a relay out of service comes to hold a meeting.
func (r *relays) all() []store.Relay {
	if r == nil || r.source == nil {
		return nil
	}

	list, err := r.source.Relays()
	if err != nil {
		// The cache, which holds only the enabled ones, is better than nothing
		// and better than an error on a page.
		return r.live()
	}

	return list
}

// any reports whether there is anything to choose from.
func (r *relays) any() bool { return len(r.live()) > 0 }

// byName finds a relay a client named, and says whether it is one of ours.
//
// The whole of the trust boundary for the probe policy. A client sends a name
// it was given; anything else — a name from an older configuration, a guess, an
// address somebody hoped would be dialled — finds nothing and is ignored, which
// leaves the caller with the policy's fallback rather than with a meeting sent
// wherever they asked.
func (r *relays) byName(list []store.Relay, name string) (store.Relay, bool) {
	if name == "" {
		return store.Relay{}, false
	}

	for _, relay := range list {
		if relay.Name == name {
			return relay, true
		}
	}

	return store.Relay{}, false
}

// offered is the list a client is given to measure, addresses included.
//
// The addresses are public by construction: every one of them is handed to
// somebody the moment they join. What is not here is anything about the shape
// of the deployment — no counts, no health, no load — because this endpoint
// answers to anybody who asks.
// offered is the list a client is given, including the ones out of service.
//
// Those are sent so they can be shown greyed rather than hidden. A relay taken
// down for maintenance that simply vanishes from the list looks like a relay
// that was deleted — somebody who used it yesterday and cannot find it today
// has no way to tell those apart, and asks. Sent with the flag, it says what it
// is: still here, not taking calls.
func (r *relays) offered(admin bool) []store.Relay {
	list := r.all()

	if !admin {
		open := make([]store.Relay, 0, len(list))
		for _, relay := range list {
			if !relay.AdminOnly {
				open = append(open, relay)
			}
		}

		list = open
	}

	return r.reach.keep(list)
}

// preferred splits a list into the relays to use and the ones held in reserve.
//
// A fallback relay is not a worse relay — it is a relay whose cost is paid in
// distance rather than in quality, and one that should therefore be reached for
// only when the alternative is no call at all. Returning both halves rather than
// filtering keeps that decision here, where the list is already in hand.
func preferred(list []store.Relay) (ordinary, reserve []store.Relay) {
	for _, relay := range list {
		if relay.Fallback {
			reserve = append(reserve, relay)
			continue
		}
		ordinary = append(ordinary, relay)
	}

	return ordinary, reserve
}

// pick returns the relay for this room and this client.
//
// Room first and client second, because the room is what the policies are
// mostly about: gathering a meeting onto one relay is what keeps media from
// being carried twice, and that decision cannot depend on who is asking or the
// second person to join would land somewhere else.
//
// chosen is what a client measured and asked for, empty when it did not ask.
func (r *relays) pick(room string, chosen string, req *http.Request, trustProxy bool, admin bool) store.Relay {
	all := r.live()

	// A relay reserved for administrators is not among the ones anybody else is
	// chosen from, and not one they can ask for by name either. Removed here
	// rather than only from the list that is published, because the published
	// list is a convenience and this is the rule.
	if !admin {
		open := make([]store.Relay, 0, len(all))
		for _, relay := range all {
			if !relay.AdminOnly {
				open = append(open, relay)
			}
		}

		all = open
	}

	// Two preferences, applied in order, and the order is the argument.
	//
	// Reachability first: a relay the control node cannot open a connection to
	// is not a worse choice, it is not a choice. Then the reserve, which is
	// used only when nothing else is available — the setting means "prefer
	// anything else", not "never".
	//
	// Each step falls back to the one before rather than to nothing. A
	// deployment where every relay has stopped answering still has to hold
	// calls somewhere, and the control node's reading is a suspicion formed
	// from one vantage point: refusing to name a relay on the strength of it
	// would turn one machine's bad minute into an outage for everybody.
	ordinary, reserve := preferred(all)

	list := r.reach.only(ordinary)
	if len(list) == 0 {
		list = r.reach.only(reserve)
	}
	if len(list) == 0 {
		list = ordinary
	}
	if len(list) == 0 {
		list = reserve
	}

	// A client that measured a reserve relay as fastest is honoured anyway: it
	// asked for that one specifically, and being told otherwise would be this
	// server overruling a measurement it cannot make itself.
	if r.policy == config.PickProbe && chosen != "" {
		if relay, ok := r.byName(all, chosen); ok {
			return relay
		}
	}

	switch {
	case len(list) == 0:
		return store.Relay{}

	case len(list) == 1:
		// One relay is not a choice, and taking this early keeps the policies
		// below from having to be correct about a case with no alternatives.
		return list[0]

	case r.policy == config.PickProbe:
		// What the client measured, if it is one of ours. A name that is not
		// falls through to the room's own relay: an unmeasured client should
		// still land with the rest of their meeting.
		if relay, ok := r.byName(list, chosen); ok {
			return relay
		}
		return list[int(hashRoom(room)%uint64(len(list)))]

	case r.policy == config.PickRoundRobin:
		// Wraps on overflow, which is the behaviour wanted: the sequence is
		// what matters and it continues across the boundary.
		return list[int(r.turn.Add(1)-1)%len(list)]

	case r.policy == config.PickNearest:
		if region := clientRegion(req, trustProxy); region != "" {
			for _, relay := range list {
				if strings.EqualFold(relay.Region, region) {
					return relay
				}
			}
		}
		// Nothing matched. Falling through to sticky rather than to the first
		// entry, so a client whose region is unknown still lands with the rest
		// of their meeting instead of piling onto whichever relay is listed
		// first.
		fallthrough

	default:
		return list[int(hashRoom(room)%uint64(len(list)))]
	}
}

// hashRoom turns a room name into a stable position in the list.
//
// Stable across processes and restarts, which is the whole point: two control
// nodes behind one address must send the same room to the same relay, and a
// control node that was restarted mid-meeting must not start sending the second
// half of the participants somewhere else.
//
// FNV rather than maphash for exactly that reason — maphash is seeded per
// process and would give a different answer on every start.
func hashRoom(room string) uint64 {
	sum := fnv.New64a()
	_, _ = sum.Write([]byte(room))
	return sum.Sum64()
}

// The header a proxy or CDN sets to say where a client is.
//
// Read rather than derived: working a region out from an address needs a
// database that has to be shipped, kept current, and consulted on a path that
// is otherwise a signature and a write. Every proxy worth putting in front of
// this already knows the answer — Cloudflare sends CF-IPCountry, and anything
// else can be told to set X-Client-Region — so the useful thing is to believe
// one of them rather than to work it out again.
const (
	headerRegion  = "X-Client-Region"
	headerCountry = "CF-IPCountry"
)

// clientRegion reads where a client says it is, when there is a proxy worth
// believing.
//
// Gated on the same trust_proxy that guards the forwarded address and host,
// because it is the same kind of claim: a header nobody upstream overwrites is
// whatever the caller typed. Believing it unguarded would not be a security
// hole here — the worst it buys is a relay of one's choosing — but it would be
// a setting that silently does nothing on a direct deployment and something
// else entirely behind a proxy, which is worse than either.
func clientRegion(req *http.Request, trustProxy bool) string {
	if req == nil || !trustProxy {
		return ""
	}

	if region := strings.TrimSpace(req.Header.Get(headerRegion)); region != "" {
		return region
	}

	return strings.TrimSpace(req.Header.Get(headerCountry))
}

// RelayURLs is where a control node's management pages should look for the
// media it does not hold.
//
// Enabled relays only, and read live rather than captured at start: a relay
// added from a page is asked about immediately, and one taken out of service
// stops being asked. The same list the joins are handed from, which is what
// keeps a page from reporting on a relay clients are no longer sent to.
func (a *App) RelayURLs() []string {
	list := a.relays.live()

	urls := make([]string, 0, len(list))
	for _, relay := range list {
		urls = append(urls, relay.URL)
	}

	return urls
}

// UseCluster points the management pages at the relays.
//
// Also wires the other direction: the pages change the relay list, and the
// choosing side has to hear about it or a relay just added would not be used
// until its cache expired.
func (a *App) UseCluster(cluster *rtc.Cluster) {
	a.admin.UseCluster(cluster)
	a.admin.OnRelaysChanged(a.relays.forget)

	// And the same connection the management pages are drawn from decides which
	// relays clients are offered. The browser cannot tell a relay that refused
	// from one that was never there — both are an error event with nothing on
	// it — and the one that was never there answers sooner, so it wins a
	// measurement it should lose. This is the half of that question the control
	// node can answer.
	a.reach = newReach(cluster.Check)
	a.relays.reach = a.reach

	go a.watching()
}

// UseEnrolment lets relays bring themselves up from a script.
//
// Two things: the management pages gain the script, and the router gains the
// one endpoint a machine with no session calls. Registered here rather than in
// Handler so that a deployment which did not configure enrolment has no such
// address at all, rather than one that refuses.
func (a *App) UseEnrolment(enrolment *admin.Enrolment) {
	a.admin.UseEnrolment(enrolment)
	a.enrolment = enrolment
}
