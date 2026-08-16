package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"tomoshibi/internal/config"
	"tomoshibi/internal/store"
)

/*
Whether picking a server does anything for the second person into a room.

For the first person it always did: an empty name is opened wherever they are
sent. For everybody after them it did nothing at all, and the reason is that a
meeting lives on one node — the media server binds a room to whoever opened it
and forwards the rest. This server used to settle that by discarding the choice
and sending them to the holder, which is defensible and was also the reason a
relay bought for the route into it could sit for a month carrying no calls.

So the choice is kept and the media is forwarded through it. That turns one
decision into three, and each of them is a way for this to be quietly wrong:

  - the client must still dial the relay it picked, or forwarding has nothing to
    forward through;
  - it must be given credentials for that relay and not for the holder, which is
    the mistake that reads correctly in a diff and fails only in a call;
  - a relay that will not forward must send them to the holder instead, because
    a client pointed at a TURN server that is not there gathers no candidates at
    all and never connects — worse than the behaviour this replaced.

The room record is the fixture here. It is what says where a meeting already is,
and every case below is really a question about what this server does with it.
*/

// where a relay has a TURN server and is allowed to use it.
func forwarder(name, url, turn string) store.Relay {
	return store.Relay{Name: name, URL: url, Turn: turn, Forwards: true}
}

// joinVia asks to join a room through a named relay and reads the answer.
func joinVia(t *testing.T, mux http.Handler, roomName, relay string) struct {
	URL     string `json:"url"`
	Relay   string `json:"relay"`
	Forward *struct {
		URL        string `json:"url"`
		Username   string `json:"username"`
		Credential string `json:"credential"`
	} `json:"forward"`
} {
	t.Helper()

	var answer struct {
		URL     string `json:"url"`
		Relay   string `json:"relay"`
		Forward *struct {
			URL        string `json:"url"`
			Username   string `json:"username"`
			Credential string `json:"credential"`
		} `json:"forward"`
	}

	body := `{"name":"somebody","relay":"` + relay + `"}`

	request := httptest.NewRequest(http.MethodPost, "/api/rooms/"+roomName+"/join",
		strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Host = "meet.example.com"

	recorder := ask(mux, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("join through %q answered %d: %s", relay, recorder.Code, recorder.Body)
	}

	if err := json.Unmarshal(recorder.Body.Bytes(), &answer); err != nil {
		t.Fatal(err)
	}

	return answer
}

func TestSomebodyJoiningARoomHeldElsewhereKeepsTheRelayTheyPicked(t *testing.T) {
	mux := control(t, config.PickProbe,
		forwarder("shanghai", "wss://sh.example.invalid", "sh.example.invalid:39219"),
		forwarder("guangzhou", "wss://gz.example.invalid", "gz.example.invalid:39219"),
	)

	// The first person opens it, which is what puts the meeting on a machine.
	opened := joinVia(t, mux, "standup", "guangzhou")
	if opened.Forward != nil {
		t.Error("the first person into a room was sent through a relay to reach the " +
			"relay they were already on; every call would pay a hop for nothing")
	}

	second := joinVia(t, mux, "standup", "shanghai")

	if second.URL != "wss://sh.example.invalid" {
		t.Fatalf("the second person was sent to %s after picking shanghai; the choice was "+
			"discarded, which is the whole fault this exists to fix", second.URL)
	}

	if second.Forward == nil {
		t.Fatal("no forwarding was offered for a room held on another machine; the media " +
			"would go straight past the relay that was picked, and it would carry none " +
			"of the call it was chosen for")
	}

	// The relay they dialled, not the one holding the room. Handing over the
	// holder's TURN would read correctly, connect, and quietly restore exactly
	// the behaviour being replaced.
	if !strings.Contains(second.Forward.URL, "sh.example.invalid:39219") {
		t.Errorf("media was pointed at %q, which is not the relay that was picked",
			second.Forward.URL)
	}

	if second.Forward.Username == "" || second.Forward.Credential == "" {
		t.Error("forwarding was offered with no credentials; the browser would gather " +
			"no candidates at all and the call would never connect")
	}
}

func TestARelayThatWillNotForwardSendsThemToTheRoomInstead(t *testing.T) {
	for _, tc := range []struct {
		why   string
		entry store.Relay
	}{
		{
			"whoever pays for it said no, which is a real answer: relaying costs " +
				"the machine two bytes for every one it carries",
			store.Relay{
				Name: "shanghai", URL: "wss://sh.example.invalid",
				Turn: "sh.example.invalid:39219", Forwards: false,
			},
		},
		{
			"it runs no TURN server, so there is nothing to point a browser at",
			store.Relay{
				Name: "shanghai", URL: "wss://sh.example.invalid", Forwards: true,
			},
		},
	} {
		mux := control(t, config.PickProbe,
			tc.entry,
			forwarder("guangzhou", "wss://gz.example.invalid", "gz.example.invalid:39219"),
		)

		joinVia(t, mux, "standup", "guangzhou")

		second := joinVia(t, mux, "standup", "shanghai")

		if second.Forward != nil {
			t.Errorf("%s: forwarding was offered anyway; the browser would be sent to a "+
				"TURN server that will not answer, gather nothing, and never connect", tc.why)
		}

		if second.URL != "wss://gz.example.invalid" {
			t.Errorf("%s: sent to %s rather than to the machine holding the room; with no "+
				"way to forward, that is a call that does not happen", tc.why, second.URL)
		}
	}
}

// A room nobody has been in for hours is not held anywhere, so the next person
// picks freely and pays no hop. This is the other half of the expiry: without
// it, forwarding would be permanent — every room would forward to the machine it
// first landed on, for good.
func TestAQuietRoomIsPickedAfreshRatherThanForwardedTo(t *testing.T) {
	mux, st := controlWithStore(t, config.PickProbe,
		forwarder("shanghai", "wss://sh.example.invalid", "sh.example.invalid:39219"),
		forwarder("guangzhou", "wss://gz.example.invalid", "gz.example.invalid:39219"),
	)

	joinVia(t, mux, "standup", "guangzhou")

	// Let go of, rather than waited out. What is being checked is that this
	// server reads the record on every join instead of deciding once.
	if err := st.ReleaseRoom("standup"); err != nil {
		t.Fatal(err)
	}

	fresh := joinVia(t, mux, "standup", "shanghai")

	if fresh.Forward != nil {
		t.Error("a room nobody had been in for hours still forwarded to where it used " +
			"to be; the hop would be paid forever and the choice would stop meaning " +
			"anything the second time a name was used")
	}

	if fresh.URL != "wss://sh.example.invalid" {
		t.Errorf("sent to %s rather than to the freshly picked relay", fresh.URL)
	}
}
