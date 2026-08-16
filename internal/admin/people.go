package admin

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"tomoshibi/internal/store"
)

/*
The register of people who keep coming back, and the door.

There are no accounts on this deployment and this does not invent any. What is
listed is everybody who has joined with a passphrase — their signature, what
they last called themselves, when they were first and last seen, and how many
times. Somebody who has never set a passphrase is not here at all: their
signature is drawn from nothing and differs in every tab, so a list of them
would be a list of tabs.

The useful thing on this page is the door. A participant can be removed from a
room and a room can be closed, and both are undone the moment they rejoin;
blocking is checked at the join, which is the only point at which anybody asks
to come in.
*/

// Register is where the people are kept.
type Register interface {
	People() ([]store.Person, error)
	SetBlocked(trip string, blocked bool, note string) error
	ForgetPerson(trip string) error
}

type personView struct {
	Trip      string `json:"trip"`
	Name      string `json:"name,omitempty"`
	Rooms     int    `json:"rooms"`
	FirstSeen string `json:"firstSeen,omitempty"`
	LastSeen  string `json:"lastSeen,omitempty"`
	Blocked   bool   `json:"blocked,omitempty"`
	Note      string `json:"note,omitempty"`
	// Administrator marks somebody who is also on the other list, so a page can
	// say so rather than offering to block them and being refused.
	Administrator bool `json:"administrator,omitempty"`
}

func (a *API) people(_ Session, w http.ResponseWriter, _ *http.Request) {
	if a.register == nil {
		a.detached(w)
		return
	}

	list, err := a.register.People()
	if err != nil {
		refuse(w, http.StatusInternalServerError, "store_unavailable")
		return
	}

	admins := map[string]bool{}
	for _, one := range a.Administrators() {
		admins[one.Trip] = true
	}

	out := make([]personView, 0, len(list))
	for _, person := range list {
		view := personView{
			Trip: person.Trip, Name: person.Name, Rooms: person.Rooms,
			Blocked: person.Blocked, Note: person.Note,
			Administrator: admins[person.Trip],
		}

		if !person.FirstSeen.IsZero() {
			view.FirstSeen = person.FirstSeen.UTC().Format("2006-01-02T15:04:05Z07:00")
		}

		if !person.LastSeen.IsZero() {
			view.LastSeen = person.LastSeen.UTC().Format("2006-01-02T15:04:05Z07:00")
		}

		out = append(out, view)
	}

	respond(w, out)
}

func (a *API) blockPerson(session Session, w http.ResponseWriter, r *http.Request) {
	if a.register == nil {
		a.detached(w)
		return
	}

	var body struct {
		Blocked bool   `json:"blocked"`
		Note    string `json:"note"`
	}

	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil {
		refuse(w, http.StatusBadRequest, "unreadable")
		return
	}

	trip := r.PathValue("trip")

	// An administrator cannot be blocked from here.
	//
	// Not because it would fail — the join lets administrators past this check
	// — but because a setting that is quietly ignored is worse than one that is
	// refused: somebody would set it, believe it, and be wrong.
	for _, one := range a.Administrators() {
		if one.Trip == trip && body.Blocked {
			refuse(w, http.StatusConflict, "is_an_administrator")
			return
		}
	}

	if err := a.register.SetBlocked(trip, body.Blocked, body.Note); err != nil {
		a.log.Record(Entry{
			Action: "block", Trip: session.Trip, Name: session.Name,
			Target: trip, Failed: true, Reason: err.Error(),
		})

		if errors.Is(err, store.ErrNoSuchPerson) {
			refuse(w, http.StatusNotFound, "no_such_person")
			return
		}

		refuse(w, http.StatusInternalServerError, "store_unavailable")
		return
	}

	action := "readmit"
	if body.Blocked {
		action = "block"
	}

	a.log.Record(Entry{
		Action: action, Trip: session.Trip, Name: session.Name,
		Target: trip, Reason: strings.TrimSpace(body.Note),
	})

	respond(w, map[string]any{"trip": trip, "blocked": body.Blocked})
}

func (a *API) forgetPerson(session Session, w http.ResponseWriter, r *http.Request) {
	if a.register == nil {
		a.detached(w)
		return
	}

	trip := r.PathValue("trip")

	if err := a.register.ForgetPerson(trip); err != nil {
		if errors.Is(err, store.ErrNoSuchPerson) {
			refuse(w, http.StatusNotFound, "no_such_person")
			return
		}

		refuse(w, http.StatusInternalServerError, "store_unavailable")
		return
	}

	// Worth its own line in the log, and worth being distinct from readmitting:
	// forgetting somebody who was blocked lets them back in, and reading
	// "forgot" later should not leave anybody wondering whether it did.
	a.log.Record(Entry{
		Action: "forget", Trip: session.Trip, Name: session.Name, Target: trip,
	})

	respond(w, map[string]any{"forgotten": trip})
}
