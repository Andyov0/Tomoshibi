package app

import (
	"bytes"
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path"
	"strings"
	"time"
)

// index is the document every unclaimed path falls back to, so that reloading a
// nested route reaches the client rather than a 404.
const index = "index.html"

// manager is the management document, the one page here with buttons that act
// on other people's meetings.
const manager = "admin.html"

// Web serves the client out of files.
//
// Takes an fs.FS rather than a directory so the same handler covers both the
// copy built into the binary and one read off disk during development. The
// caller decides which; nothing below can tell the difference.
func Web(files fs.FS) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if name == "" || name == "." {
			name = index
		}

		content, err := fs.ReadFile(files, name)
		if err != nil {
			if !errors.Is(err, fs.ErrNotExist) {
				http.Error(w, "the client could not be read", http.StatusInternalServerError)
				return
			}

			// An unknown path is a client-side route; an unknown asset is
			// genuinely missing. Answering the document for a missing asset
			// would turn a 404 into a syntax error in the console, which says
			// far less about what went wrong.
			if strings.Contains(path.Base(name), ".") {
				http.NotFound(w, r)
				return
			}

			name = index
			if content, err = fs.ReadFile(files, name); err != nil {
				http.Error(w, "the client is not built", http.StatusNotFound)
				return
			}
		}

		w.Header().Set("Cache-Control", caching(name))

		// The management page may not be drawn inside anybody else's page.
		// Framed invisibly under a lure, a signed-in administrator's click on
		// something innocent lands on "Close this room" instead, and the
		// session cookie goes with it because the request is to this origin.
		// Only that page: a meeting embedded in somebody's own site is a
		// reasonable thing to build, and nothing a participant can press does
		// harm to anybody else.
		if name == manager {
			w.Header().Set("Content-Security-Policy", "frame-ancestors 'none'")
			w.Header().Set("X-Frame-Options", "DENY")
		}

		// The zero time leaves Last-Modified off, which is right for both
		// sources: files built into the binary have no meaningful timestamp, and
		// files on disk are named after their contents anyway.
		http.ServeContent(w, r, name, time.Time{}, bytes.NewReader(content))
	})
}

// caching decides how long a file may be kept.
//
// The build names what it puts under assets/ after its contents, so a changed
// file is a changed URL and the old one can be kept forever. Nothing else is
// named that way — the two documents and whatever was copied from public/ keep
// their names across every release — so everything else is revalidated.
//
// This once exempted index.html alone, which was right while it was the only
// document. The management page arrived as a second one and inherited a year of
// immutable caching: after an upgrade an administrator's browser went on
// loading the old admin.html, whose hashed bundles the new binary no longer
// had, and the management pages came up blank with nothing to say why.
func caching(name string) string {
	if strings.HasPrefix(name, "assets/") {
		return "public, max-age=31536000, immutable"
	}

	return "no-cache"
}

// Dir opens a directory for serving, checking that it holds a built client.
//
// Checked here rather than on the first request, so a wrong path is a startup
// error naming the directory rather than a 404 somebody has to go looking for.
func Dir(root string) (fs.FS, error) {
	files := os.DirFS(root)

	if _, err := fs.Stat(files, index); err != nil {
		return nil, err
	}

	return files, nil
}

// Placeholder serves one document for every path.
//
// Used when nothing was built into the binary. Answering 404 everywhere would be
// technically accurate and completely unhelpful; a page that says which command
// to run is the one thing this situation needs.
func Placeholder(document []byte) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		http.ServeContent(w, r, index, time.Time{}, bytes.NewReader(document))
	})
}
