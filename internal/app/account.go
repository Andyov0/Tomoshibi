package app

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"tomoshibi/internal/room"
	"tomoshibi/internal/store"
)

/*
The page somebody signs into to look after their own account.

Deliberately not the management pages. What somebody does here is change their
own passphrase and their own picture, and nothing else — no relay, no room, no
setting that belongs to the deployment. Putting the two behind one door would
mean everybody with an account holding a key to a building they have no business
in, and dressing the door differently for different people is how a page comes
to be one mistake away from showing the wrong person the wrong thing.

Recognised the same way everybody here is recognised: a name and a passphrase,
turned into a signature and compared against what was stored. This server has
never been told a passphrase in a form it keeps and still is not.
*/

// The cookie an account's own session travels in.
//
// A different name from the management one, because they are different sessions
// with different powers and a browser holding both should send each where it
// belongs. Strict, HttpOnly and Secure for the reasons the other one is.
const accountCookie = "meet-live.account"

// What kind of session this is, written into the record.
//
// Checked on every read. The two kinds share a bucket, and the thing that must
// never happen is a token from one being accepted by the other.
const accountKind = "account"

// How long an account's session lasts without being used, and at the outside.
const (
	accountIdle = 30 * 24 * time.Hour
	accountMax  = 90 * 24 * time.Hour
)

// mountAccounts registers the pages an account holder uses.
//
// Only where there is a store to hold accounts, which is everywhere but a
// relay. A deployment without one has no such addresses rather than addresses
// that refuse.
func (a *App) mountAccounts(mux *http.ServeMux) {
	if a.store == nil {
		return
	}

	mux.HandleFunc("POST /api/account/session", a.accountSignIn)
	mux.HandleFunc("DELETE /api/account/session", a.accountSignOut)
	mux.HandleFunc("GET /api/account/me", a.accountMe)
	mux.HandleFunc("POST /api/account/passphrase", a.accountPassphrase)
	mux.HandleFunc("PUT /api/account/avatar", a.accountAvatar)
	mux.HandleFunc("DELETE /api/account/avatar", a.accountAvatar)

	// Somebody's picture, by the signature it belongs to.
	//
	// Open, because it is shown beside their name in a room to everybody in
	// that room, and a picture behind a session would be a picture nobody in
	// the call could see. What it discloses is that a signature has an account
	// and what its owner chose to look like, both of which are already on
	// screen wherever they are.
	mux.HandleFunc("GET /api/avatar/{trip}", a.avatar)
}

func (a *App) accountSignIn(w http.ResponseWriter, r *http.Request) {
	// The same limiter the join uses. Signing in is the other place on this
	// deployment where somebody can try a passphrase, and a limit on one door
	// and not the other is a limit on neither.
	if !a.limit.Allow(r) {
		fail(w, http.StatusTooManyRequests, reasonRateLimited)
		return
	}

	var body struct {
		Name       string          `json:"name"`
		Passphrase room.Passphrase `json:"passphrase"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body)

	account, ok := a.store.Account(body.Name)

	// The signature is derived whether or not the name exists, so that a name
	// nobody has does not answer faster than one somebody does. Enumerating
	// accounts should not be cheaper than guessing at them.
	trip := room.Trip(a.tripKey, strings.TrimSpace(string(body.Passphrase)))

	if !ok || account.Trip != trip || body.Passphrase.Empty() {
		fail(w, http.StatusUnauthorized, reasonNotYours)
		return
	}

	if account.Blocked {
		fail(w, http.StatusForbidden, reasonBlocked)
		return
	}

	token := accountToken()
	now := time.Now().UTC()

	if err := a.store.KeepSession(token, store.Session{
		Trip: account.Trip, Name: account.Name, Kind: accountKind,
		Opened: now, Expires: now.Add(accountIdle),
	}); err != nil {
		fail(w, http.StatusInternalServerError, reasonServerError)
		return
	}

	http.SetCookie(w, &http.Cookie{
		Name:     accountCookie,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		Secure:   r.TLS != nil || forwardedProto(r, a.conf.Meet.TrustProxy) == "https",
		SameSite: http.SameSiteStrictMode,
		MaxAge:   int(accountIdle.Seconds()),
	})

	respond(w, accountOf(account))
}

func (a *App) accountSignOut(w http.ResponseWriter, r *http.Request) {
	if cookie, err := r.Cookie(accountCookie); err == nil {
		_ = a.store.DropSession(cookie.Value)
	}

	http.SetCookie(w, &http.Cookie{
		Name: accountCookie, Value: "", Path: "/", MaxAge: -1,
		HttpOnly: true, SameSite: http.SameSiteStrictMode,
	})

	w.WriteHeader(http.StatusNoContent)
}

// signedIn returns the account this request carries, if it carries a live one.
func (a *App) signedIn(r *http.Request) (store.Account, bool) {
	// A relay holds none, and the join reads this on every request. Guarded here
	// rather than at each call so that adding a second caller cannot reintroduce
	// the panic.
	if a.store == nil {
		return store.Account{}, false
	}

	cookie, err := r.Cookie(accountCookie)
	if err != nil {
		return store.Account{}, false
	}

	session, ok := a.store.Session(cookie.Value)
	if !ok || session.Kind != accountKind {
		return store.Account{}, false
	}

	now := time.Now().UTC()

	if now.After(session.Expires) || now.Sub(session.Opened) > accountMax {
		_ = a.store.DropSession(cookie.Value)
		return store.Account{}, false
	}

	account, held := a.store.Account(session.Name)
	if !held || account.Trip != session.Trip {
		// The account was removed, renamed, or had its passphrase changed by
		// somebody else. The session names something that is no longer there,
		// which is a session that has ended.
		_ = a.store.DropSession(cookie.Value)
		return store.Account{}, false
	}

	// Pushed forward by being used, and written back at most once a minute for
	// the reason the management sessions are.
	if now.Sub(session.Expires.Add(-accountIdle)) > time.Minute {
		session.Expires = now.Add(accountIdle)
		_ = a.store.KeepSession(cookie.Value, session)
	}

	return account, true
}

func (a *App) accountMe(w http.ResponseWriter, r *http.Request) {
	account, ok := a.signedIn(r)
	if !ok {
		fail(w, http.StatusUnauthorized, reasonNotYours)
		return
	}

	respond(w, accountOf(account))
}

func (a *App) accountPassphrase(w http.ResponseWriter, r *http.Request) {
	account, ok := a.signedIn(r)
	if !ok {
		fail(w, http.StatusUnauthorized, reasonNotYours)
		return
	}

	var body struct {
		Current room.Passphrase `json:"current"`
		Next    room.Passphrase `json:"next"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body)

	// The current one, even though the session already says who this is. A
	// session proves somebody signed in; this asks whether the person at the
	// keyboard now is that person, which is the question an unattended laptop
	// raises.
	if room.Trip(a.tripKey, strings.TrimSpace(string(body.Current))) != account.Trip {
		fail(w, http.StatusForbidden, reasonNotYours)
		return
	}

	next := strings.TrimSpace(string(body.Next))

	if len([]rune(next)) < 8 {
		fail(w, http.StatusBadRequest, reasonPassphraseShort)
		return
	}

	was := account.Trip
	account.Trip = room.Trip(a.tripKey, next)

	if account.Trip == was {
		fail(w, http.StatusBadRequest, reasonPassphraseSame)
		return
	}

	if err := a.store.UpdateAccount(account.Name, account); err != nil {
		fail(w, http.StatusConflict, reasonPassphraseTaken)
		return
	}

	// Carried across, or they would be signed out by their own success.
	if cookie, err := r.Cookie(accountCookie); err == nil {
		if session, held := a.store.Session(cookie.Value); held {
			session.Trip = account.Trip
			_ = a.store.KeepSession(cookie.Value, session)
		}
	}

	respond(w, accountOf(account))
}

func (a *App) accountAvatar(w http.ResponseWriter, r *http.Request) {
	account, ok := a.signedIn(r)
	if !ok {
		fail(w, http.StatusUnauthorized, reasonNotYours)
		return
	}

	if r.Method == http.MethodDelete {
		account.Avatar = ""
	} else {
		var body struct {
			Image string `json:"image"`
		}

		// Room for the picture and very little else. The client scales it down
		// long before this; the limit is here because a limit the server does
		// not enforce is a suggestion.
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 96<<10)).Decode(&body); err != nil {
			fail(w, http.StatusRequestEntityTooLarge, reasonAvatarLarge)
			return
		}

		if !strings.HasPrefix(body.Image, "data:image/") {
			fail(w, http.StatusBadRequest, reasonNotAnImage)
			return
		}

		account.Avatar = body.Image
	}

	if err := a.store.UpdateAccount(account.Name, account); err != nil {
		fail(w, http.StatusBadRequest, reasonAvatarLarge)
		return
	}

	respond(w, accountOf(account))
}

func (a *App) avatar(w http.ResponseWriter, r *http.Request) {
	account, ok := a.store.AccountBySignature(r.PathValue("trip"))
	if !ok || account.Avatar == "" {
		http.NotFound(w, r)
		return
	}

	kind, data, found := strings.Cut(account.Avatar, ",")
	if !found || !strings.HasSuffix(kind, ";base64") {
		http.NotFound(w, r)
		return
	}

	raw, err := base64.StdEncoding.DecodeString(data)
	if err != nil {
		http.NotFound(w, r)
		return
	}

	// The type the picture says it is, from the part of the data URI before the
	// encoding — and only from the handful this accepts, so a stored string
	// cannot name a type that makes a browser do something other than draw it.
	media := strings.TrimSuffix(strings.TrimPrefix(kind, "data:"), ";base64")

	switch media {
	case "image/png", "image/jpeg", "image/webp", "image/gif":
	default:
		http.NotFound(w, r)
		return
	}

	w.Header().Set("Content-Type", media)
	w.Header().Set("Cache-Control", "private, max-age=60")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_, _ = w.Write(raw)
}

// accountOf is what an account holder is told about themselves.
//
// Never the signature of anybody else and never a passphrase, because there is
// none to tell. The picture comes back as a URL rather than as itself, so the
// page that shows it and the page that shows everybody else's use one path.
type accountView struct {
	Name    string `json:"name"`
	Trip    string `json:"trip"`
	Avatar  string `json:"avatar,omitempty"`
	Created string `json:"created,omitempty"`
}

func accountOf(account store.Account) accountView {
	view := accountView{Name: account.Name, Trip: account.Trip}

	if account.Avatar != "" {
		view.Avatar = "/api/avatar/" + account.Trip
	}

	if !account.Created.IsZero() {
		view.Created = account.Created.UTC().Format(time.RFC3339)
	}

	return view
}

func accountToken() string {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		// crypto/rand does not fail on any platform this runs on, and a
		// predictable session token is worse than not answering.
		panic("read random bytes: " + err.Error())
	}

	return base64.RawURLEncoding.EncodeToString(raw)
}
