package admin

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"tomoshibi/internal/config"
	"tomoshibi/internal/store"
)

/*
Managing who else may open these pages.

Somebody is recognised here by the signature their passphrase produces, never by
the passphrase itself — this server is never told one and could not store one if
it wanted to. The signature is already public: it prints beside its owner's name
in every room they join, which is also how somebody being added finds out what to
hand over. So adding an administrator is adding a name and a signature, and the
person being added does not have to trust anybody with anything.

Adding requires moderate, because being able to grant an ability is the same
ability. An observer who could appoint a moderator would be a moderator with an
extra step.
*/

// rosterEntry is one administrator as a page sees them.
type rosterEntry struct {
	Trip  string   `json:"trip"`
	Name  string   `json:"name"`
	Can   []string `json:"can"`
	Added string   `json:"added,omitempty"`
	// Self marks the entry belonging to whoever is reading, so a page can say
	// so and can refuse to let somebody quietly remove their own way back in.
	Self bool `json:"self,omitempty"`
}

func (a *API) roles(session Session, w http.ResponseWriter, _ *http.Request) {
	if a.roster == nil {
		a.detached(w)
		return
	}

	list, err := a.roster.Admins()
	if err != nil {
		fail(w, err)
		return
	}

	// Falling back to the file rather than answering empty. A deployment that
	// has not adopted yet has administrators — somebody is signed in reading
	// this — and a page that showed none would invite adding one that is
	// already there.
	if len(list) == 0 {
		for _, one := range a.conf.Meet.Admins {
			list = append(list, store.Admin{Trip: one.Trip, Name: one.Name, Can: one.Can})
		}
	}

	out := make([]rosterEntry, 0, len(list))
	for _, one := range list {
		entry := rosterEntry{
			Trip: one.Trip,
			Name: one.Name,
			Can:  capabilitiesOf(one.Configured()),
			Self: one.Trip == session.Trip,
		}

		if !one.Added.IsZero() {
			entry.Added = one.Added.UTC().Format("2006-01-02T15:04:05Z07:00")
		}

		out = append(out, entry)
	}

	respond(w, out)
}

// roleRequest is what a page sends to add somebody or change what they may do.
type roleRequest struct {
	Trip string   `json:"trip"`
	Name string   `json:"name"`
	Can  []string `json:"can"`
}

func (a *API) addRole(session Session, w http.ResponseWriter, r *http.Request) {
	if a.roster == nil {
		a.detached(w)
		return
	}

	var body roleRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil {
		refuse(w, http.StatusBadRequest, "unreadable")
		return
	}

	admin := store.Admin{
		Trip: strings.ToLower(strings.TrimSpace(body.Trip)),
		Name: strings.TrimSpace(body.Name),
		Can:  clean(body.Can),
	}

	if err := a.roster.AddAdmin(admin); err != nil {
		a.log.Record(Entry{
			Action: "add administrator", Trip: session.Trip, Name: session.Name,
			Target: admin.Trip, Failed: true, Reason: reasonFor(err),
		})

		fail(w, err)
		return
	}

	a.log.Record(Entry{
		Action: "add administrator", Trip: session.Trip, Name: session.Name,
		Target: admin.Trip,
	})

	respond(w, map[string]any{"added": admin.Trip})
}

func (a *API) changeRole(session Session, w http.ResponseWriter, r *http.Request) {
	if a.roster == nil {
		a.detached(w)
		return
	}

	var body roleRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil {
		refuse(w, http.StatusBadRequest, "unreadable")
		return
	}

	trip := r.PathValue("trip")

	admin := store.Admin{Trip: trip, Name: strings.TrimSpace(body.Name), Can: clean(body.Can)}

	if err := a.roster.UpdateAdmin(admin); err != nil {
		a.log.Record(Entry{
			Action: "change administrator", Trip: session.Trip, Name: session.Name,
			Target: trip, Failed: true, Reason: reasonFor(err),
		})

		fail(w, err)
		return
	}

	a.log.Record(Entry{
		Action: "change administrator", Trip: session.Trip, Name: session.Name, Target: trip,
	})

	respond(w, map[string]any{"changed": trip})
}

func (a *API) dropRole(session Session, w http.ResponseWriter, r *http.Request) {
	if a.roster == nil {
		a.detached(w)
		return
	}

	trip := r.PathValue("trip")

	if err := a.roster.RemoveAdmin(trip); err != nil {
		a.log.Record(Entry{
			Action: "remove administrator", Trip: session.Trip, Name: session.Name,
			Target: trip, Failed: true, Reason: reasonFor(err),
		})

		fail(w, err)
		return
	}

	a.log.Record(Entry{
		Action: "remove administrator", Trip: session.Trip, Name: session.Name, Target: trip,
	})

	respond(w, map[string]any{"removed": trip})
}

// clean keeps only capabilities this deployment has, and drops the rest.
//
// Silently, because the alternative is refusing a request over a word nobody
// typed: these arrive from checkboxes, and a name that is not one of the two is
// a page and a server that disagree rather than an administrator making a
// mistake. What matters is that nothing unrecognised is stored, since a later
// version that gave that word a meaning would be granting an ability nobody
// chose.
func clean(can []string) []string {
	out := make([]string, 0, len(can))

	for _, one := range can {
		switch one {
		case config.Observe, config.Moderate:
			out = append(out, one)
		}
	}

	return out
}

// capabilitiesOf spells out what somebody may do, including what they hold by
// default rather than by being granted it.
func capabilitiesOf(admin config.Admin) []string {
	out := []string{config.Observe}
	if admin.Allows(config.Moderate) {
		out = append(out, config.Moderate)
	}

	return out
}

// fail turns a store's refusal into a status and a code the page can say.
//
// Codes rather than sentences, as everywhere else here: the page owns the
// wording and says it in the reader's own language, and an English string
// returned from the server arrives on screen untranslated.
func fail(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrAdminExists):
		refuse(w, http.StatusConflict, "already_an_administrator")
	case errors.Is(err, store.ErrNoSuchAdmin):
		refuse(w, http.StatusNotFound, "no_such_administrator")
	case errors.Is(err, store.ErrLastModerator):
		refuse(w, http.StatusConflict, "last_moderator")
	case errors.Is(err, store.ErrAdminNoTrip), errors.Is(err, store.ErrAdminBadTrip):
		refuse(w, http.StatusBadRequest, "not_a_signature")
	case errors.Is(err, store.ErrAdminLongName):
		refuse(w, http.StatusBadRequest, "name_too_long")
	case errors.Is(err, store.ErrAdminBadCan):
		refuse(w, http.StatusBadRequest, "unknown_capability")
	default:
		refuse(w, http.StatusInternalServerError, "store_unavailable")
	}
}

// reasonFor is the same set, for the audit log, which is read by people rather
// than by a page and so keeps the sentence.
func reasonFor(err error) string {
	if err == nil {
		return ""
	}

	return err.Error()
}

// changeOwnPassphrase moves whoever is signed in to a new signature.
//
// There is no password on this server to change. The passphrase is never sent
// here in a form anything keeps and never written down — what is stored is the
// signature it produces — so rotating one means being recognised by a new
// signature from now on, and that is what this does.
//
// The old passphrase is required even though the session already proves who
// this is. What a session proves is that somebody was signed in; what this asks
// is whether the person at the keyboard now is the one who signed in then. An
// unattended laptop is exactly the case where those differ, and it is exactly
// the case where a silent change of credentials is worth something to whoever
// walked past.
func (a *API) changeOwnPassphrase(session Session, w http.ResponseWriter, r *http.Request) {
	if a.roster == nil {
		a.detached(w)
		return
	}

	var body struct {
		Current string `json:"current"`
		Next    string `json:"next"`
	}

	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil {
		refuse(w, http.StatusBadRequest, "unreadable")
		return
	}

	if strings.TrimSpace(body.Next) == "" {
		refuse(w, http.StatusBadRequest, "no_passphrase")
		return
	}

	// Long enough to be worth having. This is the only credential on the
	// deployment and it is checked by an endpoint anybody can reach, so a short
	// one is a short one whichever way it is stored.
	if len([]rune(strings.TrimSpace(body.Next))) < 8 {
		refuse(w, http.StatusBadRequest, "passphrase_too_short")
		return
	}

	if a.sessions.Signature(body.Current) != session.Trip {
		a.log.Record(Entry{
			Action: "change passphrase", Trip: session.Trip, Name: session.Name,
			Failed: true, Reason: "the current passphrase did not match",
		})

		refuse(w, http.StatusForbidden, "wrong_passphrase")
		return
	}

	next := a.sessions.Signature(body.Next)

	if next == session.Trip {
		// The same passphrase. Refused rather than quietly succeeding, because
		// somebody who thought they had changed it would go on believing so.
		refuse(w, http.StatusBadRequest, "passphrase_unchanged")
		return
	}

	if err := a.roster.ReplaceAdminTrip(session.Trip, next); err != nil {
		a.log.Record(Entry{
			Action: "change passphrase", Trip: session.Trip, Name: session.Name,
			Failed: true, Reason: reasonFor(err),
		})

		fail(w, err)
		return
	}

	// Carried across, or they would be signed out by their own success: the
	// cookie in their browser names a signature this deployment no longer has.
	a.sessions.Moved(session.Trip, next)

	a.log.Record(Entry{
		Action: "change passphrase", Trip: next, Name: session.Name,
	})

	// The new signature is returned because it is what prints beside their name
	// in every room from now on, and somebody who has just changed it is the one
	// person who needs to know it changed.
	respond(w, map[string]any{"trip": next})
}
