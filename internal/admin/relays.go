package admin

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"tomoshibi/internal/store"
)

// Relays is what the management pages need of the list of media servers.
//
// An interface for the reason the three above it are: the pages that add and
// remove one are gates, and a gate that needs a real database behind it to be
// exercised is a gate nobody exercises.
type Relays interface {
	Relays() ([]store.Relay, error)
	AddRelay(relay store.Relay) error
	UpdateRelay(relay store.Relay) error
	RemoveRelay(name string) error
}

// Reachable is how a page finds out whether a relay is answering.
//
// Separate from the store because it is a different kind of question: the store
// says what somebody configured, and this says what is true. A relay can be
// listed and unreachable, which is precisely the state an operator opens this
// page to discover.
type Reachable interface {
	Check(ctx context.Context, url string) (ok bool, took time.Duration, detail string)
}

// relayView is one relay as a page sees it: what was configured, plus whether
// it is answering.
type relayView struct {
	Name     string `json:"name"`
	URL      string `json:"url"`
	Region   string `json:"region,omitempty"`
	Label    string `json:"label,omitempty"`
	Fallback bool   `json:"fallback,omitempty"`
	Enabled  bool   `json:"enabled"`
	Added    string `json:"added,omitempty"`

	// Reachable and Latency are measured when the page is drawn, from this
	// machine. A client's own measurement may differ and usually will — this is
	// whether the relay is up, not whether it is near anybody.
	Reachable bool   `json:"reachable"`
	LatencyMS int64  `json:"latencyMs,omitempty"`
	Detail    string `json:"detail,omitempty"`
}

// listRelays draws the relay list, checking each one as it goes.
//
// Checked in parallel and bounded, because this is drawn on a page somebody is
// waiting in front of and one unreachable relay would otherwise hold the whole
// list for as long as its timeout.
func (a *API) listRelays(_ Session, w http.ResponseWriter, r *http.Request) {
	if a.relays == nil {
		refuse(w, http.StatusServiceUnavailable, "no_relay_list")
		return
	}

	list, err := a.relays.Relays()
	if err != nil {
		refuse(w, http.StatusInternalServerError, "store_unavailable")
		return
	}

	views := make([]relayView, len(list))

	var wait sync.WaitGroup
	for i, relay := range list {
		views[i] = relayView{
			Name: relay.Name, URL: relay.URL, Region: relay.Region,
			Label: relay.Label, Fallback: relay.Fallback,
			Enabled: relay.Enabled,
		}
		if !relay.Added.IsZero() {
			views[i].Added = relay.Added.UTC().Format(time.RFC3339)
		}

		if a.probe == nil {
			continue
		}

		wait.Add(1)
		go func(i int, url string) {
			defer wait.Done()

			ok, took, detail := a.probe.Check(r.Context(), url)

			views[i].Reachable = ok
			views[i].LatencyMS = took.Milliseconds()
			views[i].Detail = detail
		}(i, relay.URL)
	}
	wait.Wait()

	respond(w, map[string]any{"relays": views})
}

// addRelay puts a new media server into service.
//
// The reason this is a page rather than a line in a file: a relay is added when
// a machine is brought up, and editing a file and restarting to record that
// would drop every call the control node is holding — for an operation that
// changes nothing about the calls already in progress.
func (a *API) addRelay(session Session, w http.ResponseWriter, r *http.Request) {
	if a.relays == nil {
		refuse(w, http.StatusServiceUnavailable, "no_relay_list")
		return
	}

	var body struct {
		Name     string `json:"name"`
		URL      string `json:"url"`
		Region   string `json:"region"`
		Label    string `json:"label"`
		Fallback bool   `json:"fallback"`
		Enabled  *bool  `json:"enabled"`
	}

	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
		refuse(w, http.StatusBadRequest, "unreadable")
		return
	}

	relay := store.Relay{
		Name:     strings.TrimSpace(body.Name),
		URL:      strings.TrimSpace(body.URL),
		Region:   strings.TrimSpace(body.Region),
		Label:    strings.TrimSpace(body.Label),
		Fallback: body.Fallback,
		Enabled:  body.Enabled == nil || *body.Enabled,
		Added:    time.Now().UTC(),
	}

	if err := a.relays.AddRelay(relay); err != nil {
		// The store's message names what is wrong with this particular entry,
		// which is worth more to whoever is typing it than a code would be.
		a.log.Record(Entry{
			Action: "add relay", Trip: session.Trip, Target: relay.Name,
			Failed: true, Reason: err.Error(),
		})
		refuse(w, http.StatusBadRequest, relayReason(err))
		return
	}

	a.log.Record(Entry{Action: "add relay", Trip: session.Trip, Target: relay.Name})
	a.changed()

	respond(w, map[string]any{"added": relay.Name})
}

// editRelay changes an address, a region, or whether clients are sent there.
//
// The name is the key and is not editable. A client that measured this relay a
// moment ago will name it at the join, and a rename would leave that client
// falling back as though it had measured nothing.
func (a *API) editRelay(session Session, w http.ResponseWriter, r *http.Request) {
	if a.relays == nil {
		refuse(w, http.StatusServiceUnavailable, "no_relay_list")
		return
	}

	name := r.PathValue("relay")

	var body struct {
		URL      string  `json:"url"`
		Region   string  `json:"region"`
		Label    *string `json:"label"`
		Fallback *bool   `json:"fallback"`
		Enabled  *bool   `json:"enabled"`
	}

	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
		refuse(w, http.StatusBadRequest, "unreadable")
		return
	}

	list, err := a.relays.Relays()
	if err != nil {
		refuse(w, http.StatusInternalServerError, "store_unavailable")
		return
	}

	var found *store.Relay
	for i := range list {
		if list[i].Name == name {
			found = &list[i]
			break
		}
	}

	if found == nil {
		refuse(w, http.StatusNotFound, "no_such_relay")
		return
	}

	// Absent fields leave what is there. A page that edits one thing should not
	// have to send back the two it did not touch.
	if strings.TrimSpace(body.URL) != "" {
		found.URL = strings.TrimSpace(body.URL)
	}
	if body.Region != "" {
		found.Region = strings.TrimSpace(body.Region)
	}
	if body.Enabled != nil {
		found.Enabled = *body.Enabled
	}

	// Pointers for these three, so that clearing a label and leaving it alone
	// are different requests. An empty string is a thing somebody meant.
	if body.Label != nil {
		found.Label = strings.TrimSpace(*body.Label)
	}
	if body.Fallback != nil {
		found.Fallback = *body.Fallback
	}

	if err := a.relays.UpdateRelay(*found); err != nil {
		a.log.Record(Entry{
			Action: "edit relay", Trip: session.Trip, Target: name,
			Failed: true, Reason: err.Error(),
		})
		refuse(w, http.StatusBadRequest, relayReason(err))
		return
	}

	a.log.Record(Entry{Action: "edit relay", Trip: session.Trip, Target: name})
	a.changed()

	respond(w, map[string]any{"updated": name})
}

// dropRelay takes one out of the list entirely.
//
// Calls already on it are not ended: this server has no way to reach into
// another machine's sessions and no business doing so. What stops is being sent
// there. Disabling is the gentler operation and is what an operator usually
// wants; this one is for a machine that is gone.
func (a *API) dropRelay(session Session, w http.ResponseWriter, r *http.Request) {
	if a.relays == nil {
		refuse(w, http.StatusServiceUnavailable, "no_relay_list")
		return
	}

	name := r.PathValue("relay")

	if err := a.relays.RemoveRelay(name); err != nil {
		a.log.Record(Entry{
			Action: "remove relay", Trip: session.Trip, Target: name,
			Failed: true, Reason: err.Error(),
		})
		refuse(w, http.StatusNotFound, "no_such_relay")
		return
	}

	a.log.Record(Entry{Action: "remove relay", Trip: session.Trip, Target: name})
	a.changed()

	respond(w, map[string]any{"removed": name})
}

// changed tells whoever is choosing relays that the list moved.
//
// Without it a relay added here would not be offered until the choosing side's
// own cache expired, and the person who added it would be looking at a page
// saying it is there beside a join that does not use it.
func (a *API) changed() {
	if a.onRelaysChanged != nil {
		a.onRelaysChanged()
	}
}

// relayReason turns a store's refusal into a code the page has a sentence for.
//
// Codes and not sentences: the words on a management page are translated into
// four languages there, and an English string returned from here would arrive
// on screen in whichever language the server happened to be written in.
func relayReason(err error) string {
	switch {
	case errors.Is(err, store.ErrRelayExists):
		return "relay_exists"
	case errors.Is(err, store.ErrNoSuchRelay):
		return "no_such_relay"
	case errors.Is(err, store.ErrRelayNoName):
		return "relay_no_name"
	case errors.Is(err, store.ErrRelayLongName):
		return "relay_long_name"
	case errors.Is(err, store.ErrRelayNoURL):
		return "relay_no_url"
	case errors.Is(err, store.ErrRelayBadURL):
		return "relay_bad_url"
	case errors.Is(err, store.ErrRelayLongTag):
		return "relay_long_region"
	default:
		return "relay_refused"
	}
}
