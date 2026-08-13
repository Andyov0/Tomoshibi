package room

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base32"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// TripLength is how many characters of the digest a signature shows.
//
// Ten base32 characters is fifty bits, which is far past what an online guess
// can reach through a rate limiter. It is also short enough to read out loud,
// which is the point of showing it at all.
const TripLength = 10

// signed prefixes an identity that carries a signature, so one can be told from
// an unsigned identity at a glance and without parsing.
const signed = "t"

// tripAlphabet is lowercase base32 without padding.
//
// Lowercase because the identity travels in a room path and is read aloud;
// base32 rather than base64 because it has no characters that need escaping and
// none that look like each other in most typefaces.
var tripAlphabet = base32.NewEncoding("abcdefghijklmnopqrstuvwxyz234567").WithPadding(base32.NoPadding)

// Trip derives the signature for a passphrase.
//
// Keyed rather than a bare hash, which is the whole difference between this and
// the tripcodes it borrows from: without the key a signature cannot be attacked
// offline at all, so the only way to find a passphrase is to guess it through
// the join endpoint, where the rate limiter is waiting. A bare hash would be a
// dictionary attack somebody could run on their own hardware.
func Trip(key []byte, passphrase string) string {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(passphrase))

	return tripAlphabet.EncodeToString(mac.Sum(nil))[:TripLength]
}

// TripOf reads the signature out of an identity, if it carries one.
//
// Read from the identity rather than sent alongside it, because the identity is
// signed into the token and the media server enforces it. Anything travelling
// beside it would be a claim, and a claim is exactly what a signature exists to
// replace.
func TripOf(identity string) (string, bool) {
	rest, ok := strings.CutPrefix(identity, signed)
	if !ok || len(rest) < TripLength+1 || rest[TripLength] != '-' {
		return "", false
	}

	return rest[:TripLength], true
}

// LoadTripKey reads the signing key for tripcodes, creating one if absent.
//
// Its own file rather than sharing the API credentials, because the two have
// opposite lifetimes: API credentials should be rotated, and rotating this one
// silently changes everybody's signature, which is the one thing a signature
// must never do. Keeping them apart means neither rotation can take the other
// with it.
//
// Created exclusively, so several processes starting at once settle on one file
// rather than racing to overwrite each other, and read-only to its owner where
// the platform has an opinion.
func LoadTripKey(path string) ([]byte, error) {
	if dir := filepath.Dir(path); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, fmt.Errorf("create %s: %w", dir, err)
		}
	}

	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	switch {
	case err == nil:
		defer file.Close()

		key := make([]byte, 32)
		if _, err := rand.Read(key); err != nil {
			return nil, fmt.Errorf("read random bytes: %w", err)
		}

		if _, err := file.Write([]byte(tripAlphabet.EncodeToString(key))); err != nil {
			return nil, fmt.Errorf("write %s: %w", path, err)
		}

		return key, nil

	case os.IsExist(err):
		stored, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("read %s: %w", path, err)
		}

		key, err := tripAlphabet.DecodeString(strings.TrimSpace(string(stored)))
		if err != nil {
			return nil, fmt.Errorf(
				"%s does not hold a key this build can read. Delete it to start over, "+
					"accepting that every existing signature changes", path)
		}

		return key, nil

	default:
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
}

// Passphrase is a secret whose value must never be written down.
//
// A named type with its own String and formatting, so that logging a request
// that carries one cannot leak it: the redaction lives on the value rather than
// depending on every call site remembering.
type Passphrase string

// String hides the value.
func (p Passphrase) String() string {
	if p == "" {
		return ""
	}
	return "[redacted]"
}

// GoString hides the value from %#v as well as %v.
func (p Passphrase) GoString() string {
	return p.String()
}

// Empty reports whether there is no passphrase, without revealing one.
func (p Passphrase) Empty() bool {
	return strings.TrimSpace(string(p)) == ""
}
