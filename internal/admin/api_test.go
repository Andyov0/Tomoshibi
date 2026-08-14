package admin

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"tomoshibi/internal/config"
	"tomoshibi/internal/room"

	livekitconf "github.com/livekit/livekit-server/pkg/config"
	"github.com/livekit/protocol/livekit"
)

// The media server's own configuration, which the runtime and health panels
// read. Its zero value is enough; nothing here asserts on what it says.
func livekitDefaults() *livekitconf.Config {
	return &livekitconf.Config{}
}

/*
 * What these guard is the gate itself.
 *
 * The session tests beside them prove that a passphrase resolves to the right
 * capabilities. They say nothing about whether a request without one reaches an
 * endpoint, which is a different question and the only one an attacker asks.
 * The whole of this file was at zero coverage when it was written: every gate,
 * every handler, and the routing that decides which of them a path lands on.
 *
 * The endpoints below are exercised through a real router, because the mistake
 * this catches is not a wrong answer from a handler — it is a handler reachable
 * without going through the gate in front of it, and a handler tested directly
 * is tested with its gate removed.
 */

// A media server that is not there.
//
// Every reading answers with nothing and every action fails, which is the state
// these tests want: what is being checked is whether a request reaches a
// handler, not what the handler then finds.
type absent struct{}

func (absent) Stats() *livekit.NodeStats { return &livekit.NodeStats{} }

func (absent) Throughput() (float64, float64, time.Duration) { return 0, 0, 0 }

func (absent) Node() (string, string) { return "ND_test", "127.0.0.1" }

func (absent) Rooms(context.Context) ([]*livekit.Room, error) {
	return nil, errors.New("no media server")
}

func (absent) Participants(context.Context, string) ([]*livekit.ParticipantInfo, error) {
	return nil, errors.New("no media server")
}

func (absent) Remove(context.Context, string, string) error { return errors.New("no media server") }

func (absent) Mute(context.Context, string, string, string) error {
	return errors.New("no media server")
}

func (absent) Close(context.Context, string) error { return errors.New("no media server") }

func mount(t *testing.T, admins []config.Admin) (*API, http.Handler) {
	t.Helper()

	api := &API{
		conf:     &config.Config{Meet: config.Meet{Admins: admins}, LiveKit: livekitDefaults()},
		sessions: NewSessions(admins, key),
		media:    absent{},
		control:  absent{},
		log:      NewLog(),
		history:  NewHistory(),
		stop:     make(chan struct{}),
	}

	mux := http.NewServeMux()
	api.Mount(mux)

	return api, mux
}

/** Everything the management surface answers, and which capability it wants. */
var endpoints = []struct {
	method string
	path   string
	needs  string
}{
	{http.MethodGet, "/api/admin/now", config.Observe},
	{http.MethodGet, "/api/admin/history", config.Observe},
	{http.MethodGet, "/api/admin/rooms", config.Observe},
	{http.MethodGet, "/api/admin/rooms/x/participants", config.Observe},
	{http.MethodGet, "/api/admin/health", config.Observe},
	{http.MethodGet, "/api/admin/runtime", config.Observe},
	{http.MethodGet, "/api/admin/audit", config.Observe},
	{http.MethodDelete, "/api/admin/rooms/x", config.Moderate},
	{http.MethodDelete, "/api/admin/rooms/x/participants/y", config.Moderate},
	{http.MethodPost, "/api/admin/rooms/x/participants/y/mute", config.Moderate},
}

func TestNothingIsReachableWithoutASession(t *testing.T) {
	_, mux := mount(t, []config.Admin{{Trip: room.Trip(key, "correct"), Can: []string{config.Moderate}}})

	for _, endpoint := range endpoints {
		recorder := httptest.NewRecorder()
		mux.ServeHTTP(recorder, httptest.NewRequest(endpoint.method, endpoint.path, nil))

		if recorder.Code != http.StatusUnauthorized {
			t.Errorf("%s %s answered %d without a session, want 401",
				endpoint.method, endpoint.path, recorder.Code)
		}
	}
}

func TestACookieFromNowhereIsNotASession(t *testing.T) {
	_, mux := mount(t, []config.Admin{{Trip: room.Trip(key, "correct")}})

	request := httptest.NewRequest(http.MethodGet, "/api/admin/now", nil)
	request.AddCookie(&http.Cookie{Name: cookieName, Value: "invented"})

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusUnauthorized {
		t.Errorf("an invented cookie answered %d, want 401", recorder.Code)
	}
}

/*
 * The distinction the whole two-tier design exists for. An administrator listed
 * only to watch has to reach every reading and none of the actions, and the
 * place that can go wrong is the router rather than the rule: a handler
 * registered behind the wrong gate holds a correct rule that is never asked.
 */
func TestWatchingIsNotActing(t *testing.T) {
	api, mux := mount(t, []config.Admin{{Trip: room.Trip(key, "watcher"), Name: "watcher"}})

	_, token, ok := api.sessions.Open("watcher")
	if !ok {
		t.Fatal("the configured passphrase was refused")
	}

	for _, endpoint := range endpoints {
		request := httptest.NewRequest(endpoint.method, endpoint.path, strings.NewReader(`{}`))
		request.AddCookie(&http.Cookie{Name: cookieName, Value: token})

		recorder := httptest.NewRecorder()
		mux.ServeHTTP(recorder, request)

		if endpoint.needs == config.Moderate {
			if recorder.Code != http.StatusForbidden {
				t.Errorf("%s %s answered %d for somebody who may only watch, want 403",
					endpoint.method, endpoint.path, recorder.Code)
			}
			continue
		}

		// The reading endpoints reach a media server that is not there, so what
		// matters is that they were not refused: anything but 401 and 403 means
		// the gate let them through.
		if recorder.Code == http.StatusUnauthorized || recorder.Code == http.StatusForbidden {
			t.Errorf("%s %s refused somebody who may watch: %d",
				endpoint.method, endpoint.path, recorder.Code)
		}
	}
}

func TestSigningInAndOut(t *testing.T) {
	_, mux := mount(t, []config.Admin{{Trip: room.Trip(key, "correct"), Name: "adam"}})

	// In.
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, sign(`{"passphrase":"correct"}`))

	if recorder.Code != http.StatusOK {
		t.Fatalf("signing in answered %d, want 200", recorder.Code)
	}

	var who struct {
		Trip string   `json:"trip"`
		Can  []string `json:"can"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &who); err != nil {
		t.Fatalf("the answer was not readable: %v", err)
	}

	if who.Trip != room.Trip(key, "correct") {
		t.Errorf("signed in as %q", who.Trip)
	}

	// Listed with nothing, so watching and only watching.
	if len(who.Can) != 1 || who.Can[0] != config.Observe {
		t.Errorf("capabilities %v, want only %q", who.Can, config.Observe)
	}

	cookie := recorder.Result().Cookies()
	if len(cookie) == 0 {
		t.Fatal("no cookie was set")
	}

	// The cookie has to be unreadable by anything on the page and unwilling to
	// travel to another site, which is what stands in for a request token here.
	if !cookie[0].HttpOnly {
		t.Error("the session cookie is readable by script")
	}
	if cookie[0].SameSite != http.SameSiteStrictMode {
		t.Error("the session cookie would travel with a cross-site request")
	}

	// Out.
	out := httptest.NewRequest(http.MethodDelete, "/api/admin/session", nil)
	out.AddCookie(cookie[0])

	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, out)

	if recorder.Code != http.StatusNoContent {
		t.Errorf("signing out answered %d, want 204", recorder.Code)
	}

	// And the token it carried is spent.
	after := httptest.NewRequest(http.MethodGet, "/api/admin/now", nil)
	after.AddCookie(cookie[0])

	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, after)

	if recorder.Code != http.StatusUnauthorized {
		t.Errorf("a signed-out session still answered %d", recorder.Code)
	}
}

func TestTheWrongPassphraseSaysNothingUseful(t *testing.T) {
	api, mux := mount(t, []config.Admin{{Trip: room.Trip(key, "correct"), Name: "adam"}})

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, sign(`{"passphrase":"wrong"}`))

	if recorder.Code != http.StatusUnauthorized {
		t.Errorf("a wrong passphrase answered %d, want 401", recorder.Code)
	}

	if len(recorder.Result().Cookies()) != 0 {
		t.Error("a refused sign-in still set a cookie")
	}

	// A rejected passphrase is still a passphrase, and one of these logs is
	// going to be read by somebody it does not belong to.
	for _, entry := range api.log.Recent() {
		if strings.Contains(entry.Reason, "wrong") || strings.Contains(entry.Trip, "wrong") {
			t.Errorf("the audit log holds what was typed: %+v", entry)
		}
	}
}

func TestGuessingIsRefusedBeforeItIsChecked(t *testing.T) {
	_, mux := mount(t, []config.Admin{{Trip: room.Trip(key, "correct")}})

	// Past the ceiling on the endpoint as a whole, which is what an attacker
	// with many addresses runs into.
	for i := 0; i < overall+perAddress; i++ {
		mux.ServeHTTP(httptest.NewRecorder(), sign(`{"passphrase":"guess"}`))
	}

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, sign(`{"passphrase":"guess"}`))

	if recorder.Code != http.StatusTooManyRequests {
		t.Errorf("guessing answered %d after the limit, want 429", recorder.Code)
	}
}

/*
 * With nobody configured the surface does not exist. Not refused — absent, so
 * that the paths answer like any other address nobody claimed and there is
 * nothing to find.
 */
func TestWithNoAdministratorsThereIsNoSurface(t *testing.T) {
	api, mux := mount(t, nil)

	if api.Configured() {
		t.Error("a deployment with no administrators reports a management surface")
	}

	for _, endpoint := range append(endpoints, struct {
		method string
		path   string
		needs  string
	}{http.MethodPost, "/api/admin/session", ""}) {
		recorder := httptest.NewRecorder()
		mux.ServeHTTP(recorder, httptest.NewRequest(endpoint.method, endpoint.path, nil))

		if recorder.Code != http.StatusNotFound {
			t.Errorf("%s %s answered %d with nobody configured, want 404",
				endpoint.method, endpoint.path, recorder.Code)
		}
	}
}

func TestActionsAreRecordedAgainstWhoTookThem(t *testing.T) {
	trip := room.Trip(key, "moderator")
	api, mux := mount(t, []config.Admin{{Trip: trip, Name: "adam", Can: []string{config.Moderate}}})

	_, token, _ := api.sessions.Open("moderator")

	// Reaches a media server that is not there, which is the point: a refusal
	// is worth recording as much as a success, and by the same signature.
	request := httptest.NewRequest(http.MethodDelete, "/api/admin/rooms/somewhere", nil)
	request.AddCookie(&http.Cookie{Name: cookieName, Value: token})
	mux.ServeHTTP(httptest.NewRecorder(), request)

	var found bool
	for _, entry := range api.log.Recent() {
		if entry.Action == "close room" && entry.Room == "somewhere" {
			found = true
			if entry.Trip != trip {
				t.Errorf("recorded against %q, want %q", entry.Trip, trip)
			}
		}
	}

	if !found {
		t.Error("an action reached the media server and was not recorded")
	}
}

func sign(body string) *http.Request {
	request := httptest.NewRequest(http.MethodPost, "/api/admin/session", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")

	return request
}
