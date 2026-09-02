package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"tomoshibi/internal/room"
	"tomoshibi/internal/store"
)

// byInvitation shuts the door the way the deployment this was written for has
// it: the test store starts with no policy, which reads as anyone may join, and
// under that a stranger walks in whether or not anything was minted — so the
// two claims about the invite could not be told apart from nothing at all.
func byInvitation(t *testing.T, st *store.Store) {
	t.Helper()

	if err := st.SetJoining(room.ByInvitation); err != nil {
		t.Fatal(err)
	}
}

/*
What arranging a meeting has to guarantee, tested through the router.

Two of these are the whole reason the feature can be offered at all, and both
were found by reading the first design rather than the code:

An account must not be able to mint invitations to somebody else's room by
arranging a meeting on its name. The mint on beginning is keyed to the
arrangement's host, so the check has to be at the moment of arranging: a name
that already answers to another person is refused there.

And the host's own join is what begins the meeting — no other join does, and
theirs does not outside the window around the arranged time, or Monday's call
on a daily name would begin Thursday's meeting and hand out an invitation that
had expired before Thursday.

The rest is the shape of the door: who may arrange, what a stranger holding the
link is told, and that what they are told turns into a way in exactly when it
should.
*/

func arrangeAs(t *testing.T, mux http.Handler, cookie *http.Cookie, body string) *httptest.ResponseRecorder {
	t.Helper()

	request := httptest.NewRequest(http.MethodPost, "/api/meetings", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	if cookie != nil {
		request.AddCookie(cookie)
	}

	answer := httptest.NewRecorder()
	mux.ServeHTTP(answer, request)

	return answer
}

func joinArranged(t *testing.T, mux http.Handler, room, name string, cookie *http.Cookie, invite string) *httptest.ResponseRecorder {
	t.Helper()

	target := "/api/rooms/" + room + "/join"
	if invite != "" {
		target += "?invite=" + invite
	}

	request := httptest.NewRequest(http.MethodPost, target,
		strings.NewReader(`{"name":"`+name+`","relay":"shanghai"}`))
	request.Header.Set("Content-Type", "application/json")
	if cookie != nil {
		request.AddCookie(cookie)
	}

	answer := httptest.NewRecorder()
	mux.ServeHTTP(answer, request)

	return answer
}

func readMeeting(t *testing.T, mux http.Handler, token string, cookie *http.Cookie) (arrangement, int) {
	t.Helper()

	request := httptest.NewRequest(http.MethodGet, "/api/meetings/"+token, nil)
	if cookie != nil {
		request.AddCookie(cookie)
	}

	answer := httptest.NewRecorder()
	mux.ServeHTTP(answer, request)

	var said arrangement
	_ = json.Unmarshal(answer.Body.Bytes(), &said)

	return said, answer.Code
}

func soon() string {
	return time.Now().UTC().Add(10 * time.Minute).Format(time.RFC3339)
}

func TestArrangingNeedsAnAccountAndAValidAsk(t *testing.T) {
	mux, st := hosted(t)
	host := signedInAs(t, st, "ada", "adaadaadaa")

	if answer := arrangeAs(t, mux, nil, `{"room":"standup","at":"`+soon()+`"}`); answer.Code != http.StatusUnauthorized {
		t.Errorf("nobody signed in arranged a meeting: %d", answer.Code)
	}

	if answer := arrangeAs(t, mux, host, `{"room":"Not A Room!","at":"`+soon()+`"}`); answer.Code != http.StatusBadRequest {
		t.Errorf("a name the door would refuse was accepted: %d %s", answer.Code, answer.Body)
	}

	// A wall-clock time with no zone is a time in a zone somebody guessed.
	if answer := arrangeAs(t, mux, host, `{"room":"standup","at":"2030-01-01T10:00"}`); answer.Code != http.StatusBadRequest {
		t.Errorf("a time with no zone was accepted: %d", answer.Code)
	}

	past := time.Now().UTC().Add(-3 * time.Hour).Format(time.RFC3339)
	if answer := arrangeAs(t, mux, host, `{"room":"standup","at":"`+past+`"}`); answer.Code != http.StatusBadRequest {
		t.Errorf("a meeting three hours ago was accepted: %d", answer.Code)
	}

	if answer := arrangeAs(t, mux, host, `{"room":"standup","at":"`+soon()+`","relay":"nowhere"}`); answer.Code != http.StatusBadRequest {
		t.Errorf("a relay this deployment does not have was accepted: %d", answer.Code)
	}

	answer := arrangeAs(t, mux, host, `{"room":"Standup","at":"`+soon()+`","relay":"shanghai"}`)
	if answer.Code != http.StatusOK {
		t.Fatalf("arranging: %d %s", answer.Code, answer.Body)
	}

	var made arrangement
	if err := json.Unmarshal(answer.Body.Bytes(), &made); err != nil {
		t.Fatal(err)
	}

	if made.Token == "" || made.Room != "standup" || made.Relay != "shanghai" || !made.Mine || made.Started {
		t.Errorf("arranged = %+v; want a token, the lowered name, the relay, mine, and not started", made)
	}

	// One name, one pending meeting.
	if answer := arrangeAs(t, mux, host, `{"room":"standup","at":"`+soon()+`"}`); answer.Code != http.StatusConflict {
		t.Errorf("a second meeting on the name: %d, want 409", answer.Code)
	}

	// The host sees it in their list, with the link, and can read it back.
	request := httptest.NewRequest(http.MethodGet, "/api/meetings", nil)
	request.AddCookie(host)
	listed := httptest.NewRecorder()
	mux.ServeHTTP(listed, request)

	var mine struct{ Meetings []arrangement }
	_ = json.Unmarshal(listed.Body.Bytes(), &mine)

	if len(mine.Meetings) != 1 || mine.Meetings[0].Token != made.Token {
		t.Errorf("the host's list = %+v; want the one meeting with its link", mine.Meetings)
	}
}

func TestANameSomebodyElseHostsIsNotOnOffer(t *testing.T) {
	mux, st := hosted(t)
	bob := signedInAs(t, st, "bob", "bobbobbobb")
	ada := signedInAs(t, st, "ada", "adaadaadaa")

	// Bob opens the room, which makes him its host.
	if answer := joinArranged(t, mux, "daily", "Bob", bob, ""); answer.Code != http.StatusOK {
		t.Fatalf("bob joining: %d %s", answer.Code, answer.Body)
	}

	if answer := arrangeAs(t, mux, ada, `{"room":"daily","at":"`+soon()+`"}`); answer.Code != http.StatusForbidden {
		t.Errorf("ada arranged a meeting on bob's room: %d. That is the line between arranging a meeting and minting invitations to another person's room", answer.Code)
	}

	// Bob may, on his own room.
	if answer := arrangeAs(t, mux, bob, `{"room":"daily","at":"`+soon()+`"}`); answer.Code != http.StatusOK {
		t.Errorf("bob arranging on his own room: %d %s", answer.Code, answer.Body)
	}
}

/*
The whole of the guest's side, end to end through the real routes:

A stranger holding the link is told it has not begun, and their join is refused
because nothing has been minted. Somebody else's join does not begin it. The
host's join does — and from then on the link carries an invitation that lets
the stranger in.
*/
func TestTheHostsJoinBeginsTheMeetingAndOpensTheDoor(t *testing.T) {
	mux, st := hosted(t)
	byInvitation(t, st)
	host := signedInAs(t, st, "ada", "adaadaadaa")
	other := signedInAs(t, st, "bob", "bobbobbobb")

	answer := arrangeAs(t, mux, host, `{"room":"planning","at":"`+soon()+`","relay":"shanghai"}`)
	if answer.Code != http.StatusOK {
		t.Fatalf("arranging: %d %s", answer.Code, answer.Body)
	}

	var made arrangement
	_ = json.Unmarshal(answer.Body.Bytes(), &made)

	said, code := readMeeting(t, mux, made.Token, nil)
	if code != http.StatusOK || said.Started || said.Invite != "" {
		t.Fatalf("before anybody joined: %d %+v; want not started and no invite", code, said)
	}

	if said.Token != "" || said.Mine {
		t.Errorf("a stranger reading the link was told %+v; the token and ownership are the host's", said)
	}

	// Somebody else with an account walks in first. That does not begin the
	// meeting, whoever they are.
	if answer := joinArranged(t, mux, "planning", "Bob", other, ""); answer.Code != http.StatusOK {
		t.Fatalf("bob joining early: %d %s", answer.Code, answer.Body)
	}

	if said, _ := readMeeting(t, mux, made.Token, nil); said.Started {
		t.Fatal("somebody other than the host began the meeting by walking in")
	}

	// A stranger with the link and no invitation is turned away.
	if answer := joinArranged(t, mux, "planning", "Guest", nil, ""); answer.Code != http.StatusForbidden {
		t.Errorf("a stranger joined before the meeting began: %d %s", answer.Code, answer.Body)
	}

	// The host arrives.
	if answer := joinArranged(t, mux, "planning", "Ada", host, ""); answer.Code != http.StatusOK {
		t.Fatalf("the host joining: %d %s", answer.Code, answer.Body)
	}

	said, _ = readMeeting(t, mux, made.Token, nil)
	if !said.Started || said.Invite == "" {
		t.Fatalf("after the host joined: %+v; want started with an invite", said)
	}

	// Which is a real one.
	if answer := joinArranged(t, mux, "planning", "Guest", nil, said.Invite); answer.Code != http.StatusOK {
		t.Errorf("the invitation the link handed out did not open the door: %d %s", answer.Code, answer.Body)
	}

	// The room is now the arranger's, however early Bob was, and it is placed
	// where the arranger said.
	if got := st.HostOf("planning"); got != "adaadaadaa" {
		t.Errorf("host of the room = %q, want the arranger", got)
	}

	if held, placed := st.HeldOn("planning"); held != "shanghai" || !placed {
		t.Errorf("held on %q placed=%v; want the arranged relay as a deliberate placement", held, placed)
	}

	// The host reading their own link is told so, and the host joining again
	// changes nothing.
	if said, _ := readMeeting(t, mux, made.Token, host); !said.Mine {
		t.Error("the host reading their own link was not told it was theirs")
	}

	first := said.Invite
	if answer := joinArranged(t, mux, "planning", "Ada", host, ""); answer.Code != http.StatusOK {
		t.Fatalf("the host joining again: %d", answer.Code)
	}

	if said, _ := readMeeting(t, mux, made.Token, nil); said.Invite != first {
		t.Error("the host joining again replaced the invitation everybody already holds")
	}
}

func TestAJoinOutsideTheWindowDoesNotBeginTheMeeting(t *testing.T) {
	mux, st := hosted(t)
	host := signedInAs(t, st, "ada", "adaadaadaa")

	thursday := time.Now().UTC().Add(72 * time.Hour).Format(time.RFC3339)
	answer := arrangeAs(t, mux, host, `{"room":"standup","at":"`+thursday+`"}`)
	if answer.Code != http.StatusOK {
		t.Fatalf("arranging: %d %s", answer.Code, answer.Body)
	}

	var made arrangement
	_ = json.Unmarshal(answer.Body.Bytes(), &made)

	// Monday's call on the same name.
	if answer := joinArranged(t, mux, "standup", "Ada", host, ""); answer.Code != http.StatusOK {
		t.Fatalf("the host joining: %d", answer.Code)
	}

	if said, _ := readMeeting(t, mux, made.Token, nil); said.Started {
		t.Error("a join three days early began Thursday's meeting")
	}
}

func TestCancellingIsTheHostsAndWithdrawsTheInvite(t *testing.T) {
	mux, st := hosted(t)
	byInvitation(t, st)
	host := signedInAs(t, st, "ada", "adaadaadaa")
	other := signedInAs(t, st, "bob", "bobbobbobb")

	answer := arrangeAs(t, mux, host, `{"room":"retro","at":"`+soon()+`"}`)
	if answer.Code != http.StatusOK {
		t.Fatalf("arranging: %d %s", answer.Code, answer.Body)
	}

	var made arrangement
	_ = json.Unmarshal(answer.Body.Bytes(), &made)

	// Begun, so there is an invitation to withdraw.
	if answer := joinArranged(t, mux, "retro", "Ada", host, ""); answer.Code != http.StatusOK {
		t.Fatalf("the host joining: %d", answer.Code)
	}

	said, _ := readMeeting(t, mux, made.Token, nil)
	if said.Invite == "" {
		t.Fatal("no invite after the host joined")
	}

	cancel := func(cookie *http.Cookie) int {
		request := httptest.NewRequest(http.MethodDelete, "/api/meetings/"+made.ID, nil)
		request.AddCookie(cookie)
		answer := httptest.NewRecorder()
		mux.ServeHTTP(answer, request)

		return answer.Code
	}

	if code := cancel(other); code != http.StatusNotFound {
		t.Errorf("somebody else cancelled the meeting: %d", code)
	}

	if code := cancel(host); code != http.StatusNoContent {
		t.Errorf("the host cancelling: %d, want 204", code)
	}

	if _, code := readMeeting(t, mux, made.Token, nil); code != http.StatusNotFound {
		t.Errorf("a cancelled meeting's link answers %d, want 404", code)
	}

	// And the invitation it handed out no longer opens the door.
	if answer := joinArranged(t, mux, "retro", "Guest", nil, said.Invite); answer.Code != http.StatusForbidden {
		t.Errorf("the invitation of a cancelled meeting still opened the door: %d", answer.Code)
	}
}

func TestClosingTheRoomEndsItsMeeting(t *testing.T) {
	mux, st := hosted(t)
	host := signedInAs(t, st, "ada", "adaadaadaa")

	answer := arrangeAs(t, mux, host, `{"room":"townhall","at":"`+soon()+`"}`)
	if answer.Code != http.StatusOK {
		t.Fatalf("arranging: %d %s", answer.Code, answer.Body)
	}

	var made arrangement
	_ = json.Unmarshal(answer.Body.Bytes(), &made)

	if answer := joinArranged(t, mux, "townhall", "Ada", host, ""); answer.Code != http.StatusOK {
		t.Fatalf("the host joining: %d", answer.Code)
	}

	if err := st.End("townhall", time.Now().UTC()); err != nil {
		t.Fatal(err)
	}

	said, _ := readMeeting(t, mux, made.Token, nil)
	if !said.Ended || said.Invite != "" {
		t.Errorf("after the room closed the link says %+v; want ended and no invite", said)
	}
}

// A sweep drops what nobody can still be waiting for, in the same loop as
// everything else that is swept, so a forgotten arrangement does not outlive
// the deployment.
func TestForgottenMeetingsAreSwept(t *testing.T) {
	app, st := keeping(t, time.Hour)
	now := time.Now().UTC()

	if err := st.Arrange("tok", store.Meeting{ID: "old", Room: "old", At: now.Add(-48 * time.Hour), Host: "h"}, now.Add(-49*time.Hour)); err != nil {
		t.Fatal(err)
	}

	app.sweep()

	if _, err := st.Arranged("tok"); err == nil {
		t.Error("a meeting two days past its time survived the sweep")
	}
}
