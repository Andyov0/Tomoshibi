package rtc

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/livekit/protocol/auth"
)

// StatsPath is where a relay reports on itself.
//
// Under /twirp rather than beside it, so that it is covered by whatever already
// protects the media server's own API: a deployment that restricts those paths
// to its control node gets this for free rather than having to be told about a
// second one.
const StatsPath = "/twirp/relay.stats"

// Stats is what one relay knows about itself.
//
// Read from the media server's own counters, which only the process holding
// them can see. This is why a control node cannot simply work these out: it has
// no media server, and no amount of asking redis produces a CPU load.
type Stats struct {
	Node      string `json:"node"`
	IP        string `json:"ip"`
	Rooms     int32  `json:"rooms"`
	Clients   int32  `json:"clients"`
	TracksIn  int32  `json:"tracksIn"`
	TracksOut int32  `json:"tracksOut"`

	BytesIn  uint64 `json:"bytesIn"`
	BytesOut uint64 `json:"bytesOut"`

	// InPerSec and OutPerSec are means over Window, not instantaneous. Sent
	// with the window rather than without it, because a rate that does not say
	// what it is averaged over is read as the wrong one.
	InPerSec  float64 `json:"inPerSec"`
	OutPerSec float64 `json:"outPerSec"`
	Window    float64 `json:"window"`

	NackTotal  uint64  `json:"nackTotal"`
	NackPerSec float32 `json:"nackPerSec"`

	CPUs uint32  `json:"cpus"`
	Load float32 `json:"load"`

	// StartedAt is when this relay came up, so a control node can say which of
	// its relays was restarted without asking anybody.
	StartedAt time.Time `json:"startedAt"`
}

// Read takes one reading from the embedded media server.
func (s *Server) Read(started time.Time) Stats {
	stats := s.Stats()
	in, out, window := s.Throughput()
	id, ip := s.Node()

	return Stats{
		Node: id, IP: ip,
		Rooms: stats.GetNumRooms(), Clients: stats.GetNumClients(),
		TracksIn: stats.GetNumTracksIn(), TracksOut: stats.GetNumTracksOut(),
		BytesIn: stats.GetBytesIn(), BytesOut: stats.GetBytesOut(),
		InPerSec: in, OutPerSec: out, Window: window.Seconds(),
		NackTotal: stats.GetNackTotal(), NackPerSec: stats.GetNackPerSec(),
		CPUs: stats.GetNumCpus(), Load: stats.GetCpuLoad(),
		StartedAt: started.UTC(),
	}
}

// StatsHandler serves one relay's own counters to whoever holds the
// deployment's credentials.
//
// Behind the same token the management API is behind, and for the same reason.
// These figures say how many people are in calls here and how much is flowing,
// which is not a secret worth much on its own and is exactly the shape of thing
// that should not be readable by anybody who finds the port.
func StatsHandler(server *Server, key, secret string, started time.Time) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !authorised(r, key, secret) {
			// The same answer an unauthenticated twirp call gets, so this path
			// does not stand out from the ones beside it.
			w.WriteHeader(http.StatusUnauthorized)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(server.Read(started))
	})
}

// authorised checks the bearer token a control node signs.
//
// Verified with the same secret the media server verifies join tokens with, so
// there is no second credential: whoever can sign a join for this deployment
// can read this, and nobody else can.
func authorised(r *http.Request, key, secret string) bool {
	header := r.Header.Get("Authorization")
	if len(header) < 8 || header[:7] != "Bearer " {
		return false
	}

	verifier, err := auth.ParseAPIToken(header[7:])
	if err != nil {
		return false
	}

	if verifier.APIKey() != key {
		return false
	}

	_, grants, err := verifier.Verify(secret)
	if err != nil || grants == nil || grants.Video == nil {
		return false
	}

	// A grant nobody joining a call is given.
	//
	// This used to accept any token this deployment signed, on the reasoning
	// that holding one proves you hold the secret. That is true of the tokens
	// this server mints for itself and false of the one it hands to every
	// anonymous visitor at the door: a join token is signed with the same
	// secret, so anybody who joined any room could read every relay's node
	// identity, address, room and client counts, byte totals and processor load
	// — which is exactly the shape of thing the comment above this handler says
	// must not be readable by whoever finds the port.
	return grants.Video.RoomList || grants.Video.RoomAdmin
}

// AskStats reads one relay's counters over the network.
func (c *Cluster) AskStats(ctx context.Context, relay string) (Stats, error) {
	var stats Stats

	control := c.controlFor(relay)

	// The same shape of token the management calls carry, minted per request
	// and valid for a minute. The grant matters: it is what the far end checks,
	// and it is one nobody joining a call is given — the token
	// proves its holder has this deployment's secret, which is the whole check.
	token, err := auth.NewAccessToken(control.key, control.secret).
		SetIdentity("tomoshibi").
		SetVideoGrant(&auth.VideoGrant{RoomList: true}).
		SetValidFor(time.Minute).
		ToJWT()
	if err != nil {
		return stats, fmt.Errorf("mint a token for the relay stats: %w", err)
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, control.upstream+StatsPath, nil)
	if err != nil {
		return stats, err
	}
	request.Header.Set("Authorization", "Bearer "+token)

	response, err := c.client.Do(request)
	if err != nil {
		return stats, err
	}
	defer response.Body.Close()

	if response.StatusCode != http.StatusOK {
		return stats, fmt.Errorf("relay %s answered %d", relay, response.StatusCode)
	}

	if err := json.NewDecoder(response.Body).Decode(&stats); err != nil {
		return stats, err
	}

	return stats, nil
}

// SendCertificate hands one relay a renewed certificate.
//
// Answers without error when the relay kept what it already had, which is the
// ordinary case: this is sent to everybody whenever the file on the control
// node changes, and no record is kept of who has what. Keeping that record
// would be a second thing to go stale, and the far end can answer the question
// from the file it is serving.
func (c *Cluster) SendCertificate(ctx context.Context, relay string, cert Certificate) (time.Time, error) {
	control := c.controlFor(relay)

	token, err := auth.NewAccessToken(control.key, control.secret).
		SetIdentity("tomoshibi").
		SetVideoGrant(&auth.VideoGrant{RoomList: true}).
		SetValidFor(time.Minute).
		ToJWT()
	if err != nil {
		return time.Time{}, fmt.Errorf("mint a token for the certificate push: %w", err)
	}

	body, err := json.Marshal(cert)
	if err != nil {
		return time.Time{}, err
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodPut,
		control.upstream+CertificatePath, bytes.NewReader(body))
	if err != nil {
		return time.Time{}, err
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")

	response, err := c.client.Do(request)
	if err != nil {
		return time.Time{}, err
	}
	defer response.Body.Close()

	if response.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, response.Body)

		return time.Time{}, fmt.Errorf("relay %s answered %d", relay, response.StatusCode)
	}

	// What it is serving now, which is not always what was sent.
	//
	// A relay may hold a certificate this node has no copy of — two here have
	// one for their own bare address, issued and renewed on the machine itself
	// because the name they used to answer to is filtered on the path that
	// reaches them. Those are short-lived, six days, and depend on a cron job
	// nobody watches. Reading the date back is the whole of watching it: this
	// node already talks to every relay every hour, and the answer costs a field.
	var said struct {
		Expires time.Time `json:"expires"`
	}
	if err := json.NewDecoder(response.Body).Decode(&said); err != nil {
		// An older relay says nothing here. Not knowing is not a failure.
		return time.Time{}, nil
	}

	return said.Expires, nil
}
