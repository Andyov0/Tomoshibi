package admin

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"

	"meet-live/internal/config"
	"meet-live/internal/room"
	"meet-live/internal/rtc"
	"meet-live/internal/store"

	"github.com/livekit/protocol/livekit"
)

// API is the management surface.
type API struct {
	conf     *config.Config
	sessions *Sessions
	control  *rtc.Control
	media    *rtc.Server
	store    *store.Store
	log      *Log
}

// New assembles it.
func New(conf *config.Config, media *rtc.Server, st *store.Store, tripKey []byte) *API {
	return &API{
		conf:     conf,
		sessions: NewSessions(conf.Meet.Admins, tripKey),
		control:  media.Manage(conf.Key, conf.Secret),
		media:    media,
		store:    st,
		log:      NewLog(),
	}
}

// Configured reports whether this deployment has a management surface at all.
func (a *API) Configured() bool {
	return a.sessions.Configured()
}

// Mount registers the endpoints.
//
// Nothing is registered when no administrator is configured, so the paths do
// not merely refuse — they are not there, and the client fallback answers them
// like any other unknown address.
func (a *API) Mount(mux *http.ServeMux) {
	if !a.Configured() {
		return
	}

	mux.HandleFunc("POST /api/admin/session", a.open)
	mux.HandleFunc("DELETE /api/admin/session", a.close)
	mux.HandleFunc("GET /api/admin/session", a.whoami)

	mux.HandleFunc("GET /api/admin/now", a.observe(a.now))
	mux.HandleFunc("GET /api/admin/rooms", a.observe(a.rooms))
	mux.HandleFunc("GET /api/admin/rooms/{room}/participants", a.observe(a.participants))
	mux.HandleFunc("GET /api/admin/health", a.observe(a.health))
	mux.HandleFunc("GET /api/admin/runtime", a.observe(a.runtime))
	mux.HandleFunc("GET /api/admin/audit", a.observe(a.audit))

	mux.HandleFunc("DELETE /api/admin/rooms/{room}", a.moderate(a.closeRoom))
	mux.HandleFunc("DELETE /api/admin/rooms/{room}/participants/{identity}", a.moderate(a.removeOne))
	mux.HandleFunc("POST /api/admin/rooms/{room}/participants/{identity}/mute", a.moderate(a.muteOne))
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
		Passphrase room.Passphrase `json:"passphrase"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body)

	session, token, ok := a.sessions.Open(body.Passphrase)
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
func (a *API) now(_ Session, w http.ResponseWriter, _ *http.Request) {
	stats := a.media.Stats()
	id, ip := a.media.Node()

	respond(w, map[string]any{
		"node":    map[string]string{"id": id, "ip": ip},
		"since":   Started.UTC(),
		"rooms":   stats.GetNumRooms(),
		"clients": stats.GetNumClients(),
		"tracks":  map[string]int32{"in": stats.GetNumTracksIn(), "out": stats.GetNumTracksOut()},
		"bytes": map[string]any{
			"in": stats.GetBytesIn(), "out": stats.GetBytesOut(),
			"inPerSec": stats.GetBytesInPerSec(), "outPerSec": stats.GetBytesOutPerSec(),
		},
		"packets": map[string]any{
			"nackTotal": stats.GetNackTotal(), "nackPerSec": stats.GetNackPerSec(),
		},
		"cpu": map[string]any{"count": stats.GetNumCpus(), "load": stats.GetCpuLoad()},
	})
}

func (a *API) rooms(_ Session, w http.ResponseWriter, r *http.Request) {
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

	respond(w, map[string]any{"live": liveRooms(live), "known": knownRooms(seen)})
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

func liveRooms(rooms []*livekit.Room) []map[string]any {
	out := make([]map[string]any, 0, len(rooms))
	for _, one := range rooms {
		out = append(out, map[string]any{
			"name":         one.GetName(),
			"sid":          one.GetSid(),
			"participants": one.GetNumParticipants(),
			"publishers":   one.GetNumPublishers(),
			"createdAt":    time.Unix(one.GetCreationTime(), 0).UTC(),
		})
	}

	return out
}

func (a *API) participants(_ Session, w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("room")

	people, err := a.control.Participants(r.Context(), name)
	if err != nil {
		slog.Error("failed to list participants", "room", name, "error", err)
		refuse(w, statusOf(err), reasonOf(err))
		return
	}

	out := make([]map[string]any, 0, len(people))
	for _, one := range people {
		signature, _ := room.SignatureOf(one.GetIdentity())

		out = append(out, map[string]any{
			"identity":  one.GetIdentity(),
			"name":      one.GetName(),
			"sid":       one.GetSid(),
			"state":     one.GetState().String(),
			"joinedAt":  time.Unix(one.GetJoinedAt(), 0).UTC(),
			"publisher": one.GetIsPublisher(),
			"trip":      map[string]any{"mark": signature.Trip, "proven": signature.Proven},
			"tracks":    tracksOf(one),
		})
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

func (a *API) health(_ Session, w http.ResponseWriter, _ *http.Request) {
	_, ip := a.media.Node()
	respond(w, Health(a.conf, ip))
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
			"admins":     len(a.conf.Meet.Admins),
		},
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

func (a *API) closeRoom(session Session, w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("room")

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
