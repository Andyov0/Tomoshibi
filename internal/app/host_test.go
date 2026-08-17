package app

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"tomoshibi/internal/config"
	"tomoshibi/internal/room"
	"tomoshibi/internal/store"
)

/*
Who may act on a room, and with what.

There are no sessions for people in a call, so the token this server signed is
the whole of the proof: it names one room and one identity and cannot be edited.
Everything below is a way of getting that wrong.

The one that would not look wrong in a diff is the room. The path names a room
and so does the grant, and using the path is the natural thing to write — it is
right there, it is a string, and every request where the two agree passes. The
requests where they disagree are the attack: a token for a meeting somebody was
invited to, replayed against a meeting they were not, muting whoever they like.

The rest are the ordinary ones. A guest is not the host. A host of one room is
not the host of another. And a room whose record predates hosts answers to
nobody, which must not be read as answering to everybody — that would make the
first person to ask the host of every old room on the deployment.
*/

// tokenFor mints a real join token, the way the join does.
func tokenFor(t *testing.T, name, passphrase string) (token, identity string) {
	t.Helper()

	grant, err := room.Authorise("APIkey", "a secret long enough for the media server to accept it",
		room.Request{
			Room: name, Display: "somebody", Passphrase: room.Passphrase(passphrase),
			TripKey: tripKey, TTL: time.Hour,
		})
	if err != nil {
		t.Fatal(err)
	}

	return grant.Token, grant.Identity
}

func hosted(t *testing.T) (http.Handler, *store.Store) {
	t.Helper()

	mux, st := controlWithStore(t, config.PickProbe,
		store.Relay{Name: "shanghai", URL: "wss://sh.example.invalid"},
	)

	return mux, st
}

// asking makes a request carrying a token.
func asking(method, path, token string, body string) *http.Request {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")

	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}

	return request
}

func TestATokenForOneRoomCannotActOnAnother(t *testing.T) {
	mux, st := hosted(t)

	if _, err := st.OpenRoom("theirs", true); err != nil {
		t.Fatal(err)
	}

	// The host of the room they are actually in.
	token, identity := tokenFor(t, "mine", "a passphrase of my own")

	mark, _ := room.SignatureOf(identity)

	if _, err := st.OpenRoom("mine", true); err != nil {
		t.Fatal(err)
	}

	if err := st.SetHost("mine", mark.Trip); err != nil {
		t.Fatal(err)
	}

	// And the host of the other one, so the request would succeed if the room
	// were read from the path.
	if err := st.SetHost("theirs", mark.Trip); err != nil {
		t.Fatal(err)
	}

	recorder := ask(mux, asking(http.MethodPost, "/api/rooms/theirs/mute", token,
		`{"identity":"somebody","track":"TR_x"}`))

	if recorder.Code != http.StatusForbidden {
		t.Errorf("a token for \"mine\" acted on \"theirs\" and got %d; a token would be a "+
			"key to every meeting its holder is host of, replayable against any of them",
			recorder.Code)
	}
}

func TestSomebodyWhoIsNotTheHostMayNotActOnTheRoom(t *testing.T) {
	mux, st := hosted(t)

	if _, err := st.OpenRoom("standup", true); err != nil {
		t.Fatal(err)
	}

	host, identity := tokenFor(t, "standup", "the host's passphrase")
	mark, _ := room.SignatureOf(identity)

	if err := st.SetHost("standup", mark.Trip); err != nil {
		t.Fatal(err)
	}

	guest, _ := tokenFor(t, "standup", "")

	for _, tc := range []struct {
		what         string
		method, path string
		body         string
		hostWants    int
		guestWants   int
	}{
		{"mute", http.MethodPost, "/api/rooms/standup/mute", `{"identity":"x","track":"TR_x"}`,
			http.StatusBadGateway, http.StatusForbidden},
		{"remove", http.MethodDelete, "/api/rooms/standup/people/gsomebody", "",
			http.StatusBadGateway, http.StatusForbidden},
		{"invite", http.MethodPost, "/api/rooms/standup/invites", "",
			http.StatusOK, http.StatusForbidden},
	} {
		if got := ask(mux, asking(tc.method, tc.path, guest, tc.body)).Code; got != tc.guestWants {
			t.Errorf("a guest %s and got %d, wanted %d; anybody in a call could quiet or "+
				"remove anybody else in it", tc.what, got, tc.guestWants)
		}

		// And the host is not refused, or the test above would pass on a server
		// that refuses everybody.
		if got := ask(mux, asking(tc.method, tc.path, host, tc.body)).Code; got != tc.hostWants {
			t.Errorf("the host %s and got %d, wanted %d", tc.what, got, tc.hostWants)
		}
	}
}

func TestARoomThatAnswersToNobodyDoesNotAnswerToEverybody(t *testing.T) {
	mux, st := hosted(t)

	// A record with no host, which is every room opened before hosts existed.
	if _, err := st.OpenRoom("standup", true); err != nil {
		t.Fatal(err)
	}

	token, _ := tokenFor(t, "standup", "somebody's passphrase")

	if got := ask(mux, asking(http.MethodPost, "/api/rooms/standup/invites", token, "")).Code; got != http.StatusForbidden {
		t.Errorf("a room with no host admitted the first person who asked, with %d; every "+
			"room on this deployment older than the feature would belong to whoever "+
			"opened its console first", got)
	}
}

func TestNoTokenIsNotAnInvitation(t *testing.T) {
	mux, st := hosted(t)

	if _, err := st.OpenRoom("standup", true); err != nil {
		t.Fatal(err)
	}

	for _, token := range []string{"", "not-a-token", "Bearer nonsense"} {
		recorder := ask(mux, asking(http.MethodPost, "/api/rooms/standup/invites", token, ""))

		if recorder.Code != http.StatusForbidden {
			t.Errorf("a request carrying %q minted an invite with %d", token, recorder.Code)
		}
	}
}
