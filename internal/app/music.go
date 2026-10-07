package app

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

/*
A music library, played into a call.

Somebody signed in may search a library this deployment has a gateway to and
play a track into the call as shared sound: losslessly where the track is
lossless, along the path the "share only sound" stream already takes. This file
is the door to the library. It admits signed-in accounts and passes their
requests on to the gateway with the token only this server holds; what the
gateway is and what it reaches is the deployment's business, and the client is
shown four paths and no address.

	sources   which libraries there are, and whether each is signed in
	search    tracks in one of them
	track     what a track's audio is: format, rate, bits, channels
	audio     the audio itself, streamed through, with Range

Signed in, because a library is somebody's subscription, and a path that let
anybody holding the address play from it would be giving that away. Not limited
further: who has an account on a deployment is already a decision somebody made.

The query is passed on as it came. The gateway is the party that knows what a
source or a quality is, and it refuses what it does not; reading the parameters
here as well would be two lists of the same thing kept in step by hand.
*/

var musicPaths = map[string]bool{"sources": true, "search": true, "track": true, "audio": true}

// The headers that describe a response, and the only ones passed back. Anything
// else the gateway says is between it and this server.
var musicHeaders = []string{"Content-Type", "Content-Length", "Content-Range", "Accept-Ranges"}

// musicClient has no overall timeout because an audio response is as long as
// the track: a four-minute song arrives over four minutes when the listener's
// browser reads it at the pace it plays. Only the wait for the gateway to begin
// answering is bounded.
var musicClient = &http.Client{
	Transport: &http.Transport{
		Proxy:                 nil,
		ResponseHeaderTimeout: 30 * time.Second,
		IdleConnTimeout:       90 * time.Second,
		MaxIdleConnsPerHost:   8,
	},
}

func (a *App) music(w http.ResponseWriter, r *http.Request) {
	conf := a.conf.Meet.Music
	what := r.PathValue("what")

	// No library here, or no such path: the same answer as for any other path
	// this server does not have, so the client can tell "none" by asking.
	if conf.URL == "" || !musicPaths[what] {
		http.NotFound(w, r)
		return
	}

	if _, ok := a.signedIn(r); !ok {
		fail(w, http.StatusUnauthorized, reasonNotSignedIn)
		return
	}

	target := strings.TrimRight(conf.URL, "/") + "/" + what
	if r.URL.RawQuery != "" {
		target += "?" + r.URL.RawQuery
	}

	ctx := r.Context()
	if what != "audio" {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		fail(w, http.StatusInternalServerError, reasonServerError)
		return
	}

	request.Header.Set("X-Music-Token", conf.Token)
	if what == "audio" {
		if span := r.Header.Get("Range"); span != "" {
			request.Header.Set("Range", span)
		}
	}

	response, err := musicClient.Do(request)
	if err != nil {
		if ctx.Err() == nil {
			slog.Warn("the music gateway did not answer", "path", what, "error", err)
		}
		fail(w, http.StatusBadGateway, reasonServerError)
		return
	}
	defer response.Body.Close()

	// The gateway refusing this server is a configuration that does not match,
	// not a thing the person pressing play did or can do anything about.
	if response.StatusCode == http.StatusForbidden {
		slog.Error("the music gateway refused this server's token: meet.music.token does not " +
			"match the gateway's")
		fail(w, http.StatusBadGateway, reasonServerError)
		return
	}

	for _, name := range musicHeaders {
		if value := response.Header.Get(name); value != "" {
			w.Header().Set(name, value)
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(response.StatusCode)

	// Copied as it arrives rather than read whole: an audio response is tens of
	// megabytes, and the browser plays it while it comes.
	_, _ = io.Copy(w, response.Body)
}
