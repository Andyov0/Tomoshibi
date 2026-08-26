package admin

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"tomoshibi/internal/config"
	"tomoshibi/internal/room"
	"tomoshibi/internal/store"
)

/*
 * Moving somebody to another machine, and what they are told about it.
 *
 * There is no message in the protocol that asks a browser to move: it holds a
 * connection to the machine it dialled, and the only way somebody comes in
 * through a different door is by coming in again. So a person is moved by being
 * let go of — which is the same thing a host does to throw somebody out, and
 * produces the same disconnection code.
 *
 * Before this they were told nothing else, so an operator putting one person on
 * a healthier relay sent them a notice saying they had been removed from the
 * meeting, and a call that did not come back.
 *
 * The warning has to be addressed to them rather than said to the room, and
 * that is what this file is mostly about. A message on this topic arms a tab to
 * rejoin after the next disconnection; broadcast, it arms every tab in the
 * room, and the next time a host legitimately ended the meeting all of them
 * would quietly rebuild it. That fault has happened once here already, from the
 * other direction, and it is the reason Tell exists at all.
 */

// listening records what was said and to whom.
type listening struct {
	absent

	mu        sync.Mutex
	announced []string
	told      []string
}

func (l *listening) Announce(_ context.Context, room, topic string, data []byte) error {
	l.mu.Lock()
	defer l.mu.Unlock()

	l.announced = append(l.announced, room+"/"+topic+"/"+string(data))

	return nil
}

func (l *listening) Tell(_ context.Context, room, identity, topic string, data []byte) error {
	l.mu.Lock()
	defer l.mu.Unlock()

	l.told = append(l.told, room+"/"+identity+"/"+topic+"/"+string(data))

	return nil
}

// Letting go of somebody, and closing a room, both work here. absent refuses
// them, which is right for the tests it was written for and wrong for these:
// what is under test is what is said on the way to the disconnection, and a
// disconnection that never happens says nothing.
func (l *listening) Remove(context.Context, string, string) error { return nil }
func (l *listening) Close(context.Context, string) error          { return nil }

func (l *listening) said() ([]string, []string) {
	l.mu.Lock()
	defer l.mu.Unlock()

	return append([]string(nil), l.announced...), append([]string(nil), l.told...)
}

// A store that takes what it is given, so these tests are about what is said
// rather than about what is written down.
type placed struct{}

func (placed) HoldRoom(string, string) error         { return nil }
func (placed) HeldOn(string) (string, bool)          { return "", false }
func (placed) PlaceRoom(string, string) error        { return nil }
func (placed) PinEntry(string, string, string) error { return nil }

func moving(t *testing.T) (*listening, http.Handler, string) {
	t.Helper()

	admin := config.Admin{
		Trip: room.Trip(key, "moderator"), Name: "adam",
		Can: []string{config.Observe, config.Moderate},
	}
	heard := &listening{}

	api := &API{
		conf:     &config.Config{Meet: config.Meet{Admins: []config.Admin{admin}}, LiveKit: livekitDefaults()},
		sessions: NewSessions(func() []config.Admin { return []config.Admin{admin} }, key),
		media:    absent{},
		control:  heard,
		log:      NewLog(),
		store:    unwritten{},
		relays:   &listed{relays: []store.Relay{{Name: "tokyo", URL: "wss://jp.example"}}},
		placing:  placed{},
		history:  NewHistory(nil),
		stop:     make(chan struct{}),
	}

	mux := http.NewServeMux()
	api.Mount(mux)

	_, token, _ := api.sessions.Open("", "moderator")

	return heard, mux, cookieName + "=" + token
}

func place(t *testing.T, mux http.Handler, cookie, path, body string) *httptest.ResponseRecorder {
	t.Helper()

	request := httptest.NewRequest(http.MethodPut, path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Cookie", cookie)

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, request)

	return recorder
}

func TestMovingOnePersonWarnsThatPersonAndNobodyElse(t *testing.T) {
	heard, mux, cookie := moving(t)

	recorder := place(t, mux,
		cookie, "/api/admin/rooms/standup/participants/t9abc/relay", `{"relay":"tokyo"}`)

	if recorder.Code != http.StatusOK {
		t.Fatalf("placing somebody answered %d: %s", recorder.Code, recorder.Body.String())
	}

	announced, told := heard.said()

	// The whole point. Said to the room, this arms every tab in it.
	if len(announced) != 0 {
		t.Errorf("moving one person was announced to the room: %v", announced)
	}

	if len(told) != 1 {
		t.Fatalf("the person moved was told %d times, want once: %v", len(told), told)
	}

	if want := "standup/t9abc/placing/tokyo"; told[0] != want {
		t.Errorf("told %q, want %q", told[0], want)
	}
}

// And the other direction, which is a whole room and is a broadcast on purpose:
// everybody in it is going to the same machine.
func TestMovingARoomTellsEverybodyInIt(t *testing.T) {
	heard, mux, cookie := moving(t)

	// "now", because without it the room is written down as belonging to that
	// machine and goes there at the next call rather than this one — and a move
	// nobody is being disconnected for is a move nobody needs warning about.
	recorder := place(t, mux, cookie, "/api/admin/rooms/standup/relay", `{"relay":"tokyo","now":true}`)

	if recorder.Code != http.StatusOK {
		t.Fatalf("moving a room answered %d: %s", recorder.Code, recorder.Body.String())
	}

	announced, told := heard.said()

	if len(told) != 0 {
		t.Errorf("moving a room was addressed to somebody: %v", told)
	}

	if len(announced) != 1 || announced[0] != "standup/moving/tokyo" {
		t.Errorf("announced %v, want one standup/moving/tokyo", announced)
	}
}

// A relay this deployment does not have is refused before anybody is disturbed.
func TestMovingSomebodyToANonexistentRelayTellsNobody(t *testing.T) {
	heard, mux, cookie := moving(t)

	recorder := place(t, mux,
		cookie, "/api/admin/rooms/standup/participants/t9abc/relay", `{"relay":"atlantis"}`)

	if recorder.Code == http.StatusOK {
		t.Fatalf("an unknown relay was accepted")
	}

	var refusal struct {
		Error string `json:"error"`
	}
	_ = json.Unmarshal(recorder.Body.Bytes(), &refusal)

	announced, told := heard.said()
	if len(announced) != 0 || len(told) != 0 {
		t.Errorf("a refused move still said something: %v %v", announced, told)
	}
}
