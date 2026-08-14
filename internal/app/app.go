// Package app is the HTTP surface: the client, the join endpoint, and the
// signalling paths forwarded to the embedded media server.
//
// All three share one origin, which is what makes the whole thing usable from
// another machine. Camera access and secure WebSockets both require a secure
// context, and one origin means one certificate to arrange rather than two, with
// no cross-origin rules to satisfy in between.
package app

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"tomoshibi/internal/admin"
	"tomoshibi/internal/config"
	"tomoshibi/internal/limit"
	"tomoshibi/internal/room"
	"tomoshibi/internal/rtc"
	"tomoshibi/internal/store"
)

// App holds what the handlers need.
type App struct {
	conf    *config.Config
	store   *store.Store
	limit   *limit.Limiter
	media   *rtc.Server
	web     http.Handler
	tripKey []byte
	admin   *admin.API
}

// New assembles the application.
func New(conf *config.Config, st *store.Store, media *rtc.Server, web http.Handler, tripKey []byte) *App {
	return &App{
		conf:    conf,
		store:   st,
		limit:   limit.New(conf.Meet.JoinRate, conf.Meet.JoinBurst, conf.Meet.TrustProxy),
		media:   media,
		web:     web,
		tripKey: tripKey,
		admin:   admin.New(conf, media, st, tripKey),
	}
}

// Close stops what the application started.
//
// Only the management sampler, which runs on a ticker of its own so that the
// trend it fills has no gaps where nobody happened to be looking. Left running
// it would go on asking a media server that is shutting down for figures nobody
// will read.
func (a *App) Close() {
	a.admin.Close()
}

// Handler builds the router.
func (a *App) Handler() http.Handler {
	mux := http.NewServeMux()

	for _, path := range rtc.Paths {
		mux.Handle(path, a.media.Handler())
	}

	// Registered before the client's fallback, and only where somebody
	// configured an administrator. Absent that, these paths are not refused —
	// they do not exist, and answer like any other address nobody claimed.
	a.admin.Mount(mux)

	mux.HandleFunc("POST /api/rooms/{room}/join", a.join)
	mux.HandleFunc("GET /api/deployment", a.deployment)
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})

	// Registered without a method, because a route that matched fewer methods
	// than the wildcards above would be an ambiguity the router refuses to
	// resolve. Anything not claimed by a route above is the client.
	// Anything under /api that no route above claimed. Without this it reaches
	// the client's fallback and comes back as the document with a 200, which
	// tells a caller that a misspelled endpoint worked and hands a script an
	// HTML page where it expected JSON.
	mux.HandleFunc("/api/", func(w http.ResponseWriter, _ *http.Request) {
		fail(w, http.StatusNotFound, reasonNoSuchEndpoint)
	})

	// The management document, served only where somebody configured an
	// administrator. Not refused when they have not: it is not there, and the
	// address answers exactly like any other nobody claimed. A sign-in page on
	// a deployment with nobody to sign in would be a door fitted to a wall.
	mux.HandleFunc("GET /admin", a.manage)
	mux.HandleFunc("GET /admin/", a.manage)

	mux.Handle("/", a.web)

	return mux
}

type joinRequest struct {
	// Identity a client was given previously, if it has one.
	Identity string `json:"identity"`
	// Name they would like to be called.
	Name string `json:"name"`
	// Passphrase turning that name into one nobody else can wear.
	//
	// Typed so that logging this struct cannot leak it, and read only from the
	// body: a query parameter would reach the access log, the browser history,
	// and any Referer sent onward.
	Passphrase room.Passphrase `json:"passphrase"`
}

type joinResponse struct {
	// URL is where to open the signalling WebSocket.
	URL string `json:"url"`
	// Token authorises this one room under this one identity.
	Token string `json:"token"`
	// Identity is what the bearer will be known as.
	Identity string `json:"identity"`
	// Room is the name that was actually authorised, after normalisation.
	Room string `json:"room"`
}

// What a client needs to know about the server it reached, before anybody has
// typed anything into it.
type deployment struct {
	// OpenedBy is who may use a name nobody has used before.
	OpenedBy room.Opening `json:"openedBy"`

	// Source is where the code running here can be read.
	//
	// Required rather than courteous. This is licensed under the AGPL, whose
	// thirteenth section says that offering people the use of a program over a
	// network obliges the operator to offer them its source — and the people
	// being offered the use of this one are on a web page, so the offer has to
	// be on the web page. It is configurable because a deployment running a
	// changed copy owes its visitors that copy and not this one.
	Source string `json:"source"`
}

// manage serves the management document.
func (a *App) manage(w http.ResponseWriter, r *http.Request) {
	if !a.admin.Configured() {
		http.NotFound(w, r)
		return
	}

	// Rewritten rather than redirected, so that the address stays where
	// somebody typed it and a reload lands in the same place.
	r = r.Clone(r.Context())
	r.URL.Path = "/admin.html"

	a.web.ServeHTTP(w, r)
}

// join authorises a client for a room.
//
// The client may send back the identity it was given before, so that reloading a
// tab keeps the same one. Without that, a refresh looks to everybody else like a
// second participant arriving while the first is still being cleaned up.
//
// It is also where a name nobody has used is either opened or refused, because
// this is the only moment anybody asks for one. There is no other endpoint to
// put that on: rooms are not created here, they are named, and this is where a
// name is first written down.
func (a *App) join(w http.ResponseWriter, r *http.Request) {
	// Charged first, so a refused caller costs a header lookup rather than a
	// signature.
	if !a.limit.Allow(r) {
		fail(w, http.StatusTooManyRequests, reasonRateLimited)
		return
	}

	name := strings.ToLower(r.PathValue("room"))
	if !room.ValidName(name) {
		fail(w, http.StatusBadRequest, reasonBadRoom)
		return
	}

	// A body that is absent or unreadable is still a request for a fresh
	// identity rather than a parse error the caller can do nothing about.
	var body joinRequest
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body)

	// Whether this caller may use a name nobody has used before.
	//
	// Under the policy every deployment starts with, everybody may, and the
	// signature below is never derived — the ordering here is what keeps the
	// common case free. Under the other one, an administrator is recognised by
	// the signature their passphrase produces, which is the one the token is
	// about to carry anyway: the door needed no mechanism that was not already
	// standing here, only for somebody to look at what it had already worked out.
	mayOpen := a.opening() == room.ByAnyone
	if !mayOpen {
		_, mayOpen = config.Administrator(a.conf.Meet.Admins, body.Passphrase, a.tripKey)
	}

	// Before the token rather than after it, and waited for rather than sent
	// off, because this is no longer only an observation: whether the name has
	// ever been used is the answer, and it has to be settled before anybody is
	// authorised for it.
	switch _, err := a.store.OpenRoom(name, mayOpen); {
	case errors.Is(err, store.ErrNotOpen):
		fail(w, http.StatusForbidden, reasonNotOpen)
		return

	case err != nil:
		// Let through, loudly. A store that will not answer cannot tell a name
		// nobody has used from one a meeting is happening in, so refusing here
		// would turn people out of a room that was already open — the one case
		// this policy was never meant to touch. The lost tally is the rest of
		// the cost.
		slog.Error("failed to record a join", "room", name, "error", err)
	}

	grant, err := room.Authorise(a.conf.Key, a.conf.Secret, room.Request{
		Room:       name,
		Identity:   body.Identity,
		Display:    body.Name,
		Passphrase: body.Passphrase,
		TripKey:    a.tripKey,
		TTL:        a.conf.Meet.TokenTTL,
	})
	if err != nil {
		slog.Error("failed to authorise a join", "room", name, "error", err)
		fail(w, http.StatusInternalServerError, reasonServerError)
		return
	}

	respond(w, joinResponse{
		URL:      a.signallingURL(r),
		Token:    grant.Token,
		Identity: grant.Identity,
		Room:     name,
	})
}

// deployment is what a client needs to know before somebody types a room name.
//
// Open to anybody, and deliberately silent about the caller. Whether this
// particular person may open a room turns on a passphrase they have not typed
// yet, and an endpoint that would answer that is a way of testing a guessed
// administrator's passphrase — a faster one than the sign-in page, which is
// rate limited for precisely that reason.
func (a *App) deployment(w http.ResponseWriter, _ *http.Request) {
	respond(w, deployment{OpenedBy: a.opening(), Source: a.conf.Meet.SourceURL})
}

// opening is who may use a name nobody has used, as this deployment can
// actually enforce it.
func (a *App) opening() room.Opening {
	return a.store.Opening().InEffect(len(a.conf.Meet.Admins))
}

// signallingURL is where this client should open its WebSocket.
//
// Derived from the request rather than from the bound address, because the bound
// address is frequently a wildcard and always the server's own view. A caller
// reached us somehow, and that host is by definition one that works for them.
func (a *App) signallingURL(r *http.Request) string {
	if a.conf.Meet.PublicURL != "" {
		return a.conf.Meet.PublicURL
	}

	scheme := "ws"
	if r.TLS != nil || forwardedProto(r, a.conf.Meet.TrustProxy) == "https" {
		scheme = "wss"
	}

	host := r.Host
	if a.conf.Meet.TrustProxy {
		if forwarded := r.Header.Get("X-Forwarded-Host"); forwarded != "" {
			host = forwarded
		}
	}

	return scheme + "://" + host
}

// forwardedProto reads the scheme a proxy terminated, when there is one to
// believe.
func forwardedProto(r *http.Request, trust bool) string {
	if !trust {
		return ""
	}
	return r.Header.Get("X-Forwarded-Proto")
}

func respond(w http.ResponseWriter, body any) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(body); err != nil {
		slog.Warn("failed to write a response", "error", err)
	}
}

// Reasons a request is refused.
//
// Codes rather than sentences, because a sentence has a language and this
// server has no business knowing which one the reader wants. Content
// negotiation would let it guess, but then the same message exists twice —
// once here in Go and once in the client's dictionaries — in two formats and
// two build systems, and the two drift apart with nothing to notice.
//
// So the client owns every word it shows, and this owns only what happened.
const (
	reasonRateLimited    = "rate_limited"
	reasonBadRoom        = "invalid_room"
	reasonNotOpen        = "room_not_open"
	reasonServerError    = "server_error"
	reasonNoSuchEndpoint = "no_such_endpoint"
)

func fail(w http.ResponseWriter, status int, reason string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": reason})
}
