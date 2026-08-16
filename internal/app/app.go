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
	"os"
	"strings"
	"sync"
	"time"

	"tomoshibi/internal/admin"
	"tomoshibi/internal/config"
	"tomoshibi/internal/limit"
	"tomoshibi/internal/room"
	"tomoshibi/internal/rtc"
	"tomoshibi/internal/store"
)

// App holds what the handlers need.
type App struct {
	conf *config.Config
	// store is nil on a relay, which records nothing.
	store *store.Store
	limit *limit.Limiter
	// media is nil on a control node, which starts no media server of its own.
	// Every use is guarded; the signalling paths are simply not mounted.
	media   *rtc.Server
	web     http.Handler
	tripKey []byte
	admin   *admin.API
	// relays is where a control node sends clients. Empty everywhere else.
	relays *relays
	// enrolment is set where a relay may bring itself up from a script.
	enrolment *admin.Enrolment

	stop    chan struct{}
	closing sync.Once
}

// New assembles the application.
//
// media may be nil, which is what a control node passes: it signs tokens for
// meetings held on relays elsewhere and has no media server to forward to.
func New(conf *config.Config, st *store.Store, media *rtc.Server, web http.Handler, tripKey []byte) *App {
	a := &App{
		conf:    conf,
		store:   st,
		limit:   limit.New(conf.Meet.JoinRate, conf.Meet.JoinBurst, conf.Meet.TrustProxy),
		media:   media,
		web:     web,
		tripKey: tripKey,
		admin:   admin.New(conf, media, st, tripKey),
		relays:  newRelays(conf, st),
		stop:    make(chan struct{}),
	}

	// Guarded on the store as well as the setting: a relay keeps none, and a
	// sweeper with nothing to sweep would dereference it on its first tick.
	if conf.Meet.Rooms.Remember > 0 && st != nil {
		go a.forgetting()
	}

	return a
}

// Close stops what the application started.
//
// Two things, both on tickers of their own. The management sampler fills a trend
// that would otherwise have gaps wherever nobody happened to be looking, and
// left running it would go on asking a media server that is shutting down for
// figures nobody will read. The sweeper below takes the store's one writer, and
// a shutdown that leaves it holding that is a shutdown that waits on it.
//
// Guarded, because a server can be shut down from more than one direction — a
// signal and a failed listener both arrive here — and closing a channel twice is
// a panic during the one moment nobody is watching the logs.
func (a *App) Close() {
	a.closing.Do(func() { close(a.stop) })
	a.admin.Close()
}

// How much of the store one sweep may clear before letting go.
//
// bbolt admits a single writer and a join is a write, so the number that matters
// is not how fast this finishes but how long it holds the door. A thousand keys
// is a few milliseconds; a bucket that has been allowed to grow is cleared over
// a series of them with joins in between, rather than in one transaction that
// every caller waits behind.
const sweepBatch = 1000

// How often the sweep runs.
//
// The thing it measures is a month old, so an hour is not a schedule chosen for
// timeliness — it is chosen so that a server which is restarted daily and one
// which runs for a year behave the same.
const sweepEvery = time.Hour

// forgetting ages out names nobody has joined for a while.
//
// Once at once, because a deployment restarted every night would otherwise never
// reach the first tick, and then on the hour.
func (a *App) forgetting() {
	ticker := time.NewTicker(sweepEvery)
	defer ticker.Stop()

	for {
		a.forget()

		select {
		case <-a.stop:
			return
		case <-ticker.C:
		}
	}
}

// forget clears one sweep's worth, and keeps going while there is more.
func (a *App) forget() {
	since := time.Now().Add(-a.conf.Meet.Rooms.Remember)
	total := 0

	for {
		gone, err := a.store.Forget(since, sweepBatch)
		if err != nil {
			slog.Error("failed to forget rooms nobody has joined", "error", err)
			return
		}

		total += gone

		// A full batch means there is probably more. Anything short is the end
		// of it, and so is a shutdown that arrived mid-sweep: what is left will
		// still be there for whoever starts next.
		if gone < sweepBatch {
			break
		}

		select {
		case <-a.stop:
			return
		default:
		}
	}

	if total > 0 {
		slog.Info("forgot rooms nobody had joined for a while",
			"rooms", total, "unused for", a.conf.Meet.Rooms.Remember)
	}
}

// Handler builds the router.
func (a *App) Handler() http.Handler {
	mux := http.NewServeMux()

	// Only where there is a media server to forward to. A control node has
	// none: these paths belong to the relays, whose addresses it hands out.
	if a.media != nil {
		for _, path := range rtc.Paths {
			mux.Handle(path, a.media.Handler())
		}
	}

	// A relay is the signalling paths above and nothing else.
	//
	// Returned here rather than by skipping each registration below, because
	// the point is not that the client and the join endpoint are unnecessary on
	// a relay — it is that they must not be there. A relay reachable at a name
	// somebody could type is one that would serve a join endpoint signing
	// tokens against a store it does not keep, and management pages for
	// administrators it was told nothing about.
	if a.conf.Meet.Role == config.RoleRelay {
		// Answered for any origin, because the point of this endpoint on a relay
		// is to be timed by a client served from somewhere else: the control
		// node's page measures every relay before choosing one, and a browser
		// will not report the timing of a cross-origin request it was not given
		// permission to make. Nothing is disclosed — the body is empty and the
		// address was published to that client a moment ago.
		mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Access-Control-Allow-Origin", "*")
			w.Header().Set("Cache-Control", "no-store")
			w.WriteHeader(http.StatusNoContent)
		})

		// This relay's own counters, for a control node's dashboard. Behind the
		// deployment's credentials: the figures say how many people are in calls
		// here and how much is flowing, which is exactly the shape of thing that
		// should not be readable by whoever finds the port.
		mux.Handle("GET "+rtc.StatsPath,
			rtc.StatsHandler(a.media, a.conf.Key, a.conf.Secret, admin.Started))

		// The preflight a browser sends before a timed request that carries
		// anything but the simplest headers.
		mux.HandleFunc("OPTIONS /api/health", func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Access-Control-Allow-Origin", "*")
			w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
			w.Header().Set("Access-Control-Max-Age", "86400")
			w.WriteHeader(http.StatusNoContent)
		})

		return mux
	}

	// Registered before the client's fallback, and only where somebody
	// configured an administrator. Absent that, these paths are not refused —
	// they do not exist, and answer like any other address nobody claimed.
	a.admin.Mount(mux)

	mux.HandleFunc("POST /api/rooms/{room}/join", a.join)
	mux.HandleFunc("GET /api/deployment", a.deployment)
	mux.HandleFunc("GET /api/relays", a.relayList)

	// The two a machine being brought up calls, and the only management paths
	// with no session behind them: the token in the script is what authenticates
	// them, and there is no administrator sitting at a machine minutes into its
	// life. Registered only where enrolment was configured.
	if a.enrolment != nil {
		a.admin.MountEnrolment(mux)
		mux.HandleFunc("GET /download/tomoshibi", a.binary)
	}
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
	// Relay is the name of the relay this client measured as fastest.
	//
	// A name from the list at /api/relays and never an address, so the worst a
	// forged one can do is pick a different relay of ours — and an unknown one
	// is ignored entirely. Empty from any client that did not measure, which is
	// every client under the other policies.
	Relay string `json:"relay"`

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
		URL:      a.signallingURLFor(name, body.Relay, r),
		Token:    grant.Token,
		Identity: grant.Identity,
		Room:     name,
	})
}

// relayEntry is one relay as a client is told about it.
type relayEntry struct {
	// Name is what the client sends back after measuring. The relay is
	// identified by this and never by its address, so that a client's answer
	// can only ever select one of ours.
	Name string `json:"name"`

	// URL is the WebSocket origin to measure and, if chosen, to dial.
	URL string `json:"url"`

	// Region is the deployment's own label, shown to somebody who wants to know
	// where their call is being held. Never used to choose under this policy —
	// that is what the measurement is for.
	Region string `json:"region,omitempty"`
}

// relayList is what a client measures before it joins.
//
// Answered under every policy rather than only under probe, because the list is
// also the honest answer to where a meeting might be held, and a client that
// wants to show somebody that is not doing anything it needs permission for.
// Under the other policies a client's measurement is simply not consulted.
//
// Empty on a full deployment, which holds its own media and has nothing to
// choose between. A client seeing an empty list measures nothing and joins as
// it always did.
func (a *App) relayList(w http.ResponseWriter, _ *http.Request) {
	list := a.relays.offered()

	entries := make([]relayEntry, 0, len(list))
	for _, relay := range list {
		entries = append(entries, relayEntry{Name: relay.Name, URL: relay.URL, Region: relay.Region})
	}

	respond(w, relayListResponse{
		Relays: entries,
		// Said rather than inferred, so a client does not have to guess from an
		// empty list whether measuring would be listened to. Under anything but
		// probe it would not be, and measuring would be a delay before every
		// join that changed nothing.
		Measure: a.conf.Meet.RelayPolicy == config.PickProbe && len(entries) > 1,
	})
}

type relayListResponse struct {
	Relays []relayEntry `json:"relays"`
	// Measure says whether this deployment will act on a measurement.
	Measure bool `json:"measure"`
}

// binary serves the build this control node is running to a relay installing
// itself.
//
// The same file rather than a download from anywhere else, so a fleet cannot
// drift apart by version: every relay runs what the control node runs, because
// that is literally the file it was given.
//
// Open, like the client is. It is a build of a published program and carries no
// secret; what a relay needs and must not be given away travels through the
// enrolment endpoint, which is behind the secret.
func (a *App) binary(w http.ResponseWriter, r *http.Request) {
	path := a.conf.Meet.Enrol.Binary
	if path == "" {
		if resolved, err := os.Executable(); err == nil {
			path = resolved
		}
	}

	if path == "" {
		fail(w, http.StatusServiceUnavailable, "no_binary")
		return
	}

	file, err := os.Open(path)
	if err != nil {
		slog.Error("failed to open the binary for a relay", "path", path, "error", err)
		fail(w, http.StatusServiceUnavailable, "no_binary")
		return
	}
	defer file.Close()

	info, err := file.Stat()
	if err != nil {
		fail(w, http.StatusServiceUnavailable, "no_binary")
		return
	}

	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", `attachment; filename="tomoshibi"`)

	// ServeContent rather than io.Copy: it handles ranges and conditional
	// requests, which matter for a fifty-megabyte file fetched over a link that
	// may drop halfway.
	http.ServeContent(w, r, "tomoshibi", info.ModTime(), file)
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
	return a.signallingURLFor("", "", r)
}

// signallingURLFor is where a client joining this room should open its
// WebSocket.
//
// The room matters because of what the relay policies do with it: gathering a
// meeting onto one relay is the difference between media crossing between
// machines and staying on one, and that is only possible if the answer depends
// on which meeting is being joined rather than on who is joining it.
//
// Order is deliberate. A configured relay list is a deployment saying where
// media lives, and it outranks public_url — which on a control node describes
// where the *client* is served and would send everybody to a machine running no
// media server at all.
func (a *App) signallingURLFor(name, chosen string, r *http.Request) string {
	if a.relays.any() {
		return a.relays.pick(name, chosen, r, a.conf.Meet.TrustProxy).URL
	}

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
