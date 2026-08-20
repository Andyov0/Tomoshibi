package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"log/slog"
	"os"
	"time"

	"tomoshibi/internal/rtc"
)

/*
Keeping the fleet's certificate the same as the control node's.

The relays serve a wildcard the control node obtains, because the control node
is the only machine holding the credentials to obtain one. It reached them once,
in the package a machine is handed when it enrols, and after that nothing moved
it — so the renewal that arrives automatically every ninety days arrived only on
the machine that does not serve it, and eleven relays went on presenting a
certificate that would expire on a date nobody had written down.

This watches the file and hands out what it finds. It is deliberately dull: no
record of who holds what, no schedule tied to expiry, no retry queue. The far
end compares dates and keeps the newer one, so sending the same certificate
twice costs a request and changes nothing, and a relay that was unreachable this
hour is simply sent it again next hour. A renewal has about thirty days of
overlap; an hourly loop that forgets everything has seven hundred chances.
*/

// carryingEvery is how often the certificate on disk is looked at.
//
// The same hour as the sweeper and for a related reason: it is not chosen for
// timeliness — nothing here is urgent to the minute — but so that a deployment
// restarted nightly and one running for a year behave alike.
const carryingEvery = time.Hour

// carrying hands every relay the certificate this node serves, whenever it
// changes, and once at startup.
//
// Once at startup because a machine restarted often would otherwise never reach
// the first tick, and because a relay enrolled while an older certificate was
// current is behind from the moment it comes up.
func (a *App) carrying() {
	ticker := time.NewTicker(carryingEvery)
	defer ticker.Stop()

	var sent string

	for {
		if mark, ok := a.carry(sent); ok {
			sent = mark
		}

		select {
		case <-a.stop:
			return
		case <-ticker.C:
		}
	}
}

// carry reads the certificate and offers it to every relay, unless what is on
// disk is what was offered last time.
//
// The mark is of the content rather than of the file's timestamp, because
// acme.sh rewrites these files on a schedule of its own and most of those
// rewrites are the same bytes. A digest keeps the ordinary hour silent.
func (a *App) carry(last string) (string, bool) {
	if a.cluster == nil || a.conf.Meet.Enrol.Cert(a.conf.Meet.TLSCert) == "" {
		return "", false
	}

	certPath := a.conf.Meet.Enrol.Cert(a.conf.Meet.TLSCert)
	keyPath := a.conf.Meet.Enrol.Key(a.conf.Meet.TLSKey)

	cert, err := os.ReadFile(certPath)
	if err != nil {
		slog.Error("cannot read the certificate to give the relays", "path", certPath, "error", err)
		return "", false
	}

	key, err := os.ReadFile(keyPath)
	if err != nil {
		slog.Error("cannot read the key to give the relays", "path", keyPath, "error", err)
		return "", false
	}

	sum := sha256.Sum256(append(append([]byte(nil), cert...), key...))
	mark := hex.EncodeToString(sum[:])

	if mark == last {
		return mark, true
	}

	carried := rtc.Certificate{Cert: string(cert), Key: string(key)}

	expires, err := carried.Expiry()
	if err != nil {
		slog.Error("the certificate on this node will not load, so it was not offered to the "+
			"relays", "path", certPath, "error", err)

		return "", false
	}

	relays, err := a.store.Relays()
	if err != nil {
		slog.Error("cannot list the relays to give them the certificate", "error", err)
		return "", false
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	var taken, refused int

	for _, relay := range relays {
		if err := a.cluster.SendCertificate(ctx, relay.URL, carried); err != nil {
			// Not fatal and not retried here. The next hour offers it again,
			// and a certificate arrives with about thirty days to spare.
			slog.Warn("a relay would not take the certificate; it will be offered again",
				"relay", relay.Name, "error", err)

			refused++

			continue
		}

		taken++
	}

	slog.Info("offered the renewed certificate to the relays",
		"expires", expires.Format(time.RFC3339), "answered", taken, "unreachable", refused)

	return mark, true
}
