package admin

import (
	"encoding/json"
	"net/http"
	"strings"
)

/*
Moving a meeting, and moving one person into it a different way.

A meeting lives on exactly one machine. The media server binds a room to
whichever node opened it and forwards everybody else there, and there is no
migration in it: a call cannot be handed from one node to another while it is
running, by this server or by anybody.

So "switch the server" has two honest meanings and they are different actions,
which is why both are offered rather than one being quietly chosen. Setting where
the room is held applies to the next call under that name and leaves the one in
progress alone — the right answer for a recurring meeting somebody wants held
somewhere better next time. Moving it now ends the call so everybody comes back,
and they come back to the machine that was chosen; that is disruptive and is said
so on the page, because a control that ends a meeting must not be pressed by
somebody who thought it would not.

Moving one person is the smaller of the two and, with forwarding, a real thing:
which relay somebody enters through is theirs alone, separate from where the room
is. It cannot be changed underneath them — a browser holds its connection to the
machine it dialled, and nothing in the protocol asks it to move. What can be done
is to record where they should come in next time and let go of them, which is
being removed with a reason. Said plainly rather than dressed up.
*/

// Placing is where a room should be held.
type Placing interface {
	HoldRoom(room, relay string) error
	HeldOn(room string) string
	PinEntry(room, identity, relay string) error
}

func (a *API) placeRoom(session Session, w http.ResponseWriter, r *http.Request) {
	if a.placing == nil {
		a.detached(w)
		return
	}

	name := strings.ToLower(r.PathValue("room"))

	var body struct {
		Relay string `json:"relay"`
		// Now ends the call so everybody comes back to the new machine. Absent,
		// the change waits for the next one.
		Now bool `json:"now"`
	}

	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil {
		refuse(w, http.StatusBadRequest, "unreadable")
		return
	}

	relay := strings.TrimSpace(body.Relay)

	// Checked against the list rather than taken on trust. A name nobody has
	// would be written down, believed at the next join, and found to be nothing
	// — at which point the room goes wherever the policy picks and the page
	// still says it is somewhere else.
	if !a.knownRelay(relay) {
		refuse(w, http.StatusBadRequest, "no_such_relay")
		return
	}

	if err := a.placing.HoldRoom(name, relay); err != nil {
		a.record(session, "place room", name, relay, err)
		refuse(w, http.StatusInternalServerError, "store_unavailable")
		return
	}

	a.record(session, "place room", name, relay, nil)

	if !body.Now {
		respond(w, map[string]any{"room": name, "relay": relay, "moved": false})
		return
	}

	// Ending it is what moves it. Everybody's client goes back to the front and
	// rejoins, and the note written a moment ago is what sends them to the new
	// machine — so the order matters, and it is the order above.
	if !a.attached() {
		a.detached(w)
		return
	}

	if err := a.control.Close(r.Context(), name); err != nil {
		a.record(session, "move room", name, relay, err)
		refuse(w, statusOf(err), reasonOf(err))
		return
	}

	a.record(session, "move room", name, relay, nil)

	respond(w, map[string]any{"room": name, "relay": relay, "moved": true})
}

func (a *API) placePerson(session Session, w http.ResponseWriter, r *http.Request) {
	if a.placing == nil {
		a.detached(w)
		return
	}

	name := strings.ToLower(r.PathValue("room"))
	identity := r.PathValue("identity")

	var body struct {
		Relay string `json:"relay"`
	}

	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil {
		refuse(w, http.StatusBadRequest, "unreadable")
		return
	}

	relay := strings.TrimSpace(body.Relay)

	if !a.knownRelay(relay) {
		refuse(w, http.StatusBadRequest, "no_such_relay")
		return
	}

	if err := a.placing.PinEntry(name, identity, relay); err != nil {
		a.record(session, "place person", name, identity, err)
		refuse(w, http.StatusInternalServerError, "store_unavailable")
		return
	}

	// And then let go of them, because nothing else will. A browser holds its
	// connection to the machine it dialled and there is no message in the
	// protocol that asks it to move; the only way somebody comes in through a
	// different door is by coming in again.
	if !a.attached() {
		a.detached(w)
		return
	}

	if err := a.control.Remove(r.Context(), name, identity); err != nil {
		a.record(session, "place person", name, identity, err)
		refuse(w, statusOf(err), reasonOf(err))
		return
	}

	a.record(session, "place person", name, identity, nil)

	respond(w, map[string]any{"room": name, "identity": identity, "relay": relay})
}

// knownRelay reports whether this is a relay this deployment has.
func (a *API) knownRelay(name string) bool {
	if name == "" || a.relays == nil {
		return false
	}

	list, err := a.relays.Relays()
	if err != nil {
		return false
	}

	for _, relay := range list {
		if relay.Name == name {
			return true
		}
	}

	return false
}
