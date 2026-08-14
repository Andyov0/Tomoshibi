package app

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"tomoshibi/internal/config"
	"tomoshibi/internal/limit"
	"tomoshibi/internal/room"
	"tomoshibi/internal/store"
)

/*
 * Who may open a room, at the one place anybody ever asks for one.
 *
 * There is no endpoint that creates a room, because there is no room to create.
 * A name is opened by being joined, which means this rule has exactly one place
 * to live and no second path around it — and it also means the rule cannot be
 * read anywhere but here, from a request that looks like every other join.
 *
 * The whole application is not stood up. The join handler reaches the
 * configuration, the store, the rate limiter and the signing key, and none of
 * the rest; a media server started to exercise a rule it has no part in would be
 * the reason this went untested.
 */

// The key that signs signatures. Any bytes will do — what matters is that the
// same ones are used to derive the administrator's trip below, exactly as a
// deployment derives it once and writes it into the configuration.
var tripKey = []byte("a key for the tests and nowhere else")

const passphrase = "the administrator's passphrase"

func mount(t *testing.T, admins []config.Admin) (*App, http.Handler) {
	t.Helper()

	st, err := store.Open(filepath.Join(t.TempDir(), "meet.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { st.Close() })

	app := &App{
		conf: &config.Config{
			Key:    "APIkey",
			Secret: "a secret long enough for the media server to accept it",
			Meet: config.Meet{
				TokenTTL:  5 * time.Minute,
				JoinRate:  1000,
				JoinBurst: 1000,
				Admins:    admins,
			},
		},
		store:   st,
		limit:   limit.New(1000, 1000, false),
		tripKey: tripKey,
	}

	// The two routes the join rule lives behind, written the way Handler writes
	// them: the room name arrives as a path value, and a handler called directly
	// would not have one.
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/rooms/{room}/join", app.join)
	mux.HandleFunc("GET /api/policy", app.policy)

	return app, mux
}

func administrator() config.Admin {
	return config.Admin{Trip: room.Trip(tripKey, passphrase), Name: "adam"}
}

// join asks for a room, with a passphrase or without one.
func join(name, said string) *http.Request {
	body := fmt.Sprintf(`{"name":"somebody","passphrase":%q}`, said)

	request := httptest.NewRequest(http.MethodPost, "/api/rooms/"+name+"/join",
		strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")

	return request
}

func ask(mux http.Handler, request *http.Request) *httptest.ResponseRecorder {
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, request)

	return recorder
}

// What every deployment does until somebody changes it.
func TestByDefaultAnybodyMayOpenARoom(t *testing.T) {
	_, mux := mount(t, nil)

	if code := ask(mux, join("standup", "")).Code; code != http.StatusOK {
		t.Errorf("joining an unused name answered %d, want 200", code)
	}
}

func TestUnderAdminsAnUnusedNameIsRefused(t *testing.T) {
	app, mux := mount(t, []config.Admin{administrator()})

	if err := app.store.SetOpening(room.ByAdmins); err != nil {
		t.Fatalf("SetOpening: %v", err)
	}

	recorder := ask(mux, join("standup", ""))

	if recorder.Code != http.StatusForbidden {
		t.Fatalf("an unused name answered %d, want 403", recorder.Code)
	}

	var refusal struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &refusal); err != nil {
		t.Fatalf("the refusal was not readable: %v", err)
	}
	if refusal.Error != reasonNotOpen {
		t.Errorf("refused with %q, want %q", refusal.Error, reasonNotOpen)
	}
}

// The signature the token was going to carry anyway, finally being looked at.
func TestUnderAdminsAnAdministratorOpensOne(t *testing.T) {
	app, mux := mount(t, []config.Admin{administrator()})

	if err := app.store.SetOpening(room.ByAdmins); err != nil {
		t.Fatalf("SetOpening: %v", err)
	}

	if code := ask(mux, join("standup", passphrase)).Code; code != http.StatusOK {
		t.Fatalf("an administrator was refused an unused name: %d", code)
	}

	// And having been opened, it is open to whoever comes next. This is the
	// difference between a policy about opening rooms and a policy about
	// joining them, and getting it wrong would put the second half of a meeting
	// outside while the first half is still in it.
	if code := ask(mux, join("standup", "")).Code; code != http.StatusOK {
		t.Errorf("somebody was refused a room that was already open: %d", code)
	}
}

// A passphrase that is somebody's and not an administrator's proves a name and
// nothing else. It is the ordinary case, and the one where a comparison written
// slightly wrong would open every door.
func TestAPassphraseThatIsNotAnAdministratorsOpensNothing(t *testing.T) {
	app, mux := mount(t, []config.Admin{administrator()})

	if err := app.store.SetOpening(room.ByAdmins); err != nil {
		t.Fatalf("SetOpening: %v", err)
	}

	for i, said := range []string{
		"some other passphrase",
		passphrase[:len(passphrase)-1], // one character short
		"",
		passphrase + " ", // trimmed before signing, so this one is the right one
	} {
		want := http.StatusForbidden
		if strings.TrimSpace(said) == passphrase {
			want = http.StatusOK
		}

		// A name of its own each time. Sharing one would mean the first
		// administrator through opened it for everybody after, and every
		// refusal that followed would be a pass.
		name := fmt.Sprintf("standup-%d", i)
		if code := ask(mux, join(name, said)).Code; code != want {
			t.Errorf("%q answered %d, want %d", said, code, want)
		}
	}
}

/*
 * A policy nobody could satisfy is not applied.
 *
 * Reachable only by editing a configuration file to remove the administrators
 * while the store still holds the stricter setting — at which point the pages
 * that could put it back have stopped existing too. Enforced literally, every
 * name nobody had used would be refused for the life of the deployment, and the
 * only clue would be people saying their meeting link does not work.
 */
func TestWithNobodyToOpenARoomAnybodyMay(t *testing.T) {
	app, mux := mount(t, nil)

	if err := app.store.SetOpening(room.ByAdmins); err != nil {
		t.Fatalf("SetOpening: %v", err)
	}

	if code := ask(mux, join("standup", "")).Code; code != http.StatusOK {
		t.Errorf("a policy nobody could satisfy refused a join: %d", code)
	}
}

/*
 * What the client is told, and what it is not.
 *
 * It needs the policy to say the right thing on the screen where a room name is
 * typed. It is never told whether the person at that screen is an administrator,
 * because answering that would be a way to test a guessed passphrase — an
 * unauthenticated one, quicker than the sign-in page that is rate limited for
 * exactly this reason.
 */
func TestThePolicyIsPublicAndSaysNothingAboutTheCaller(t *testing.T) {
	app, mux := mount(t, []config.Admin{administrator()})

	if err := app.store.SetOpening(room.ByAdmins); err != nil {
		t.Fatalf("SetOpening: %v", err)
	}

	recorder := ask(mux, httptest.NewRequest(http.MethodGet, "/api/policy", nil))

	if recorder.Code != http.StatusOK {
		t.Fatalf("the policy answered %d, want 200", recorder.Code)
	}

	var said map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &said); err != nil {
		t.Fatalf("the answer was not readable: %v", err)
	}

	if said["openedBy"] != string(room.ByAdmins) {
		t.Errorf("openedBy = %v, want %q", said["openedBy"], room.ByAdmins)
	}
	if len(said) != 1 {
		t.Errorf("the policy says more than who may open a room: %v", said)
	}
}

// A name the server would never accept is refused before any of this, so a
// misspelling cannot be mistaken for a room somebody is being kept out of.
func TestAnImpossibleNameIsStillJustAnImpossibleName(t *testing.T) {
	app, mux := mount(t, []config.Admin{administrator()})

	if err := app.store.SetOpening(room.ByAdmins); err != nil {
		t.Fatalf("SetOpening: %v", err)
	}

	if code := ask(mux, join("stand_up", "")).Code; code != http.StatusBadRequest {
		t.Errorf("an invalid name answered %d, want 400", code)
	}
}
