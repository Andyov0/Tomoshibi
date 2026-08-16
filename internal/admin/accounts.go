package admin

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"tomoshibi/internal/store"
)

/*
Giving somebody a way in.

An administrator makes an account by choosing a name and a first passphrase. The
passphrase is turned into a signature at the moment it is typed and is not kept:
what is stored is the signature, exactly as it is for administrators, so this
database holds nothing that can be used to sign in as anybody.

That has a consequence worth stating plainly, because it is the first question
anybody asks. An administrator cannot look up somebody's passphrase and cannot
be shown it later. What they can do is set a new one, which is the useful half
of the same request and the only half that was ever safe.
*/

// Ledger is where the accounts are kept.
type Ledger interface {
	Accounts() ([]store.Account, error)
	Account(name string) (store.Account, bool)
	AddAccount(account store.Account) error
	UpdateAccount(was string, account store.Account) error
	RemoveAccount(name string) error
}

type accountView struct {
	Name     string `json:"name"`
	Trip     string `json:"trip"`
	Avatar   bool   `json:"avatar,omitempty"`
	Created  string `json:"created,omitempty"`
	LastSeen string `json:"lastSeen,omitempty"`
	Blocked  bool   `json:"blocked,omitempty"`
	Note     string `json:"note,omitempty"`
}

func (a *API) accounts(_ Session, w http.ResponseWriter, _ *http.Request) {
	if a.ledger == nil {
		a.detached(w)
		return
	}

	list, err := a.ledger.Accounts()
	if err != nil {
		refuse(w, http.StatusInternalServerError, "store_unavailable")
		return
	}

	out := make([]accountView, 0, len(list))
	for _, account := range list {
		// The avatar is reported as present rather than sent. A list of forty
		// accounts would otherwise be a couple of megabytes of pictures nobody
		// asked to see, on a page that redraws itself.
		view := accountView{
			Name: account.Name, Trip: account.Trip,
			Avatar: account.Avatar != "", Blocked: account.Blocked, Note: account.Note,
		}

		if !account.Created.IsZero() {
			view.Created = account.Created.UTC().Format("2006-01-02T15:04:05Z07:00")
		}

		if !account.LastSeen.IsZero() {
			view.LastSeen = account.LastSeen.UTC().Format("2006-01-02T15:04:05Z07:00")
		}

		out = append(out, view)
	}

	respond(w, out)
}

func (a *API) addAccount(session Session, w http.ResponseWriter, r *http.Request) {
	if a.ledger == nil {
		a.detached(w)
		return
	}

	var body struct {
		Name       string `json:"name"`
		Passphrase string `json:"passphrase"`
	}

	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil {
		refuse(w, http.StatusBadRequest, "unreadable")
		return
	}

	if len([]rune(strings.TrimSpace(body.Passphrase))) < 8 {
		refuse(w, http.StatusBadRequest, "passphrase_too_short")
		return
	}

	account := store.Account{
		Name: strings.TrimSpace(body.Name),
		Trip: a.sessions.Signature(body.Passphrase),
	}

	// Never one an administrator already uses. The two lists are separate and
	// the signature is not: somebody signing in on the front page with an
	// administrator's passphrase would be that administrator to every part of
	// this deployment that recognises people, which is all of them.
	for _, admin := range a.Administrators() {
		if admin.Trip == account.Trip {
			refuse(w, http.StatusConflict, "passphrase_in_use")
			return
		}
	}

	if err := a.ledger.AddAccount(account); err != nil {
		a.log.Record(Entry{
			Action: "add account", Trip: session.Trip, Name: session.Name,
			Target: account.Name, Failed: true, Reason: err.Error(),
		})

		failAccount(w, err)
		return
	}

	a.log.Record(Entry{
		Action: "add account", Trip: session.Trip, Name: session.Name, Target: account.Name,
	})

	// The signature is returned because it is the account's public identity —
	// it is what prints beside the name in every room — and whoever just made
	// the account is the person who has to hand it over.
	respond(w, map[string]any{"name": account.Name, "trip": account.Trip})
}

func (a *API) changeAccount(session Session, w http.ResponseWriter, r *http.Request) {
	if a.ledger == nil {
		a.detached(w)
		return
	}

	var body struct {
		Name       *string `json:"name"`
		Passphrase *string `json:"passphrase"`
		Blocked    *bool   `json:"blocked"`
		Note       *string `json:"note"`
	}

	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil {
		refuse(w, http.StatusBadRequest, "unreadable")
		return
	}

	was := r.PathValue("name")

	account, ok := a.ledger.Account(was)
	if !ok {
		refuse(w, http.StatusNotFound, "no_such_account")
		return
	}

	if body.Name != nil && strings.TrimSpace(*body.Name) != "" {
		account.Name = strings.TrimSpace(*body.Name)
	}

	if body.Blocked != nil {
		account.Blocked = *body.Blocked
	}

	if body.Note != nil {
		account.Note = strings.TrimSpace(*body.Note)
	}

	// Set rather than read. An administrator cannot be shown somebody's
	// passphrase — it was never stored — and this is the useful half of that
	// request: the person is told the new one out of band and changes it
	// themselves afterwards.
	if body.Passphrase != nil && strings.TrimSpace(*body.Passphrase) != "" {
		if len([]rune(strings.TrimSpace(*body.Passphrase))) < 8 {
			refuse(w, http.StatusBadRequest, "passphrase_too_short")
			return
		}

		account.Trip = a.sessions.Signature(*body.Passphrase)

		for _, admin := range a.Administrators() {
			if admin.Trip == account.Trip {
				refuse(w, http.StatusConflict, "passphrase_in_use")
				return
			}
		}
	}

	if err := a.ledger.UpdateAccount(was, account); err != nil {
		a.log.Record(Entry{
			Action: "change account", Trip: session.Trip, Name: session.Name,
			Target: was, Failed: true, Reason: err.Error(),
		})

		failAccount(w, err)
		return
	}

	a.log.Record(Entry{
		Action: "change account", Trip: session.Trip, Name: session.Name, Target: was,
	})

	respond(w, map[string]any{"name": account.Name, "trip": account.Trip})
}

func (a *API) dropAccount(session Session, w http.ResponseWriter, r *http.Request) {
	if a.ledger == nil {
		a.detached(w)
		return
	}

	name := r.PathValue("name")

	if err := a.ledger.RemoveAccount(name); err != nil {
		failAccount(w, err)
		return
	}

	a.log.Record(Entry{
		Action: "remove account", Trip: session.Trip, Name: session.Name, Target: name,
	})

	respond(w, map[string]any{"removed": name})
}

// failAccount turns a store's refusal into a status and a code the page says.
func failAccount(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrAccountExists):
		refuse(w, http.StatusConflict, "name_taken")
	case errors.Is(err, store.ErrAccountTripTaken):
		refuse(w, http.StatusConflict, "passphrase_in_use")
	case errors.Is(err, store.ErrNoSuchAccount):
		refuse(w, http.StatusNotFound, "no_such_account")
	case errors.Is(err, store.ErrAccountNoName), errors.Is(err, store.ErrAccountBadName),
		errors.Is(err, store.ErrAccountLongName):
		refuse(w, http.StatusBadRequest, "bad_name")
	case errors.Is(err, store.ErrAvatarTooLarge):
		refuse(w, http.StatusRequestEntityTooLarge, "avatar_too_large")
	default:
		refuse(w, http.StatusInternalServerError, "store_unavailable")
	}
}
