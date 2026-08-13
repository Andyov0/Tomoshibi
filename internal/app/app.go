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
	"log/slog"
	"net/http"
	"strings"

	"meet-live/internal/config"
	"meet-live/internal/limit"
	"meet-live/internal/room"
	"meet-live/internal/rtc"
	"meet-live/internal/store"
)

// App holds what the handlers need.
type App struct {
	conf    *config.Config
	store   *store.Store
	limit   *limit.Limiter
	media   *rtc.Server
	web     http.Handler
	tripKey []byte
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
	}
}

// Handler builds the router.
func (a *App) Handler() http.Handler {
	mux := http.NewServeMux()

	for _, path := range rtc.Paths {
		mux.Handle(path, a.media.Handler())
	}

	mux.HandleFunc("POST /api/rooms/{room}/join", a.join)
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})

	// Registered without a method, because a route that matched fewer methods
	// than the wildcards above would be an ambiguity the router refuses to
	// resolve. Anything not claimed by a route above is the client.
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

// join authorises a client for a room.
//
// The client may send back the identity it was given before, so that reloading a
// tab keeps the same one. Without that, a refresh looks to everybody else like a
// second participant arriving while the first is still being cleaned up.
func (a *App) join(w http.ResponseWriter, r *http.Request) {
	// Charged first, so a refused caller costs a header lookup rather than a
	// signature.
	if !a.limit.Allow(r) {
		fail(w, http.StatusTooManyRequests, "too many requests: slow down and try again shortly")
		return
	}

	name := strings.ToLower(r.PathValue("room"))
	if !room.ValidName(name) {
		fail(w, http.StatusBadRequest,
			"room names may only contain lowercase letters, digits, and inner dashes")
		return
	}

	// A body that is absent or unreadable is still a request for a fresh
	// identity rather than a parse error the caller can do nothing about.
	var body joinRequest
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body)

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
		fail(w, http.StatusInternalServerError, "the server could not complete the request")
		return
	}

	a.record(name)

	respond(w, joinResponse{
		URL:      a.signallingURL(r),
		Token:    grant.Token,
		Identity: grant.Identity,
		Room:     name,
	})
}

// record notes that a room was joined, without making anybody wait for it.
//
// A store that cannot be written is a lost observation; a room full of people
// who cannot get in would be worse. The rate limiter above bounds how many of
// these can be in flight, so there is no unbounded spawning here.
func (a *App) record(name string) {
	go func() {
		if _, err := a.store.TouchRoom(name); err != nil {
			slog.Warn("failed to record a join", "room", name, "error", err)
		}
	}()
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

func fail(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": message})
}
