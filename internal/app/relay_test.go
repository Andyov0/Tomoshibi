package app

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"tomoshibi/internal/config"
)

func relaysOf(policy string, list ...config.Relay) *relays {
	return &relays{list: list, policy: policy}
}

var (
	sh = config.Relay{Name: "shanghai", URL: "wss://sh.example.com", Region: "cn-east"}
	hk = config.Relay{Name: "hongkong", URL: "wss://hk.example.com", Region: "hk"}
	jp = config.Relay{Name: "tokyo", URL: "wss://jp.example.com", Region: "jp"}
)

// The property the whole sticky policy exists for: everybody who names the same
// room is sent to the same relay. Get this wrong and a meeting is split across
// machines that, without redis, cannot hear each other — and the symptom is two
// people in "the same" room staring at empty tiles.
func TestStickyKeepsARoomTogether(t *testing.T) {
	r := relaysOf(config.PickSticky, sh, hk, jp)

	for _, name := range []string{"standup", "one-on-one", "退屈", "a"} {
		first := r.pick(name, "", nil, false)

		for i := 0; i < 50; i++ {
			if got := r.pick(name, "", nil, false); got.URL != first.URL {
				t.Fatalf("room %q went to %s then %s: a meeting cannot be split",
					name, first.URL, got.URL)
			}
		}
	}
}

// Stability across processes, which is what lets two control nodes stand behind
// one address and what lets one be restarted in the middle of a meeting.
//
// Written against fixed numbers rather than by comparing two instances, because
// comparing instances does not test this. A seeded hash is seeded once per
// process, so two instances inside one test agree with each other perfectly and
// disagree with the next process — which is precisely the fault, and it passes.
// That version of this test was written first and caught nothing: swapping FNV
// for maphash left it green.
//
// These are FNV-1a/64 of the name. If a change here is deliberate, every
// deployment running more than one control node has to be restarted together,
// because until they are the two halves of a meeting will be sent to different
// relays.
func TestStickyIsStableAcrossProcesses(t *testing.T) {
	for _, tc := range []struct {
		room string
		want uint64
	}{
		{"standup", 785736587849392022},
		{"retro", 1602353422691474863},
		{"1", 12638134423997487868},
		{"zzzzzzzz", 1790959236010823653},
		{"", 14695981039346656037},
		{"退屈", 9797011586680834698},
	} {
		if got := hashRoom(tc.room); got != tc.want {
			t.Errorf("hashRoom(%q) = %d, wanted %d. Rooms will move between relays "+
				"across a restart", tc.room, got, tc.want)
		}
	}
}

// Different rooms should not all pile onto one relay. Not a guarantee the hash
// can make for any particular pair, so this asks the weaker thing that actually
// matters: over many names, every relay is used.
func TestStickySpreadsRoomsAcrossRelays(t *testing.T) {
	r := relaysOf(config.PickSticky, sh, hk, jp)

	used := map[string]int{}
	for _, name := range []string{
		"alpha", "bravo", "charlie", "delta", "echo", "foxtrot",
		"golf", "hotel", "india", "juliet", "kilo", "lima",
	} {
		used[r.pick(name, "", nil, false).URL]++
	}

	if len(used) != 3 {
		t.Fatalf("twelve rooms reached %d of 3 relays: %v", len(used), used)
	}
}

func TestNearestPrefersAMatchingRegion(t *testing.T) {
	r := relaysOf(config.PickNearest, sh, hk, jp)

	for _, tc := range []struct{ region, want string }{
		{"hk", hk.URL},
		{"jp", jp.URL},
		{"cn-east", sh.URL},
		// Case is a label somebody typed in two places; it should not decide
		// which continent a client is sent to.
		{"HK", hk.URL},
	} {
		req := httptest.NewRequest(http.MethodPost, "/api/rooms/x/join", nil)
		req.Header.Set(headerRegion, tc.region)

		if got := r.pick("x", "", req, true); got.URL != tc.want {
			t.Errorf("region %q went to %s, wanted %s", tc.region, got.URL, tc.want)
		}
	}
}

// An unknown region must fall back to sticky rather than to the first entry.
// Falling to the first would quietly gather every unlabelled client onto one
// relay, which is both a hotspot and a meeting split from the labelled half.
func TestNearestFallsBackToSticky(t *testing.T) {
	r := relaysOf(config.PickNearest, sh, hk, jp)

	req := httptest.NewRequest(http.MethodPost, "/api/rooms/x/join", nil)
	req.Header.Set(headerRegion, "antarctica")

	sticky := relaysOf(config.PickSticky, sh, hk, jp)

	for _, name := range []string{"standup", "retro", "alpha"} {
		if got, want := r.pick(name, "", req, true), sticky.pick(name, "", nil, false); got.URL != want.URL {
			t.Errorf("room %q with an unknown region went to %s, wanted the sticky choice %s",
				name, got.URL, want.URL)
		}
	}
}

// The region header is a claim, and an unproxied deployment has nobody to
// overwrite it. Believing it there would make the setting mean one thing behind
// a proxy and another in front of one.
func TestRegionIsIgnoredWithoutTrustProxy(t *testing.T) {
	r := relaysOf(config.PickNearest, sh, hk, jp)

	req := httptest.NewRequest(http.MethodPost, "/api/rooms/x/join", nil)
	req.Header.Set(headerRegion, "jp")

	sticky := relaysOf(config.PickSticky, sh, hk, jp)

	if got, want := r.pick("standup", "", req, false), sticky.pick("standup", "", nil, false); got.URL != want.URL {
		t.Fatalf("an untrusted region header chose %s; without trust_proxy it should be "+
			"ignored and give the sticky choice %s", got.URL, want.URL)
	}
}

func TestCloudflareCountryIsAccepted(t *testing.T) {
	r := relaysOf(config.PickNearest, sh, hk, jp)

	req := httptest.NewRequest(http.MethodPost, "/api/rooms/x/join", nil)
	req.Header.Set(headerCountry, "jp")

	if got := r.pick("x", "", req, true); got.URL != jp.URL {
		t.Fatalf("CF-IPCountry jp went to %s, wanted %s", got.URL, jp.URL)
	}
}

func TestRoundRobinVisitsEveryRelayInTurn(t *testing.T) {
	r := relaysOf(config.PickRoundRobin, sh, hk, jp)

	seen := map[string]int{}
	for i := 0; i < 9; i++ {
		seen[r.pick("same-room-every-time", "", nil, false).URL]++
	}

	for _, relay := range []config.Relay{sh, hk, jp} {
		if seen[relay.URL] != 3 {
			t.Errorf("%s was chosen %d times in nine turns, wanted 3: %v",
				relay.Name, seen[relay.URL], seen)
		}
	}
}

func TestProbeHonoursWhatTheClientMeasured(t *testing.T) {
	r := relaysOf(config.PickProbe, sh, hk, jp)

	for _, relay := range []config.Relay{sh, hk, jp} {
		if got := r.pick("standup", relay.Name, nil, false); got.URL != relay.URL {
			t.Errorf("client measured %s as fastest and was sent to %s", relay.Name, got.URL)
		}
	}
}

// The trust boundary. A client sends a name, and a name that is not one of ours
// buys nothing: not an address of the caller's choosing, and not an error either
// — they land on the room's own relay like anybody who did not measure.
//
// The addresses below are what an attacker would try if the field were ever
// read as a URL, which is exactly why it is not.
func TestProbeIgnoresARelayWeDoNotHave(t *testing.T) {
	r := relaysOf(config.PickProbe, sh, hk, jp)
	sticky := relaysOf(config.PickSticky, sh, hk, jp)

	for _, claimed := range []string{
		"wss://attacker.example.com",
		"ws://127.0.0.1:7880",
		"osaka",
		"SHANGHAI",
		"shanghai ",
		"",
	} {
		want := sticky.pick("standup", "", nil, false)

		if got := r.pick("standup", claimed, nil, false); got.URL != want.URL {
			t.Errorf("a client claiming relay %q was sent to %s, wanted the sticky choice %s",
				claimed, got.URL, want.URL)
		}
	}
}

// A measurement is only listened to under probe. Under the others it is a field
// the client filled in that the deployment has decided not to act on, and
// honouring it would quietly defeat whichever policy was configured.
func TestOtherPoliciesIgnoreAMeasurement(t *testing.T) {
	for _, policy := range []string{config.PickSticky, config.PickNearest} {
		r := relaysOf(policy, sh, hk, jp)
		sticky := relaysOf(config.PickSticky, sh, hk, jp)

		want := sticky.pick("standup", "", nil, false)

		// Naming the relay the sticky hash did not choose, so that a policy
		// which wrongly honoured it would visibly differ.
		other := hk.Name
		if want.Name == hk.Name {
			other = jp.Name
		}

		if got := r.pick("standup", other, nil, false); got.URL != want.URL {
			t.Errorf("policy %q honoured a measurement naming %s and chose %s, wanted %s",
				policy, other, got.URL, want.URL)
		}
	}
}

// One relay is not a choice, whatever the policy says. This is the case a
// deployment starts in, and every policy has to survive it.
func TestASingleRelayIsAlwaysChosen(t *testing.T) {
	for _, policy := range []string{config.PickSticky, config.PickNearest, config.PickRoundRobin, config.PickProbe} {
		r := relaysOf(policy, sh)

		if got := r.pick("anything", "", nil, false); got.URL != sh.URL {
			t.Errorf("policy %q with one relay chose %s", policy, got.URL)
		}
	}
}

func TestNoRelaysMeansNothingToChoose(t *testing.T) {
	if relaysOf(config.PickSticky).any() {
		t.Error("an empty list reported that it had relays")
	}

	if (*relays)(nil).any() {
		t.Error("a nil relays reported that it had relays")
	}
}
