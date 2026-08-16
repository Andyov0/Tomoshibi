package app

import (
	"net/http"
	"strings"
)

/*
Some networks decide what a machine is by asking it.

A relay in mainland China is probed: something opens its TLS port, sends an
ordinary HTTPS request, and reads the answer. A 204, a 401, even a 404 — any of
them is a server saying "I am a website", and an unregistered website is closed
down. The relay never did anything wrong; it answered politely, which was
enough.

A WebSocket endpoint does not have to answer politely. The only request it
exists for carries an Upgrade header, and everything else can be met with
nothing at all: no status line, no body, the connection simply closed. A prober
learns that the port accepts TCP and completes TLS, and not one thing more.

This costs the relay its health endpoint, which is what a control node's page
and a client's measurement both use. That is the trade, and it is why this is a
setting rather than the default: a relay outside such a network should stay
readable, because being able to ask whether it is up is worth having.
*/

// silence closes any request that is not a WebSocket upgrade, without
// answering it.
//
// Hijacked and closed rather than answered with a status. Every status is an
// answer, and an answer is the thing being avoided: a prober that receives 400
// has still learned there is an HTTP server here. Closing mid-request is
// indistinguishable from a connection that failed, which is what a port with
// nothing to say should look like.
func silence(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if isUpgrade(r) {
			next.ServeHTTP(w, r)
			return
		}

		hijacker, ok := w.(http.Hijacker)
		if !ok {
			// Cannot be hijacked, which on this server means HTTP/2 — and h2 is
			// turned off wherever TLS is served for exactly the reason that
			// WebSockets cannot travel over it. Nothing useful is left to do but
			// say as little as possible.
			w.WriteHeader(http.StatusBadRequest)
			return
		}

		conn, _, err := hijacker.Hijack()
		if err != nil {
			return
		}

		_ = conn.Close()
	})
}

// isUpgrade reports whether this request is asking to become a WebSocket.
//
// Both headers are checked because both are required, and Connection may carry
// a list — "keep-alive, Upgrade" is what several proxies send — so it is
// searched rather than compared.
func isUpgrade(r *http.Request) bool {
	if !strings.EqualFold(strings.TrimSpace(r.Header.Get("Upgrade")), "websocket") {
		return false
	}

	for _, part := range strings.Split(r.Header.Get("Connection"), ",") {
		if strings.EqualFold(strings.TrimSpace(part), "upgrade") {
			return true
		}
	}

	return false
}
