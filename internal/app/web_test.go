package app

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"
)

/*
 * How long a browser may keep each file.
 *
 * Wrong in one direction it costs bandwidth. Wrong in the other it is silent and
 * lasts a year: a document cached as immutable is never asked for again, so an
 * upgrade reaches nobody who has visited before, and what they see is a page
 * pointing at bundles the new binary no longer serves. That happened to the
 * management page, which was the second document and not the one the rule was
 * written for.
 */

func TestOnlyWhatIsNamedAfterItsContentsIsKeptForever(t *testing.T) {
	files := fstest.MapFS{
		"index.html":           {Data: []byte("<!doctype html>")},
		"admin.html":           {Data: []byte("<!doctype html>")},
		"favicon.svg":          {Data: []byte("<svg/>")},
		"assets/index-abc.js":  {Data: []byte("")},
		"assets/admin-def.css": {Data: []byte("")},
	}
	web := Web(files)

	for path, want := range map[string]string{
		"/":                     "no-cache",
		"/index.html":           "no-cache",
		"/admin.html":           "no-cache",
		"/favicon.svg":          "no-cache",
		"/some/route":           "no-cache",
		"/assets/index-abc.js":  "public, max-age=31536000, immutable",
		"/assets/admin-def.css": "public, max-age=31536000, immutable",
	} {
		recorder := httptest.NewRecorder()
		web.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))

		if got := recorder.Header().Get("Cache-Control"); got != want {
			t.Errorf("%s is cached %q, want %q", path, got, want)
		}
	}
}

// Framed under a lure, a signed-in administrator's click can be made to land on
// a button that closes somebody's meeting. The meeting itself stays framable,
// since embedding one in a site of one's own is a use and not an attack.
func TestOnlyTheManagementPageRefusesToBeFramed(t *testing.T) {
	web := Web(fstest.MapFS{
		"index.html": {Data: []byte("<!doctype html>")},
		"admin.html": {Data: []byte("<!doctype html>")},
	})

	ask := func(path string) http.Header {
		recorder := httptest.NewRecorder()
		web.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
		return recorder.Header()
	}

	if got := ask("/admin.html").Get("Content-Security-Policy"); got != "frame-ancestors 'none'" {
		t.Errorf("the management page may be framed: Content-Security-Policy is %q", got)
	}
	if got := ask("/").Get("Content-Security-Policy"); got != "" {
		t.Errorf("the meeting page refuses to be framed: Content-Security-Policy is %q", got)
	}
}
