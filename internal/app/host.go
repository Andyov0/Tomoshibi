package app

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/livekit/protocol/auth"

	"tomoshibi/internal/admin"
	"tomoshibi/internal/room"
)

/*
The person a room answers to.

Every meeting eventually needs somebody who can quiet it. Not moderation in the
management sense — that belongs to whoever runs the deployment and is behind a
different door — but the ordinary business of a call: a microphone left open in a
noisy room, somebody who will not leave, a meeting whose owner has gone home and
handed it on.

Until now the only person who could do any of that was an administrator of the
whole deployment, which is the wrong shape twice over. It gives somebody running
one meeting nothing, and it means the only way to give them something is to hand
them every room, every relay and every account.

So the room has a host: whoever first spoke its name, because there is nobody
else it could reasonably be, and transferable, because the person who opened a
recurring meeting is not always the person running it. An administrator is a host
everywhere, which is not a special case so much as what being an administrator
already meant.

Proof is the token. There are no sessions for people in a call — a join is
stateless and deliberately so — but the token this server signed for them names
one room and one identity and cannot be edited, which is exactly the claim these
requests need. Sending a passphrase back would be the alternative and a bad one:
it would put a credential on the wire for every mute.
*/

// mountHost registers what a host may do.
func (a *App) mountHost(mux *http.ServeMux) {
	if a.store == nil {
		return
	}

	mux.HandleFunc("GET /api/rooms/{room}/host", a.whoseRoom)
	mux.HandleFunc("POST /api/rooms/{room}/host", a.handOver)
	mux.HandleFunc("POST /api/rooms/{room}/mute", a.quieten)
	mux.HandleFunc("DELETE /api/rooms/{room}/people/{identity}", a.turnOut)
	mux.HandleFunc("POST /api/rooms/{room}/close", a.dissolve)
}

// bearer is who a request proves it is, from the token it carries.
type bearer struct {
	Identity string
	Room     string
	Mark     room.Signature
}

// whoIs reads the token a request carries and says who it belongs to.
//
// Verified against the same credentials that signed it, so nothing here trusts
// a field the caller filled in. The room is taken from the grant rather than
// from the path: a token for one meeting must not act on another, and comparing
// the two is the whole of that guarantee.
func (a *App) whoIs(r *http.Request) (bearer, bool) {
	raw := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if raw == "" || raw == r.Header.Get("Authorization") {
		return bearer{}, false
	}

	verifier, err := auth.ParseAPIToken(raw)
	if err != nil {
		return bearer{}, false
	}

	if verifier.APIKey() != a.conf.Key {
		return bearer{}, false
	}

	_, grants, err := verifier.Verify(a.conf.Secret)
	if err != nil || grants == nil || grants.Video == nil {
		return bearer{}, false
	}

	mark, _ := room.SignatureOf(grants.Identity)

	return bearer{Identity: grants.Identity, Room: grants.Video.Room, Mark: mark}, true
}

// mayHost reports whether this request may act on this room.
//
// Two ways in, and the second is not a courtesy: an administrator locked out of
// a room they can already close from the management pages would be an
// inconsistency somebody would work around by closing it.
func (a *App) mayHost(r *http.Request, name string) (bearer, bool) {
	who, ok := a.whoIs(r)
	if !ok || who.Room != name {
		return bearer{}, false
	}

	if a.isAdministrator(who.Mark) {
		return who, true
	}

	host := a.store.HostOf(name)

	// A room with no host answers to nobody. That is not the same as answering
	// to everybody, and reading it that way would make the first person to ask
	// the host of any room whose record predates this.
	return who, host != "" && host == who.Mark.Trip
}

// isAdministrator reports whether a mark is one, without a management session.
func (a *App) isAdministrator(mark room.Signature) bool {
	if !mark.Proven {
		return false
	}

	for _, one := range a.administrators() {
		if one.Trip == mark.Trip {
			return true
		}
	}

	return false
}

func (a *App) whoseRoom(w http.ResponseWriter, r *http.Request) {
	name := strings.ToLower(r.PathValue("room"))

	who, ok := a.whoIs(r)
	if !ok || who.Room != name {
		fail(w, http.StatusUnauthorized, reasonNotYours)
		return
	}

	host := a.store.HostOf(name)

	respond(w, map[string]any{
		"host": host,
		// Whether the person asking is it, worked out here rather than left to
		// the client to compare: the client would have to be told the host's
		// mark to make the comparison, and a mark is somebody's identity in
		// every room on this deployment.
		"yours": a.isAdministrator(who.Mark) || (host != "" && host == who.Mark.Trip),
		"admin": a.isAdministrator(who.Mark),
	})
}

func (a *App) handOver(w http.ResponseWriter, r *http.Request) {
	name := strings.ToLower(r.PathValue("room"))

	who, ok := a.mayHost(r, name)
	if !ok {
		fail(w, http.StatusForbidden, reasonNotYours)
		return
	}

	var body struct {
		To string `json:"to"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body)

	// Named by identity and stored by mark. The client is looking at a roster of
	// identities and has no business being told anybody's mark — a mark is who
	// somebody is in every room here, and a page that listed them would be
	// handing out the thing the whole scheme rests on.
	mark, valid := room.SignatureOf(strings.TrimSpace(body.To))
	if !valid {
		fail(w, http.StatusBadRequest, reasonNoSuchPerson)
		return
	}

	if err := a.store.SetHost(name, mark.Trip); err != nil {
		slog.Error("failed to hand over a room", "room", name, "error", err)
		fail(w, http.StatusInternalServerError, reasonServerError)
		return
	}

	slog.Info("room handed over", "room", name, "from", who.Mark.Trip, "to", mark.Trip)

	respond(w, map[string]any{"host": mark.Trip})
}

func (a *App) quieten(w http.ResponseWriter, r *http.Request) {
	name := strings.ToLower(r.PathValue("room"))

	if _, ok := a.mayHost(r, name); !ok {
		fail(w, http.StatusForbidden, reasonNotYours)
		return
	}

	var body struct {
		Identity string `json:"identity"`
		Track    string `json:"track"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body)

	if err := a.acting(r, func(control admin.Control) error {
		return control.Mute(r.Context(), name, body.Identity, body.Track)
	}); err != nil {
		fail(w, http.StatusBadGateway, reasonMediaUnreachable)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func (a *App) turnOut(w http.ResponseWriter, r *http.Request) {
	name := strings.ToLower(r.PathValue("room"))

	who, ok := a.mayHost(r, name)
	if !ok {
		fail(w, http.StatusForbidden, reasonNotYours)
		return
	}

	identity := r.PathValue("identity")

	// Removing oneself is leaving, and the button for that is elsewhere. Refused
	// here because a host who did it would leave a room with a host who is not
	// in it and nobody able to take over.
	if identity == who.Identity {
		fail(w, http.StatusBadRequest, reasonNoSuchPerson)
		return
	}

	if err := a.acting(r, func(control admin.Control) error {
		return control.Remove(r.Context(), name, identity)
	}); err != nil {
		fail(w, http.StatusBadGateway, reasonMediaUnreachable)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// dissolve ends the meeting for everybody at once.
//
// The one control here that is not about a person. Removing somebody is a
// judgement about them; this is the host saying the meeting is over, and it has
// to reach everybody — a host who leaves a room they cannot close leaves a
// meeting that goes on without them, under a name they will use again next week.
//
// Three things happen and the order is the point. The links go first, because an
// invite outliving the room it was to would be a way back into a name the host
// deliberately ended — and a room here is a name, so the next meeting held under
// it would inherit them. The room record lets go of its relay, so nothing sends
// the next person to a machine that is no longer holding anything. And the media
// server ends the room last, which is what actually disconnects everybody, with
// a reason their client can tell apart from being removed.
func (a *App) dissolve(w http.ResponseWriter, r *http.Request) {
	name := strings.ToLower(r.PathValue("room"))

	who, ok := a.mayHost(r, name)
	if !ok {
		fail(w, http.StatusForbidden, reasonNotYours)
		return
	}

	if gone, err := a.store.DropInvites(name); err != nil {
		slog.Error("failed to drop the invites to a closed room", "room", name, "error", err)
	} else if gone > 0 {
		slog.Info("dropped invites to a closed room", "room", name, "gone", gone)
	}

	if err := a.store.ReleaseRoom(name); err != nil {
		slog.Error("failed to release a closed room", "room", name, "error", err)
	}

	if err := a.acting(r, func(control admin.Control) error {
		return control.Close(r.Context(), name)
	}); err != nil {
		// Said out loud, because the two halves have come apart: the links are
		// gone and the meeting is not. Whoever pressed this is looking at a room
		// that did not close, and the honest answer is that it did not.
		slog.Error("failed to close a room", "room", name, "error", err)
		fail(w, http.StatusBadGateway, reasonMediaUnreachable)
		return
	}

	slog.Info("room closed", "room", name, "by", who.Mark.Trip)

	w.WriteHeader(http.StatusNoContent)
}

// acting runs something against whichever media server is holding the rooms.
//
// The same one the management pages use, because there is only one and because
// having two ways to reach it is how they come to disagree. Nil where a
// deployment holds no media at all, which is a refusal rather than a panic.
func (a *App) acting(_ *http.Request, do func(admin.Control) error) error {
	control := a.control
	if control == nil {
		return errors.New("no media server to act on")
	}

	return do(control)
}

// hostOnOpening records who a freshly opened room answers to.
//
// Called on every join and does nothing on all but the first, because a room
// that already has a host is not looking for one — a later arrival becoming host
// by walking in is the fault this guards against, and it would be invisible
// until somebody used it.
func (a *App) hostOnOpening(name string, grant room.Grant) {
	if a.store.HostOf(name) != "" {
		return
	}

	mark, ok := room.SignatureOf(grant.Identity)
	if !ok {
		return
	}

	if err := a.store.SetHost(name, mark.Trip); err != nil {
		slog.Error("failed to record who opened a room", "room", name, "error", err)
	}
}
