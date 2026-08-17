package app

import (
	"errors"
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

// How long an invite lasts, and how many it admits.
//
// A day, because a meeting invited to on Monday for Tuesday is ordinary and a
// link found in a message from March should be dead. One person, because that is
// what somebody means when they send a link to somebody.
const (
	inviteFor  = 24 * time.Hour
	inviteUses = 1
)

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
	mux.HandleFunc("GET /api/invites/{token}", a.readInvite)
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
		Room: name, By: who.Mark.Trip, Created: now,
		Expires: now.Add(inviteFor), Uses: inviteUses,
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
		"uses":    inviteUses,
	})
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
		// Which of the two, because they are different sentences to the person
		// reading them and only one of them means "ask for another link".
		if time.Now().After(invite.Expires) {
			fail(w, http.StatusGone, reasonInviteExpired)
			return
		}

		fail(w, http.StatusGone, reasonInviteSpent)
		return
	}

	respond(w, map[string]any{"room": invite.Room})
}

// invited reports whether this request carries a live invite to this room.
//
// Checked before the opening policy and before the token, because an invite is
// how somebody gets in who can satisfy neither: they have no passphrase, they
// are not an administrator, and the name they were sent is one they could not
// have opened themselves.
//
// The identity is what the invite is spent on, so a reload comes back through
// the same one rather than through a second invite.
func (a *App) invited(r *http.Request, name, identity string) bool {
	token := strings.TrimSpace(r.URL.Query().Get("invite"))

	if token == "" {
		if cookie, err := r.Cookie(inviteCookie); err == nil {
			token = cookie.Value
		}
	}

	if token == "" {
		return false
	}

	_, err := a.store.Redeem(token, name, identity, time.Now().UTC())

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
