package admin

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"tomoshibi/internal/config"
	"tomoshibi/internal/room"
	"tomoshibi/internal/rtc"
	"tomoshibi/internal/store"

	"github.com/livekit/protocol/livekit"
)

// Media is what these pages need to know about the server they run beside.
//
// An interface rather than the server itself, and not for the sake of one: the
// gates in front of every endpoint below could not be exercised without a
// running media server, so they were not — the whole of this file sat at nothing
// while the rules it enforces were tested somewhere they were never asked.
type Media interface {
	Stats() *livekit.NodeStats
	Throughput() (in, out float64, window time.Duration)
	Node() (id string, ip string)
}

// Control is what they need to ask of rooms, and occasionally do to them.
type Control interface {
	Rooms(ctx context.Context) ([]*livekit.Room, error)
	Participants(ctx context.Context, room string) ([]*livekit.ParticipantInfo, error)
	Remove(ctx context.Context, room, identity string) error
	Mute(ctx context.Context, room, identity, track string) error
	Close(ctx context.Context, room string) error
}

// Names is what they need of the record of names that have been used.
//
// The third of these, and added for the reason the first two were: the moment a
// gate in front of an endpoint needs something concrete behind it, the gate can
// only be exercised by standing the concrete thing up, and so it stops being
// exercised at all. This one arrived with the switch deciding who may open a
// room, which is the last rule on these pages that should go untested.
type Names interface {
	Rooms() ([]store.Named, error)
	Opening() room.Opening
	SetOpening(opening room.Opening) error

	// HeldOn says which relay a room is on, and Arrivals what was seen of the
	// people in it when they were let in.
	//
	// Both are here because the media server cannot answer either. It reports a
	// room from whichever node was asked, and it sees each participant over a
	// signalling socket from a relay — so the machine it names is the machine
	// that answered, and the address it holds is the relay's. This server chose
	// the machine and saw the address, once, at the join.
	HeldOn(room string) string
	Arrivals(room string) map[string]store.Arrival
}

// Roster is where the administrators are kept.
//
// Its own interface rather than a method on the one above, for the reason the
// package names narrow ones at all: this is the list that decides who may open
// these pages, and a test that exercises the gate has to be able to hand over a
// list somebody wrote down without also standing up a database.
type Roster interface {
	Admins() ([]store.Admin, error)
	AddAdmin(admin store.Admin) error
	UpdateAdmin(admin store.Admin) error
	RemoveAdmin(trip string) error
	ReplaceAdminTrip(from, to string) error
}

// API is the management surface.
type API struct {
	conf     *config.Config
	sessions *Sessions
	control  Control
	media    Media
	store    Names
	roster   Roster
	ledger   Ledger
	relays   Relays
	probe    Reachable
	// fleet reads the counters of the relays this node does not run. Nil on a
	// full deployment, which reads its own.
	fleet Fleet
	// enrolment is what a new relay is told; nil where bringing one up from a
	// page is not configured.
	enrolment *Enrolment
	// onRelaysChanged lets the choosing side drop its cache the moment this
	// list moves, so a relay added here is used by the very next join.
	onRelaysChanged func()
	log             *Log
	history         *History
	stop            chan struct{}
	closing         sync.Once
}

// New assembles it.
//
// media is nil on a control node, which starts no media server of its own: the
// calls it authorises are held on relays elsewhere, and there is nothing on this
// machine to ask about them. The interfaces are left nil rather than filled with
// something that pretends, so that a page which needs one says it cannot find
// out — see [API.attached].
func New(conf *config.Config, media *rtc.Server, st *store.Store, tripKey []byte) *API {
	api := &API{
		conf:    conf,
		store:   st,
		log:     NewLog(),
		history: NewHistory(),
		stop:    make(chan struct{}),
	}

	// Signing in asks the store, and falls back to the file where there is no
	// store — which is a relay, where none of this is mounted anyway. The file
	// is also what answers before the store has been adopted from, so a
	// deployment being started for the first time is not briefly locked out of
	// itself.
	api.sessions = NewSessions(api.Administrators, tripKey)

	// The relay list is the store's, where a page's changes go. Nil on a
	// deployment without one, which is a relay.
	if st != nil {
		api.relays = st
		api.roster = st
		api.ledger = st

		// So that restarting the process does not sign everybody out. It used
		// to, and during an afternoon of deployments that reads as the sign-in
		// being broken rather than as the server having been restarted.
		api.sessions.Remember(st)
	}

	// Assigned inside the guard and never outside it. A nil *rtc.Server put
	// into an interface field is an interface that is not nil — it carries the
	// type — so `api.media != nil` would be true and the first method call on
	// it would be a nil dereference at the far end of a request. Left unset,
	// the field is genuinely nil and [API.attached] can be trusted.
	if media != nil {
		api.media = media
		api.control = media.Manage(conf.Key, conf.Secret)
	}

	// Sampled on its own schedule rather than when a page asks. A trend with a
	// gap wherever nobody was looking is not a trend, and the first thing
	// anybody does with one is read the gap as quiet.
	if api.Configured() {
		go api.history.Watch(api.stop, api.sample)
	}

	return api
}

// Close stops sampling.
//
// Guarded, because a server can be shut down from more than one direction — a
// signal and a failed listener both arrive here — and closing a channel twice
// is a panic during the one moment nobody is watching the logs.
func (a *API) Close() {
	a.closing.Do(func() { close(a.stop) })
}

// sample reads one moment for the history.
func (a *API) sample() Sample {
	// local and not attached: every figure below is read from the media server
	// in this process, and a control node has none however many relays it can
	// reach. Guarded on the wrong one of the two, this sampler ran a second
	// after a control node started, dereferenced a nil media server, and took
	// the process down — on a timer, so the crash arrived detached from
	// anything anybody had just done.
	if !a.local() {
		return Sample{At: time.Now().UTC()}
	}

	stats := a.media.Stats()
	in, out, _ := a.media.Throughput()

	return Sample{
		At: time.Now().UTC(), In: in, Out: out,
		Rooms: stats.GetNumRooms(), Clients: stats.GetNumClients(),
		Nack: stats.GetNackPerSec(),
	}
}

// UseCluster points the management pages at relays elsewhere.
//
// A control node has no media server of its own, so without this every page
// about rooms or participants answers that it cannot find out — which is true
// and useless, since those pages exist to answer exactly those questions. Given
// a cluster they work as a full deployment's do: the questions go to whichever
// relay answers, and redis makes any one of them speak for all.
func (a *API) UseCluster(cluster *rtc.Cluster) {
	if cluster == nil {
		return
	}

	a.control = cluster
	a.probe = cluster
	a.fleet = cluster
}

// UseEnrolment lets relays be brought up from the management pages.
//
// Off unless configured, and deliberately so: what an enrolment hands over is
// the secret every relay signs with, the redis password and a private key. A
// deployment that has not said where those live does not get an endpoint that
// gives them away.
func (a *API) UseEnrolment(enrolment *Enrolment) {
	a.enrolment = enrolment
}

// OnRelaysChanged registers what to run when the relay list moves.
func (a *API) OnRelaysChanged(fn func()) {
	a.onRelaysChanged = fn
}

// Configured reports whether this deployment has a management surface at all.
func (a *API) Configured() bool {
	return a.sessions.Configured()
}

// attached says whether there is a media server on this machine to ask about.
//
// False on a control node. The calls it authorises are held on relays
// elsewhere, and what those relays are doing is not visible from here: every
// figure on these pages comes from the embedded server's own counters, and
// there is no embedded server.
//
// Both halves are checked because they are set together and a future caller
// should not have to know that. Neither is ever a nil pointer inside a non-nil
// interface — see the guard in New, which is what makes this test meaningful.
func (a *API) attached() bool {
	return a.control != nil
}

// local says whether the figures that only a media server knows about itself are
// available: throughput, node identity, hardware counters.
//
// Distinct from attached, because the two became different questions the moment
// a control node could reach relays it does not run. It can list their rooms
// and remove somebody from one; it cannot report their CPU, because those
// counters are read from the process holding them.
func (a *API) local() bool {
	return a.media != nil
}

// detached answers a page that wanted a media server on a node that has none.
//
// 503 rather than 404. The distinction is the honest one — the endpoint exists
// and this deployment is configured for it, but the thing it reports on is on
// another machine — and it is the difference between an operator concluding
// they mistyped an address and concluding they are looking at the wrong half of
// a deployment.
func (a *API) detached(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusServiceUnavailable)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": "no_media_here"})
}

// Mount registers the endpoints.
//
// Nothing is registered when no administrator is configured, so the paths do
// not merely refuse — they are not there, and the client fallback answers them
// like any other unknown address.
// administrators is the live list, as everything that recognises somebody reads
// it.
//
// The store first and the configuration file behind it. The file is the starting
// value and the way back in when a store has been lost: somebody who can edit it
// on the host can always put themselves back, and that is deliberate, because
// the alternative is a deployment that has locked out its own owner.
func (a *API) Administrators() []config.Admin {
	// Nil where no management surface was built, which is a relay. Callers on
	// that side ask this to decide whether an administrator exists at all, and
	// the honest answer for a machine with no management pages is none.
	if a == nil {
		return nil
	}

	if a.roster != nil {
		if stored, err := a.roster.Admins(); err == nil && len(stored) > 0 {
			list := make([]config.Admin, 0, len(stored))
			for _, one := range stored {
				list = append(list, one.Configured())
			}

			return list
		}
	}

	return a.conf.Meet.Admins
}

func (a *API) Mount(mux *http.ServeMux) {
	if !a.Configured() {
		return
	}

	mux.HandleFunc("POST /api/admin/session", a.open)
	mux.HandleFunc("DELETE /api/admin/session", a.close)
	mux.HandleFunc("GET /api/admin/session", a.whoami)

	mux.HandleFunc("GET /api/admin/now", a.observe(a.now))
	mux.HandleFunc("GET /api/admin/history", a.observe(a.trend))
	mux.HandleFunc("GET /api/admin/rooms", a.observe(a.rooms))
	mux.HandleFunc("GET /api/admin/rooms/{room}/participants", a.observe(a.participants))
	mux.HandleFunc("GET /api/admin/runtime", a.observe(a.runtime))
	mux.HandleFunc("GET /api/admin/audit", a.observe(a.audit))
	mux.HandleFunc("GET /api/admin/policy", a.observe(a.readPolicy))
	mux.HandleFunc("GET /api/admin/relays", a.observe(a.listRelays))

	// Adding a relay decides where other people's calls are held, which is the
	// same kind of authority as closing a room rather than the same kind as
	// reading a figure.
	mux.HandleFunc("POST /api/admin/relays", a.moderate(a.addRelay))
	mux.HandleFunc("PATCH /api/admin/relays/{relay}", a.moderate(a.editRelay))
	mux.HandleFunc("DELETE /api/admin/relays/{relay}", a.moderate(a.dropRelay))
	// The install script, served to somebody signed in because it carries the
	// enrolment secret.
	mux.HandleFunc("GET /api/admin/relays/script", a.moderate(a.installScript))
	mux.HandleFunc("GET /api/admin/relays/command", a.moderate(a.installCommand))
	mux.HandleFunc("PUT /api/admin/relays/order", a.moderate(a.orderRelays))

	// Who else may open these pages. Reading the list needs observe; changing
	// it needs moderate, because being able to grant an ability is that
	// ability — an observer who could appoint a moderator would be one.
	mux.HandleFunc("GET /api/admin/admins", a.observe(a.roles))
	mux.HandleFunc("POST /api/admin/admins", a.moderate(a.addRole))
	mux.HandleFunc("PATCH /api/admin/admins/{trip}", a.moderate(a.changeRole))
	mux.HandleFunc("DELETE /api/admin/admins/{trip}", a.moderate(a.dropRole))

	// Changing one's own passphrase needs no capability beyond being signed in.
	// It is not an administrative act on the deployment; it is somebody looking
	// after their own credential, and requiring moderate for it would mean an
	// observer could never rotate theirs.
	mux.HandleFunc("POST /api/admin/admins/me/passphrase", a.observe(a.changeOwnPassphrase))

	// The accounts an administrator hands out. Reading needs observe; making
	// and changing one needs moderate, because an account is a way in.
	mux.HandleFunc("GET /api/admin/accounts", a.observe(a.accounts))
	mux.HandleFunc("POST /api/admin/accounts", a.moderate(a.addAccount))
	mux.HandleFunc("PATCH /api/admin/accounts/{name}", a.moderate(a.changeAccount))
	mux.HandleFunc("DELETE /api/admin/accounts/{name}", a.moderate(a.dropAccount))

	mux.HandleFunc("PUT /api/admin/policy", a.moderate(a.setPolicy))
	mux.HandleFunc("DELETE /api/admin/rooms/{room}", a.moderate(a.closeRoom))
	mux.HandleFunc("DELETE /api/admin/rooms/{room}/participants/{identity}", a.moderate(a.removeOne))
	mux.HandleFunc("POST /api/admin/rooms/{room}/participants/{identity}/mute", a.moderate(a.muteOne))
}

// MountEnrolment registers the endpoint a new relay claims its configuration
// from.
//
// Separate from Mount because it is the one management path with no session
// behind it: the machine claiming it has no administrator sitting at it, and
// the token it carries is the authentication. Registered only where enrolment
// was configured, so a deployment that did not ask for this has no such
// address rather than one that refuses.
func (a *API) MountEnrolment(mux *http.ServeMux) {
	if a.enrolment == nil {
		return
	}

	mux.HandleFunc("POST /api/enrol", a.claim)
	mux.HandleFunc("POST /api/enrol/taken", a.taken)
}

// open signs somebody in.
func (a *API) open(w http.ResponseWriter, r *http.Request) {
	caller := addressOf(r, a.conf.Meet.TrustProxy)

	if !a.sessions.limit.Allow(caller) {
		a.log.Record(Entry{Action: "sign in", Trip: "-", Failed: true, Reason: "too many attempts"})
		refuse(w, http.StatusTooManyRequests, "too_many_attempts")
		return
	}

	var body struct {
		// Name narrows the guess to one person.
		//
		// Without it every attempt is checked against every administrator at
		// once, so a list of leaked passphrases run at this endpoint succeeds if
		// any one person on the deployment ever reused one. With it, an attacker
		// has to be right about who as well as what.
		Name       string          `json:"name"`
		Passphrase room.Passphrase `json:"passphrase"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body)

	session, token, ok := a.sessions.Open(body.Name, body.Passphrase)
	if !ok {
		a.sessions.limit.Failed(caller)
		// Recorded without anything derived from what was typed. A rejected
		// passphrase is still a passphrase, and one of these logs is going to
		// be read by somebody it does not belong to.
		a.log.Record(Entry{Action: "sign in", Trip: "-", Failed: true, Reason: "not an administrator"})
		refuse(w, http.StatusUnauthorized, "refused")
		return
	}

	Grant(w, token, secureRequest(r, a.conf.Meet.TrustProxy))
	a.log.Record(Entry{Action: "sign in", Trip: session.Trip, Name: session.Name})

	respond(w, whoami{Trip: session.Trip, Name: session.Name, Can: capabilities(session)})
}

func (a *API) close(w http.ResponseWriter, r *http.Request) {
	if session, ok := a.sessions.Of(r); ok {
		a.log.Record(Entry{Action: "sign out", Trip: session.Trip, Name: session.Name})
	}

	a.sessions.Close(r)
	Revoke(w, secureRequest(r, a.conf.Meet.TrustProxy))
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) whoami(w http.ResponseWriter, r *http.Request) {
	session, ok := a.sessions.Of(r)
	if !ok {
		refuse(w, http.StatusUnauthorized, "signed_out")
		return
	}

	respond(w, whoami{Trip: session.Trip, Name: session.Name, Can: capabilities(session)})
}

type whoami struct {
	Trip string   `json:"trip"`
	Name string   `json:"name,omitempty"`
	Can  []string `json:"can"`
}

func capabilities(session Session) []string {
	can := []string{config.Observe}
	if session.Allows(config.Moderate) {
		can = append(can, config.Moderate)
	}

	return can
}

// observe and moderate are the two gates.
//
// Separate because the halves differ by more than degree: watching answers the
// question somebody debugging a call has, and acting changes what another
// person is experiencing, at once and with no warning. Bound together, the
// choice becomes give everybody the second or nobody the first.
func (a *API) observe(next func(Session, http.ResponseWriter, *http.Request)) http.HandlerFunc {
	return a.gate(config.Observe, next)
}

func (a *API) moderate(next func(Session, http.ResponseWriter, *http.Request)) http.HandlerFunc {
	return a.gate(config.Moderate, next)
}

func (a *API) gate(
	capability string,
	next func(Session, http.ResponseWriter, *http.Request),
) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		session, ok := a.sessions.Of(r)
		if !ok {
			refuse(w, http.StatusUnauthorized, "signed_out")
			return
		}

		if !session.Allows(capability) {
			a.log.Record(Entry{
				Action: "refused", Trip: session.Trip, Name: session.Name,
				Failed: true, Reason: "not allowed to " + capability,
			})
			refuse(w, http.StatusForbidden, "not_allowed")
			return
		}

		next(session, w, r)
	}
}

// now is the one screen that answers "how is it going".
func (a *API) trend(_ Session, w http.ResponseWriter, _ *http.Request) {
	respond(w, a.history.Since())
}

func (a *API) now(_ Session, w http.ResponseWriter, r *http.Request) {
	// A control node holds no media and reads its relays instead. The shape
	// differs because the thing being described differs: one process has a node
	// identity and a load, and a fleet has a list of them and a sum.
	if !a.local() {
		if a.fleet == nil {
			a.detached(w)
			return
		}

		reading := readFleet(r.Context(), a.fleet, a.relayNames())

		respond(w, map[string]any{
			"since":    Started.UTC(),
			"fleet":    true,
			"nodes":    reading.Nodes,
			"asked":    reading.Asked,
			"answered": reading.Answered,
			"rooms":    reading.Totals.Rooms,
			"clients":  reading.Totals.Clients,
			"tracks":   map[string]int32{"in": reading.Totals.TracksIn, "out": reading.Totals.TracksOut},
			"bytes": map[string]any{
				"in": reading.Totals.BytesIn, "out": reading.Totals.BytesOut,
				"inPerSec": reading.Totals.InPerSec, "outPerSec": reading.Totals.OutPerSec,
				"window": reading.Totals.Window,
			},
			"packets": map[string]any{
				"nackTotal": reading.Totals.NackTotal, "nackPerSec": reading.Totals.NackPerSec,
			},
			"cpu": map[string]any{"count": reading.Totals.CPUs, "load": reading.Totals.Load},
		})
		return
	}

	stats := a.media.Stats()
	in, out, window := a.media.Throughput()
	id, ip := a.media.Node()

	respond(w, map[string]any{
		"node":    map[string]string{"id": id, "ip": ip},
		"since":   Started.UTC(),
		"rooms":   stats.GetNumRooms(),
		"clients": stats.GetNumClients(),
		"tracks":  map[string]int32{"in": stats.GetNumTracksIn(), "out": stats.GetNumTracksOut()},
		"bytes": map[string]any{
			"in": stats.GetBytesIn(), "out": stats.GetBytesOut(),
			// From the list of measured rates rather than the flat field beside
			// them, which the protocol marks deprecated and the media server
			// never assigns. The window is sent with them: ten seconds of mean
			// is not an instantaneous reading, and a figure that does not say
			// which it is gets read as the wrong one.
			"inPerSec": in, "outPerSec": out, "window": window.Seconds(),
		},
		"packets": map[string]any{
			"nackTotal": stats.GetNackTotal(), "nackPerSec": stats.GetNackPerSec(),
		},
		"cpu": map[string]any{"count": stats.GetNumCpus(), "load": stats.GetCpuLoad()},
	})
}

func (a *API) rooms(_ Session, w http.ResponseWriter, r *http.Request) {
	if !a.attached() {
		a.detached(w)
		return
	}

	live, err := a.control.Rooms(r.Context())
	if err != nil {
		slog.Error("failed to list rooms", "error", err)
		refuse(w, http.StatusBadGateway, "media_server_unreachable")
		return
	}

	seen, err := a.store.Rooms()
	if err != nil {
		slog.Warn("failed to read the room history", "error", err)
		seen = nil
	}

	// Where each live room actually is.
	//
	// The media server will not say. It reports the room from whichever node
	// answered, and every node answers for the whole cluster, so the field that
	// looks like it should hold this holds the machine that was asked. This
	// server chose the machine at the join and wrote it down, which is the only
	// record of it anywhere.
	respond(w, map[string]any{
		"live":  liveRooms(live, a.wherever()),
		"known": knownRooms(seen),
	})
}

// knownRooms flattens what the store holds.
//
// Its own shape nests the record inside a wrapper carrying the name, which is
// how it is keyed rather than how it reads. Handed over as it stands, every
// caller would have to know that.
func knownRooms(seen []store.Named) []map[string]any {
	out := make([]map[string]any, 0, len(seen))
	for _, one := range seen {
		out = append(out, map[string]any{
			"name":      one.Name,
			"firstSeen": one.Room.Created,
			"lastSeen":  one.Room.Seen,
			"joins":     one.Room.Joins,
		})
	}

	return out
}

// wherever answers, for a room, the name a person would recognise the machine
// holding it by.
//
// The store keys relays by a short name typed at a prompt on the machine being
// brought up; what an operator reads on a page is the label. Resolved here
// rather than in the store because the store holds the room record and knows
// nothing about labels, and resolved once per listing rather than per room so a
// page with forty calls does not read the relay list forty times.
func (a *API) wherever() func(string) string {
	if a.store == nil {
		return nil
	}

	shown := map[string]string{}

	if a.relays != nil {
		if list, err := a.relays.Relays(); err == nil {
			for _, relay := range list {
				shown[relay.Name] = relay.Shown()
			}
		}
	}

	return func(name string) string {
		held := a.store.HeldOn(name)
		if held == "" {
			return ""
		}

		// The key where the relay has since been removed, which is worth saying:
		// a call held on a machine that is no longer in the list is exactly the
		// situation somebody needs to be told about.
		if label, ok := shown[held]; ok {
			return label
		}

		return held
	}
}

func liveRooms(rooms []*livekit.Room, held func(string) string) []map[string]any {
	out := make([]map[string]any, 0, len(rooms))
	for _, one := range rooms {
		row := map[string]any{
			"name":         one.GetName(),
			"sid":          one.GetSid(),
			"participants": one.GetNumParticipants(),
			"publishers":   one.GetNumPublishers(),
			"createdAt":    time.Unix(one.GetCreationTime(), 0).UTC(),
		}

		if held != nil {
			if where := held(one.GetName()); where != "" {
				row["relay"] = where
			}
		}

		out = append(out, row)
	}

	return out
}

func (a *API) participants(_ Session, w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("room")

	if !a.attached() {
		a.detached(w)
		return
	}

	people, err := a.control.Participants(r.Context(), name)
	if err != nil {
		slog.Error("failed to list participants", "room", name, "error", err)
		refuse(w, statusOf(err), reasonOf(err))
		return
	}

	// What was seen of each of them at the door, which the media server cannot
	// know: by the time it sees somebody they arrived over a signalling socket
	// from a relay, so the address it holds is the relay's.
	arrived := map[string]store.Arrival{}
	if a.store != nil {
		arrived = a.store.Arrivals(name)
	}

	out := make([]map[string]any, 0, len(people))
	for _, one := range people {
		signature, _ := room.SignatureOf(one.GetIdentity())

		row := map[string]any{
			"identity":  one.GetIdentity(),
			"name":      one.GetName(),
			"sid":       one.GetSid(),
			"state":     one.GetState().String(),
			"joinedAt":  time.Unix(one.GetJoinedAt(), 0).UTC(),
			"publisher": one.GetIsPublisher(),
			"trip": map[string]any{
				"mark": signature.Trip, "proven": signature.Proven,
				"account": signature.Account,
			},
			"tracks": tracksOf(one),
		}

		if arrival, ok := arrived[one.GetIdentity()]; ok {
			row["address"] = arrival.Address
			row["relay"] = arrival.Relay
			row["holding"] = arrival.Holding
			row["forwarded"] = arrival.Forwarded
		}

		out = append(out, row)
	}

	respond(w, out)
}

// tracksOf is the panel that would have answered several questions at a glance.
//
// What resolution a picture is actually being sent at, which codec carried it,
// and what the layers underneath it are — all of it known to the media server
// and, until now, visible only by reading the client's source and inferring.
func tracksOf(one *livekit.ParticipantInfo) []map[string]any {
	out := make([]map[string]any, 0, len(one.GetTracks()))

	for _, track := range one.GetTracks() {
		layers := make([]map[string]any, 0, len(track.GetLayers()))
		for _, layer := range track.GetLayers() {
			layers = append(layers, map[string]any{
				"quality": layer.GetQuality().String(),
				"width":   layer.GetWidth(),
				"height":  layer.GetHeight(),
				"bitrate": layer.GetBitrate(),
			})
		}

		out = append(out, map[string]any{
			"sid":       track.GetSid(),
			"source":    track.GetSource().String(),
			"kind":      track.GetType().String(),
			"muted":     track.GetMuted(),
			"width":     track.GetWidth(),
			"height":    track.GetHeight(),
			"mime":      track.GetMimeType(),
			"simulcast": track.GetSimulcast(),
			"layers":    layers,
		})
	}

	return out
}

// runtime reports what the process is actually running with.
//
// What it resolved to, not what the file says. More than one afternoon has gone
// into working out whether a setting took effect, by reading the source of the
// thing that consumes it. The process knows; it may as well answer.
//
// The API key is shown and the secret is not. The key names which credential is
// in use, which is the question; the secret signs tokens for every room on this
// deployment, and a management page is not a reason to put it on a screen.
func (a *API) runtime(_ Session, w http.ResponseWriter, _ *http.Request) {
	rtcConf := a.conf.LiveKit.RTC

	respond(w, map[string]any{
		"meet": map[string]any{
			"listen":     a.conf.Meet.Listen,
			"publicURL":  a.conf.Meet.PublicURL,
			"tokenTTL":   a.conf.Meet.TokenTTL.String(),
			"joinRate":   a.conf.Meet.JoinRate,
			"joinBurst":  a.conf.Meet.JoinBurst,
			"trustProxy": a.conf.Meet.TrustProxy,
			"database":   a.conf.Meet.Database,
			"admins":     len(a.Administrators()),
		},
		"rooms": a.currentPolicy(),
		"rtc": map[string]any{
			"nodeIP":        rtcConf.NodeIP.V4,
			"useExternalIP": rtcConf.UseExternalIP,
			"udpPort":       rtcConf.UDPPort.Start,
			"tcpPort":       rtcConf.TCPPort,
			"bindAddresses": a.conf.LiveKit.BindAddresses,
			"httpPort":      a.conf.LiveKit.Port,
		},
		"credentials": map[string]any{"key": a.conf.Key},
		"codecs":      codecNames(a.conf),
	})
}

func codecNames(conf *config.Config) []string {
	out := make([]string, 0, len(conf.LiveKit.Room.EnabledCodecs))
	for _, codec := range conf.LiveKit.Room.EnabledCodecs {
		out = append(out, codec.Mime)
	}

	return out
}

func (a *API) audit(_ Session, w http.ResponseWriter, _ *http.Request) {
	respond(w, a.log.Recent())
}

// Who may open a room, in the three forms worth telling apart.
//
// One number would be enough to draw a switch and not enough to explain it. The
// three separate the choice somebody made from the file it started in and from
// what the deployment can actually carry out, which is how the two ways this
// goes quietly wrong become visible instead: a file edited after first run and
// obeyed by nothing, and a policy asking for an administrator on a deployment
// that has none.
type policy struct {
	// OpenedBy is what the server is doing.
	OpenedBy room.Opening `json:"openedBy"`

	// Chosen is what was last set, before it was reconciled against whether
	// anybody exists who could satisfy it.
	Chosen room.Opening `json:"chosen"`

	// Configured is the configuration file's value, which is the starting one
	// and nothing more.
	Configured room.Opening `json:"configured"`

	// Remember is how long a name stays used after the last join, in seconds,
	// or nought where names are kept for ever.
	//
	// Beside the policy rather than somewhere of its own, because it is the
	// other half of the same sentence: this says who may open a room and that
	// says how long one stays open. Somebody reading the switch without it is
	// reading half a rule.
	Remember int64 `json:"remember"`
}

func (a *API) currentPolicy() policy {
	chosen := a.store.Opening()

	return policy{
		OpenedBy:   chosen.InEffect(len(a.Administrators())),
		Chosen:     chosen,
		Configured: a.conf.Meet.Rooms.OpenedBy,
		Remember:   int64(a.conf.Meet.Rooms.Remember / time.Second),
	}
}

func (a *API) readPolicy(_ Session, w http.ResponseWriter, _ *http.Request) {
	respond(w, a.currentPolicy())
}

// setPolicy changes who may open a room.
//
// Under moderation rather than observation, and by some distance the furthest
// reaching thing behind that gate. Closing a room ends one meeting; this decides
// whether anybody outside a short list can start one at all, and it goes on
// deciding after whoever set it has signed out and forgotten.
func (a *API) setPolicy(session Session, w http.ResponseWriter, r *http.Request) {
	var body struct {
		OpenedBy room.Opening `json:"openedBy"`
	}

	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&body); err != nil {
		refuse(w, http.StatusBadRequest, "unreadable_request")
		return
	}

	if !body.OpenedBy.Valid() {
		refuse(w, http.StatusBadRequest, "no_such_policy")
		return
	}

	err := a.store.SetOpening(body.OpenedBy)
	a.record(session, "set who may open a room", "", string(body.OpenedBy), err)

	if err != nil {
		slog.Error("failed to set who may open a room", "error", err)
		refuse(w, http.StatusInternalServerError, "store_unwritable")
		return
	}

	respond(w, a.currentPolicy())
}

func (a *API) closeRoom(session Session, w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("room")

	if !a.attached() {
		a.detached(w)
		return
	}

	if err := a.control.Close(r.Context(), name); err != nil {
		a.record(session, "close room", name, "", err)
		refuse(w, statusOf(err), reasonOf(err))
		return
	}

	a.record(session, "close room", name, "", nil)
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) removeOne(session Session, w http.ResponseWriter, r *http.Request) {
	name, identity := r.PathValue("room"), r.PathValue("identity")

	if !a.attached() {
		a.detached(w)
		return
	}

	if err := a.control.Remove(r.Context(), name, identity); err != nil {
		a.record(session, "remove participant", name, identity, err)
		refuse(w, statusOf(err), reasonOf(err))
		return
	}

	a.record(session, "remove participant", name, identity, nil)
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) muteOne(session Session, w http.ResponseWriter, r *http.Request) {
	name, identity := r.PathValue("room"), r.PathValue("identity")

	var body struct {
		Track string `json:"track"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body)

	if body.Track == "" {
		refuse(w, http.StatusBadRequest, "no_track")
		return
	}

	if !a.attached() {
		a.detached(w)
		return
	}

	if err := a.control.Mute(r.Context(), name, identity, body.Track); err != nil {
		a.record(session, "mute track", name, identity, err)
		refuse(w, statusOf(err), reasonOf(err))
		return
	}

	a.record(session, "mute track", name, identity, nil)
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) record(session Session, action, roomName, target string, err error) {
	entry := Entry{
		Action: action, Trip: session.Trip, Name: session.Name,
		Room: roomName, Target: target,
	}

	if err != nil {
		entry.Failed = true
		entry.Reason = err.Error()
	}

	a.log.Record(entry)
}

// statusOf and reasonOf keep a room that has ended apart from a server that has
// stopped answering. One of those is somebody watching a page while a call
// finishes; the other is worth waking up for.
func statusOf(err error) int {
	if errors.Is(err, rtc.ErrNoSuchRoom) {
		return http.StatusNotFound
	}

	return http.StatusBadGateway
}

func reasonOf(err error) string {
	if errors.Is(err, rtc.ErrNoSuchRoom) {
		return "no_such_room"
	}

	return "media_server_unreachable"
}

func respond(w http.ResponseWriter, body any) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(body); err != nil {
		slog.Warn("failed to write a management response", "error", err)
	}
}

func refuse(w http.ResponseWriter, status int, reason string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": reason})
}

// addressOf is who is calling, for the purpose of counting their attempts.
func addressOf(r *http.Request, trustProxy bool) string {
	if trustProxy {
		if forwarded := r.Header.Get("X-Forwarded-For"); forwarded != "" {
			if first, _, found := strings.Cut(forwarded, ","); found {
				return strings.TrimSpace(first)
			}
			return strings.TrimSpace(forwarded)
		}
	}

	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}

	return host
}

// secureRequest decides whether the session cookie may be marked Secure.
//
// A Secure cookie is dropped by the browser over plain HTTP, so marking one on
// a deployment reached without TLS would sign somebody out at the moment they
// signed in. Everything real is behind TLS; a plain-HTTP localhost is somebody
// working on this.
func secureRequest(r *http.Request, trustProxy bool) bool {
	if r.TLS != nil {
		return true
	}

	return trustProxy && r.Header.Get("X-Forwarded-Proto") == "https"
}

// SessionOf says whether a request carries a live management session.
//
// For the parts of the application outside these pages that have to know: the
// relay list is published to everybody and holds back the relays reserved for
// administrators, and an administrator reading it should see their own.
func (a *API) SessionOf(r *http.Request) (Session, bool) {
	if a == nil || a.sessions == nil {
		return Session{}, false
	}

	return a.sessions.Of(r)
}
