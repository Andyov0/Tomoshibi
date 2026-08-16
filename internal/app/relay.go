package app

import (
	"hash/fnv"
	"net/http"
	"strings"
	"sync/atomic"

	"tomoshibi/internal/config"
)

// relays chooses which media server a client is told to dial.
//
// Only a control node ever asks. A full deployment is its own relay and answers
// with its own address, which is what [App.signallingURL] already did and still
// does when nothing is listed here.
type relays struct {
	list   []config.Relay
	policy string

	// turn carries the round-robin position. Atomic because joins arrive
	// concurrently and the only thing this counter must not do is hand two
	// callers the same answer by losing an increment.
	turn atomic.Uint64
}

func newRelays(conf *config.Config) *relays {
	return &relays{list: conf.Meet.Relays, policy: conf.Meet.RelayPolicy}
}

// any reports whether there is anything to choose from.
func (r *relays) any() bool { return r != nil && len(r.list) > 0 }

// byName finds a relay a client named, and says whether it is one of ours.
//
// The whole of the trust boundary for the probe policy. A client sends a name
// it was given; anything else — a name from an older configuration, a guess, an
// address somebody hoped would be dialled — finds nothing and is ignored, which
// leaves the caller with the policy's fallback rather than with a meeting sent
// wherever they asked.
func (r *relays) byName(name string) (config.Relay, bool) {
	if name == "" {
		return config.Relay{}, false
	}

	for _, relay := range r.list {
		if relay.Name == name {
			return relay, true
		}
	}

	return config.Relay{}, false
}

// offered is the list a client is given to measure, addresses included.
//
// The addresses are public by construction: every one of them is handed to
// somebody the moment they join. What is not here is anything about the shape
// of the deployment — no counts, no health, no load — because this endpoint
// answers to anybody who asks.
func (r *relays) offered() []config.Relay {
	if r == nil {
		return nil
	}
	return r.list
}

// pick returns the relay for this room and this client.
//
// Room first and client second, because the room is what the policies are
// mostly about: gathering a meeting onto one relay is what keeps media from
// being carried twice, and that decision cannot depend on who is asking or the
// second person to join would land somewhere else.
//
// chosen is what a client measured and asked for, empty when it did not ask.
func (r *relays) pick(room string, chosen string, req *http.Request, trustProxy bool) config.Relay {
	switch {
	case len(r.list) == 1:
		// One relay is not a choice, and taking this early keeps the policies
		// below from having to be correct about a case with no alternatives.
		return r.list[0]

	case r.policy == config.PickProbe:
		// What the client measured, if it is one of ours. A name that is not
		// falls through to the room's own relay: an unmeasured client should
		// still land with the rest of their meeting.
		if relay, ok := r.byName(chosen); ok {
			return relay
		}
		return r.list[int(hashRoom(room)%uint64(len(r.list)))]

	case r.policy == config.PickRoundRobin:
		// Wraps on overflow, which is the behaviour wanted: the sequence is
		// what matters and it continues across the boundary.
		return r.list[int(r.turn.Add(1)-1)%len(r.list)]

	case r.policy == config.PickNearest:
		if region := clientRegion(req, trustProxy); region != "" {
			for _, relay := range r.list {
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
		return r.list[int(hashRoom(room)%uint64(len(r.list)))]
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
