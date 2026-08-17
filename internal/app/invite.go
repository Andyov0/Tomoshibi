package app

import (
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"tomoshibi/internal/store"
)

/*
Being let into one meeting without being given anything else.

The two ways in are otherwise both about knowing something: a passphrase, or a
room name nobody has told anybody else. Neither suits somebody invited to a
single call. A passphrase is an account. And a room name is worse than it looks —
a room here is a name and nothing else, so handing over the name of a recurring
meeting hands over every future instance of it, for good, to whoever the link
reaches after them.

An invite carries neither. It names one room, it stops working, and whoever
redeems it gets an issued mark: a signature drawn from nothing, which says only
that they are not the other people in the call. That is the honest description of
a guest and it is all that should be claimed for one.

How long it lasts is a day, and how many people it admits is one. Both are the
answer to "what would somebody be surprised by", rather than to "what is most
flexible": a link pasted into a group chat should let in the person it was meant
for, and a link found in an old message should not work at all.
*/

// The ceiling on an invite, which is not the rule.
//
// The rule is the meeting: while the room is running the link works, and when it
// ends the link is worth nothing. This is the backstop under that, because
// "while the room is running" is answered by asking the media server and a link
// should not outlive that conversation being possible. A day, because a meeting
// invited to on Monday for Tuesday is ordinary and a link found in a message
// from March should be dead however the asking went.
const inviteFor = 24 * time.Hour

// The cookie a redeemed invite leaves behind.
//
// Not a credential and not an account: it holds the token that was spent, so
// that a reload does not have to spend another. Without it a guest who refreshed
// would be turned away by the very thing that let them in.
const inviteCookie = "meet-live.invite"

func (a *App) mountInvites(mux *http.ServeMux) {
	if a.store == nil {
		return
	}

	mux.HandleFunc("POST /api/rooms/{room}/invites", a.makeInvite)
	mux.HandleFunc("DELETE /api/rooms/{room}/invites", a.revokeInvites)
	mux.HandleFunc("GET /api/invites/{token}", a.readInvite)
	mux.HandleFunc("GET /api/rooms/{room}/live", a.roomLive)
}

// makeInvite mints one, for somebody already in the room.
//
// Only the host, and an administrator anywhere. Anybody in a call being able to
// mint links to it would make the single-use limit meaningless — one guest could
// let in the rest of the internet, one at a time — and it is the host who is
// answerable for who is in their meeting.
func (a *App) makeInvite(w http.ResponseWriter, r *http.Request) {
	name := strings.ToLower(r.PathValue("room"))

	who, ok := a.mayHost(r, name)
	if !ok {
		fail(w, http.StatusForbidden, reasonNotYours)
		return
	}

	token, err := store.NewInviteToken()
	if err != nil {
		fail(w, http.StatusInternalServerError, reasonServerError)
		return
	}

	now := time.Now().UTC()

	if err := a.store.KeepInvite(token, store.Invite{
		Room: name, By: who.Mark.Trip, Created: now, Expires: now.Add(inviteFor),
	}); err != nil {
		fail(w, http.StatusInternalServerError, reasonServerError)
		return
	}

	// Returned once and never again. What the store holds is the token's hash,
	// on the same reasoning as a session: a copy of the database is not a set of
	// working invitations.
	respond(w, map[string]any{
		"token":   token,
		"room":    name,
		"expires": now.Add(inviteFor).Format(time.RFC3339),
	})
}

// revokeInvites throws away every link to a room, without ending the meeting.
//
// The other way a link dies is the room being closed, which is a bigger thing
// than anybody wants to do about a link they pasted into the wrong window. This
// is that: the meeting carries on, and the link somebody sent stops working.
//
// All of them rather than one, because that is what revoking means to whoever
// presses it. A host who minted two links and killed only the newer one would
// have revoked nothing, and would have no way of knowing.
func (a *App) revokeInvites(w http.ResponseWriter, r *http.Request) {
	name := strings.ToLower(r.PathValue("room"))

	who, ok := a.mayHost(r, name)
	if !ok {
		fail(w, http.StatusForbidden, reasonNotYours)
		return
	}

	gone, err := a.store.DropInvites(name)
	if err != nil {
		fail(w, http.StatusInternalServerError, reasonServerError)
		return
	}

	slog.Info("invites revoked", "room", name, "by", who.Mark.Trip, "gone", gone)

	respond(w, map[string]any{"revoked": gone})
}

// readInvite says what an invite is for, without spending it.
//
// The page somebody lands on has to name the room before they have typed
// anything, and looking must not burn the link — a preview in a chat client
// fetches URLs, and an invite consumed by being previewed would never work.
func (a *App) readInvite(w http.ResponseWriter, r *http.Request) {
	if !a.limit.Allow(r) {
		fail(w, http.StatusTooManyRequests, reasonRateLimited)
		return
	}

	invite, ok := a.store.Invite(r.PathValue("token"))
	if !ok {
		fail(w, http.StatusNotFound, reasonNoSuchInvite)
		return
	}

	if !invite.Live(time.Now().UTC()) {
		fail(w, http.StatusGone, reasonInviteExpired)
		return
	}

	// Not checked against whether a meeting is running this instant, which is
	// what this did and what made the link a dead one from the moment it was
	// made. A room only exists on the media server while somebody is connected
	// to it: between the host pressing start and their browser finishing its
	// handshake, between the last person leaving and the next arriving, and for
	// the whole of a meeting arranged in advance, there is no room to find — and
	// the link that was going to be sent out reported that the meeting was over.
	//
	// What ends a link is the room being closed, which throws the links away
	// with it, and the ceiling above. Both are things somebody did or a clock
	// did; neither is a gap between two connections.
	respond(w, map[string]any{"room": invite.Room})
}

// meeting reports whether a room is currently being held anywhere.
//
// Asked of the media server, which is the only thing that knows. Where it cannot
// be reached the answer is yes: a guest holding a link that was legitimately
// issued should not be turned away because a relay was slow to answer, and the
// ceiling on the invite is still underneath this.
func (a *App) meeting(r *http.Request, name string) bool {
	if a.control == nil {
		return true
	}

	live, err := a.control.Rooms(r.Context())
	if err != nil {
		return true
	}

	for _, one := range live {
		if one.GetName() == name {
			return true
		}
	}

	return false
}

// roomLive says whether a meeting is happening under this name.
//
// For the screen where somebody types a name they were given. Without it they
// are taken to a camera preview for a room that is not there, choose a device,
// press join, and are refused — which reads as the name being wrong only if they
// happen to remember typing it, and as the site being broken otherwise.
//
// Behind a session, because it is an answer about a name somebody else chose. A
// room here is a name and nothing else, so an endpoint that says whether a name
// is in use is an endpoint that finds meetings by guessing at them. Whoever is
// asking has already proved they belong here; a stranger gets nothing.
func (a *App) roomLive(w http.ResponseWriter, r *http.Request) {
	if !a.limit.Allow(r) {
		fail(w, http.StatusTooManyRequests, reasonRateLimited)
		return
	}

	// Administrators sign in at the same door as everybody else now, so one
	// check covers both.
	if _, ok := a.signedIn(r); !ok {
		fail(w, http.StatusUnauthorized, reasonNotYours)
		return
	}

	respond(w, map[string]any{"live": a.meeting(r, strings.ToLower(r.PathValue("room")))})
}

// invited reports whether this request carries a live invite to this room.
//
// Checked before the opening policy and before the token, because an invite is
// how somebody gets in who can satisfy neither: they have no passphrase, they
// are not an administrator, and the name they were sent is one they could not
// have opened themselves.
func (a *App) invited(r *http.Request, name string) bool {
	token := strings.TrimSpace(r.URL.Query().Get("invite"))

	if token == "" {
		if cookie, err := r.Cookie(inviteCookie); err == nil {
			token = cookie.Value
		}
	}

	if token == "" {
		return false
	}

	_, err := a.store.Redeem(token, name, time.Now().UTC())

	switch {
	case err == nil:
		return true
	case errors.Is(err, store.ErrInviteSpent), errors.Is(err, store.ErrInviteExpired),
		errors.Is(err, store.ErrNoSuchInvite):
		return false
	default:
		return false
	}
}

// keepInvite leaves the spent token in a cookie, so a reload is not a refusal.
func keepInvite(w http.ResponseWriter, r *http.Request, secure bool) {
	token := strings.TrimSpace(r.URL.Query().Get("invite"))
	if token == "" {
		return
	}

	http.SetCookie(w, &http.Cookie{
		Name:     inviteCookie,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(inviteFor.Seconds()),
	})
}
