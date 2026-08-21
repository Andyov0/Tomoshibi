package app

import "testing"

/*
Which files a browser may keep, and for how long.

The rule is simple and was applied to one file instead of three. Assets are
named after their contents, so a changed asset is a changed URL and the old one
can be kept forever. A document's name never changes, so it must be revalidated
or a deployment reaches nobody who has visited before.

This deployment serves three documents. Only the client was named, so the
management and account pages went out as immutable for a year — and immutable is
not a cache that goes stale and recovers, it is a promise a browser takes at its
word and a CDN repeats per edge. The symptom is a fix that reaches some people
and not others, indefinitely, and looks exactly like a build that never
deployed.
*/
func TestEveryDocumentIsRevalidatedAndEveryAssetIsNot(t *testing.T) {
	documents := []string{"index.html", "admin.html", "account.html"}

	for _, name := range documents {
		if got := caching(name); got != "no-cache" {
			t.Errorf("%s is served %q. A document keeps its name across every build, so one "+
				"a browser is told it may keep is one that never gets the next deployment",
				name, got)
		}
	}

	// And the other half, which is what makes the first half affordable.
	for _, name := range []string{
		"assets/index-CUiA9y28.js",
		"assets/loader-circle-DystNjoV.css",
		"flags/cn.svg",
	} {
		if got := caching(name); got == "no-cache" {
			t.Errorf("%s is served %q; a file named after its contents can be kept forever, "+
				"and revalidating every one of them is a request per asset per visit",
				name, got)
		}
	}
}
