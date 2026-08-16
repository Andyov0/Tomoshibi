// Package admin is the management surface: who may open it, what they may do,
// and a record of what they did.
//
// It exists only where somebody configured it. With no administrators listed
// there is no sign-in page, no endpoint, and nothing to guess at — a door that
// opens for nobody is still a door, and this deployment does not fit one.
package admin

import (
	"crypto/rand"
	"encoding/base64"
	"net/http"
	"strings"
	"sync"
	"time"

	"tomoshibi/internal/config"
	"tomoshibi/internal/room"
)

// How long a session lasts without being renewed.
//
// Half an hour, which is long enough to watch a call go wrong and short enough
// that a laptop left open in a meeting room is not a standing grant.
const sessionTTL = 30 * time.Minute

// The cookie carrying a session.
//
// HttpOnly so no script can read it, Secure so it never crosses plain HTTP, and
// SameSite strict so another site cannot cause a request that carries it. The
// last of those is what stands in for a cross-site request token here: with
// strict, a form posted from anywhere else arrives with no cookie at all.
const cookieName = "meet-live.admin"

// Signed in, and what they may do.
type Session struct {
	Trip    string
	Name    string
	Can     []string
	Expires time.Time
}

// Allows reports whether this session holds a capability.
func (s Session) Allows(capability string) bool {
	return config.Admin{Trip: s.Trip, Can: s.Can}.Allows(capability)
}

// Sessions is everybody currently signed in.
//
// Held in memory and nowhere else, so restarting the server signs everybody
// out. That is the honest behaviour for a process that keeps no other state
// about people, and it means a session cannot outlive the configuration that
// authorised it.
type Sessions struct {
	// admins is asked each time rather than captured once.
	//
	// Because the list changes while the deployment runs: somebody added on a
	// page can sign in without a restart, and somebody removed cannot sign in
	// again — their open session lasts out its half hour and then asks this
	// same question and is refused. A captured slice would have made both of
	// those a restart, which ends every call in progress.
	admins  func() []config.Admin
	tripKey []byte

	mu    sync.Mutex
	open  map[string]Session
	limit *attempts
}

// NewSessions prepares the sign-in for a set of administrators.
func NewSessions(admins func() []config.Admin, tripKey []byte) *Sessions {
	return &Sessions{
		admins:  admins,
		tripKey: tripKey,
		open:    make(map[string]Session),
		limit:   newAttempts(),
	}
}

// Configured reports whether this deployment has any administrators at all.
func (s *Sessions) Configured() bool {
	return len(s.admins()) > 0
}

// Open signs somebody in, or refuses them.
//
// Recognising an administrator is [config.Administrator]'s job and not this
// one's, because the join endpoint asks the same question of the same list with
// the same key — it has to, to know who may open a room — and two answers to one
// question is one of them waiting to drift.
func (s *Sessions) Open(passphrase room.Passphrase) (Session, string, bool) {
	found, matched := config.Administrator(s.admins(), passphrase, s.tripKey)
	if !matched {
		return Session{}, "", false
	}

	session := Session{
		Trip:    found.Trip,
		Name:    found.Name,
		Can:     found.Can,
		Expires: time.Now().Add(sessionTTL),
	}

	token := secret()

	s.mu.Lock()
	s.sweep()
	s.open[token] = session
	s.mu.Unlock()

	return session, token, true
}

// Of returns the session a request carries, if it carries a live one.
func (s *Sessions) Of(r *http.Request) (Session, bool) {
	cookie, err := r.Cookie(cookieName)
	if err != nil {
		return Session{}, false
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	session, held := s.open[cookie.Value]
	if !held {
		return Session{}, false
	}

	if time.Now().After(session.Expires) {
		delete(s.open, cookie.Value)
		return Session{}, false
	}

	return session, true
}

// Close signs somebody out.
func (s *Sessions) Close(r *http.Request) {
	cookie, err := r.Cookie(cookieName)
	if err != nil {
		return
	}

	s.mu.Lock()
	delete(s.open, cookie.Value)
	s.mu.Unlock()
}

// Grant writes the cookie that carries a session.
func Grant(w http.ResponseWriter, token string, secure bool) {
	http.SetCookie(w, &http.Cookie{
		Name:     cookieName,
		Value:    token,
		Path:     "/",
		MaxAge:   int(sessionTTL.Seconds()),
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteStrictMode,
	})
}

// Revoke clears it.
func Revoke(w http.ResponseWriter, secure bool) {
	http.SetCookie(w, &http.Cookie{
		Name:     cookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteStrictMode,
	})
}

// sweep drops what has expired. Called while opening a session, which is often
// enough for a map that holds one entry per administrator.
func (s *Sessions) sweep() {
	now := time.Now()
	for token, session := range s.open {
		if now.After(session.Expires) {
			delete(s.open, token)
		}
	}
}

func secret() string {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		// A predictable session token is worse than refusing to make one.
		panic("read random bytes: " + err.Error())
	}

	return base64.RawURLEncoding.EncodeToString(raw)
}

// Signature is what a passphrase produces on this deployment.
//
// Exposed so that changing one can be checked against the signature already
// held, without the passphrase leaving this package or being written anywhere.
func (s *Sessions) Signature(passphrase string) string {
	return room.Trip(s.tripKey, strings.TrimSpace(passphrase))
}

// Moved carries every open session from one signature to another.
//
// Called when somebody changes their passphrase. Without it they would be
// signed out by their own success: the cookie in their browser names a
// signature the deployment no longer has, and the next request would be refused
// with nothing to explain it.
func (s *Sessions) Moved(from, to string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	for token, session := range s.open {
		if session.Trip == from {
			session.Trip = to
			s.open[token] = session
		}
	}
}
