package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"tomoshibi/internal/admin"
	"tomoshibi/internal/config"
	"tomoshibi/internal/limit"
	"tomoshibi/internal/store"
)

/*
What this file guards is the one property the split exists for: on a control
node, no part of a call touches the machine serving the page.

It is a property that would decay silently. Every route below is one somebody
could reasonably re-register while fixing something else — a proxy added back
"so the client has a fallback", a health endpoint mounted for a load balancer
that happens to forward signalling too — and the deployment would go on working
perfectly. Calls would still connect, nobody would report a fault, and the
control node would quietly be carrying media it was moved away from precisely so
it would not.

The bill is the only thing that would notice, a month later.

So these assert absence, which is unusual and deliberate: the signalling paths
must not resolve on a control node, and a join must never hand a client back to
the origin it was served from.
*/

// control builds a control node's real router: no media server, relays listed.
//
// Through Handler rather than by registering the routes a test wants, unlike
// mount above. What is being tested here is which routes exist at all, and a
// test that mounted its own would be asserting against its own arrangement.
func control(t *testing.T, policy string, relayList ...config.Relay) http.Handler {
	t.Helper()

	st, err := store.Open(filepath.Join(t.TempDir(), "meet.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { st.Close() })

	conf := &config.Config{
		Key:    "APIkey",
		Secret: "a secret long enough for the media server to accept it",
		Meet: config.Meet{
			Role:        config.RoleControl,
			Relays:      relayList,
			RelayPolicy: policy,
			TokenTTL:    5 * time.Minute,
			JoinRate:    1000,
			JoinBurst:   1000,
			SourceURL:   source,
		},
	}

	app := &App{
		conf:  conf,
		store: st,
		limit: limit.New(1000, 1000, false),
		// nil, which is what a control node has. Every use of it is guarded;
		// if one is not, these tests panic rather than quietly passing.
		media:   nil,
		web:     http.NotFoundHandler(),
		tripKey: tripKey,
		admin:   admin.New(conf, nil, st, tripKey),
		relays:  newRelays(conf),
		stop:    make(chan struct{}),
	}
	t.Cleanup(app.Close)

	return app.Handler()
}

// The heart of it. A control node must not answer on the paths a media server
// owns: not by proxying them, and not by serving the client's document for them
// either, which would be a 200 that looks like it worked.
func TestAControlNodeCarriesNoSignalling(t *testing.T) {
	mux := control(t, config.PickProbe,
		config.Relay{Name: "shanghai", URL: "wss://sh.example.invalid"},
		config.Relay{Name: "tokyo", URL: "wss://jp.example.invalid"},
	)

	for _, path := range []string{"/rtc", "/rtc/", "/rtc/validate", "/twirp/", "/twirp/livekit.RoomService/ListRooms"} {
		recorder := ask(mux, httptest.NewRequest(http.MethodGet, path, nil))

		if recorder.Code != http.StatusNotFound {
			t.Errorf("%s answered %d on a control node; signalling must not resolve here, "+
				"or media would be carried by the machine serving the page",
				path, recorder.Code)
		}
	}
}

// A relay is the other half of the same property: it must not serve the client,
// the joins, or the management pages. A relay that answered a join would be
// signing tokens against a store it does not keep.
func TestARelayCarriesNothingButMedia(t *testing.T) {
	conf := &config.Config{
		Key:    "APIkey",
		Secret: "a secret long enough for the media server to accept it",
		Meet: config.Meet{
			Role:      config.RoleRelay,
			JoinRate:  1000,
			JoinBurst: 1000,
			SourceURL: source,
		},
	}

	app := &App{
		conf: conf,
		// A relay keeps none of these. They are nil in the real thing too.
		store:   nil,
		limit:   limit.New(1000, 1000, false),
		media:   nil,
		web:     nil,
		tripKey: nil,
		admin:   admin.New(conf, nil, nil, nil),
		relays:  newRelays(conf),
		stop:    make(chan struct{}),
	}
	t.Cleanup(app.Close)

	mux := app.Handler()

	for _, tc := range []struct {
		method, path string
	}{
		{http.MethodPost, "/api/rooms/standup/join"},
		{http.MethodGet, "/api/deployment"},
		{http.MethodGet, "/api/relays"},
		{http.MethodGet, "/admin"},
		{http.MethodGet, "/admin/"},
		{http.MethodGet, "/"},
		{http.MethodGet, "/index.html"},
	} {
		recorder := ask(mux, httptest.NewRequest(tc.method, tc.path, nil))

		if recorder.Code != http.StatusNotFound {
			t.Errorf("%s %s answered %d on a relay; a relay carries media and must serve "+
				"none of the application", tc.method, tc.path, recorder.Code)
		}
	}

	// The one thing it does answer, because a client times it to decide which
	// relay to use, from a page served somewhere else.
	recorder := ask(mux, httptest.NewRequest(http.MethodGet, "/api/health", nil))
	if recorder.Code != http.StatusNoContent {
		t.Errorf("a relay answered its health endpoint with %d, wanted %d",
			recorder.Code, http.StatusNoContent)
	}

	if origin := recorder.Header().Get("Access-Control-Allow-Origin"); origin != "*" {
		t.Errorf("the health endpoint allowed origin %q; a browser on the control node's "+
			"page cannot time it without permission, so every relay would look unreachable "+
			"and the measurement would choose nothing", origin)
	}
}

// A join on a control node must send the client to a relay, never to itself.
//
// The request carries a Host, which is what signallingURL falls back to. If the
// relay list were ever skipped, the answer would be this origin — a working
// looking URL pointing at a machine running no media server, and a call that
// fails after appearing to be authorised.
func TestAJoinSendsTheClientToARelayAndNotToUs(t *testing.T) {
	relayList := []config.Relay{
		{Name: "shanghai", URL: "wss://sh.example.invalid"},
		{Name: "tokyo", URL: "wss://jp.example.invalid"},
	}

	for _, policy := range []string{
		config.PickSticky, config.PickNearest, config.PickRoundRobin, config.PickProbe,
	} {
		mux := control(t, policy, relayList...)

		request := httptest.NewRequest(http.MethodPost, "/api/rooms/standup/join",
			strings.NewReader(`{"name":"somebody"}`))
		request.Header.Set("Content-Type", "application/json")
		request.Host = "meet.example.com"

		recorder := ask(mux, request)
		if recorder.Code != http.StatusOK {
			t.Fatalf("policy %q: join answered %d: %s", policy, recorder.Code, recorder.Body)
		}

		var body struct {
			URL   string `json:"url"`
			Token string `json:"token"`
		}
		if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
			t.Fatalf("policy %q: %v", policy, err)
		}

		if strings.Contains(body.URL, "meet.example.com") {
			t.Errorf("policy %q sent the client to %s, which is the control node itself: "+
				"media would be carried by the machine serving the page", policy, body.URL)
		}

		found := false
		for _, relay := range relayList {
			if body.URL == relay.URL {
				found = true
			}
		}
		if !found {
			t.Errorf("policy %q sent the client to %s, which is not one of the relays",
				policy, body.URL)
		}

		if body.Token == "" {
			t.Errorf("policy %q authorised nobody", policy)
		}
	}
}

// The measurement decides which relay, and it must be the one the client named
// even when the room's own hash points elsewhere. This is the difference
// between "we support choosing" and "we ask and then ignore the answer".
func TestTheMeasuredRelayIsTheOneUsed(t *testing.T) {
	relayList := []config.Relay{
		{Name: "shanghai", URL: "wss://sh.example.invalid"},
		{Name: "tokyo", URL: "wss://jp.example.invalid"},
		{Name: "frankfurt", URL: "wss://de.example.invalid"},
	}

	for _, want := range relayList {
		mux := control(t, config.PickProbe, relayList...)

		request := httptest.NewRequest(http.MethodPost, "/api/rooms/standup/join",
			strings.NewReader(`{"name":"somebody","relay":"`+want.Name+`"}`))
		request.Header.Set("Content-Type", "application/json")

		recorder := ask(mux, request)
		if recorder.Code != http.StatusOK {
			t.Fatalf("join answered %d: %s", recorder.Code, recorder.Body)
		}

		var body struct {
			URL string `json:"url"`
		}
		if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}

		if body.URL != want.URL {
			t.Errorf("client measured %s as fastest and was sent to %s", want.Name, body.URL)
		}
	}
}

// What a client is given to measure. The addresses are here because a browser
// has to reach them; nothing about the shape of the deployment is.
func TestTheRelayListIsWhatAClientNeedsToMeasure(t *testing.T) {
	mux := control(t, config.PickProbe,
		config.Relay{Name: "shanghai", URL: "wss://sh.example.invalid", Region: "cn-east"},
		config.Relay{Name: "tokyo", URL: "wss://jp.example.invalid", Region: "jp"},
	)

	recorder := ask(mux, httptest.NewRequest(http.MethodGet, "/api/relays", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("/api/relays answered %d", recorder.Code)
	}

	var body relayListResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}

	if !body.Measure {
		t.Error("a probe deployment told the client not to measure, so every client would " +
			"fall back to the room's relay and the policy would do nothing")
	}

	if len(body.Relays) != 2 {
		t.Fatalf("offered %d relays, wanted 2", len(body.Relays))
	}

	for _, relay := range body.Relays {
		if relay.Name == "" || relay.URL == "" {
			t.Errorf("relay %+v is missing what a client needs to measure it and name it back",
				relay)
		}
	}
}

// Under any other policy a client should not be made to wait for measurements
// nobody will read.
func TestOnlyProbeAsksTheClientToMeasure(t *testing.T) {
	for _, policy := range []string{config.PickSticky, config.PickNearest, config.PickRoundRobin} {
		mux := control(t, policy,
			config.Relay{Name: "shanghai", URL: "wss://sh.example.invalid", Region: "cn-east"},
			config.Relay{Name: "tokyo", URL: "wss://jp.example.invalid", Region: "jp"},
		)

		recorder := ask(mux, httptest.NewRequest(http.MethodGet, "/api/relays", nil))

		var body relayListResponse
		if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}

		if body.Measure {
			t.Errorf("policy %q asked the client to measure, and would then ignore it", policy)
		}
	}
}
