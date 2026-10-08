package app

import (
	"net/http"
)

/*
Watching a video together.

Somebody signed in pastes a link; everybody in the call watches it, each in
their own browser, kept at the same moment by the one who started it (see
web/src/live/watch.ts). This file is the door to the gateway that makes that
possible, in the same shape as the music library's, with three paths:

	ready     whether there is a gateway: asked by the client to offer this
	resolve   what a pasted link plays, filed under a ticket
	library   the media servers the deployment has an account on, to browse
	          and search, and their posters
	info      what a ticket plays: the title, the length, and where it is
	media     a ticket's video, or its playlists and segments, relayed for a
	          viewer who cannot fetch it from where it is

The first two are for somebody signed in, because resolving is the deployment's
work done on somebody's behalf. The last two are for anybody in the call, guests
included, since they watch too -- and neither is a proxy anybody can point
anywhere: they take only a ticket the gateway issued when somebody signed in
resolved a link, which stands for that one video and stops working after six
hours. A call passes tickets around and nothing else, so nobody in it can make
everybody else's browser fetch an address of their choosing.

What comes back from media is said to be media, here as well as at the
gateway: a type that is not video, audio or a playlist is sent as bytes, never
sniffed, under a sandbox. These answers come from this server's own origin,
and a page relayed as a page would run with the rights of whoever opened it.
*/

var watchPaths = map[string]bool{"ready": true, "resolve": true, "library": true, "info": true, "media": true}

// What a relayed answer may say it is. Anything else is sent as bytes.
var mediaTypes = []string{
	"video/", "audio/", "application/vnd.apple.mpegurl", "application/x-mpegurl",
	"application/mp4", "application/octet-stream", "application/json", "text/vtt",
	// Posters and covers. Not image/svg+xml, which is a document that can
	// carry script, and is sent as bytes like anything else not listed.
	"image/jpeg", "image/png", "image/webp", "image/gif",
}

func (a *App) watch(w http.ResponseWriter, r *http.Request) {
	conf := a.conf.Meet.Watch
	what := r.PathValue("what")

	if conf.URL == "" || !watchPaths[what] {
		http.NotFound(w, r)
		return
	}

	if what == "ready" || what == "resolve" || what == "library" {
		if _, ok := a.signedIn(r); !ok {
			fail(w, http.StatusUnauthorized, reasonNotSignedIn)
			return
		}
	} else if r.URL.Query().Get("t") == "" {
		// Nothing to relay without the token naming what: as good as no path.
		http.NotFound(w, r)
		return
	}

	passOn(w, r, gateway{
		name:     "watch",
		url:      conf.URL,
		header:   "X-Watch-Token",
		token:    conf.Token,
		key:      "meet.watch.token",
		contains: mediaTypes,
	}, what, what == "media")
}
