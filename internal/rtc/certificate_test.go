package rtc

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/livekit/protocol/auth"
)

/*
The one path by which a relay's certificate is ever replaced.

Everything about this is quiet when it goes wrong. A push that is refused leaves
the relay serving a certificate that still works, for a while; a push that is
accepted when it should not have been leaves it serving one somebody else chose.
Neither shows up until a date that is months away, which is the whole reason the
fleet had no distribution at all until now: nothing about the missing one was
visible either.
*/

const (
	testKey    = "APItest"
	testSecret = "a secret long enough for the token library to accept it"
)

// issued writes a certificate and key expiring at the given time.
func issued(t *testing.T, dir string, expires time.Time) (string, string, Certificate) {
	t.Helper()

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}

	template := x509.Certificate{
		SerialNumber: big.NewInt(expires.Unix()),
		Subject:      pkix.Name{CommonName: "relay.example.invalid"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     expires,
		DNSNames:     []string{"relay.example.invalid"},
	}

	der, err := x509.CreateCertificate(rand.Reader, &template, &template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}

	marshalled, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}

	cert := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	pkey := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: marshalled})

	certPath := filepath.Join(dir, "cert.pem")
	keyPath := filepath.Join(dir, "key.pem")

	if err := os.WriteFile(certPath, cert, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyPath, pkey, 0o600); err != nil {
		t.Fatal(err)
	}

	return certPath, keyPath, Certificate{Cert: string(cert), Key: string(pkey)}
}

// pushing sends one certificate at the handler, signed or not.
func pushing(t *testing.T, handler http.Handler, cert Certificate, signed bool) *httptest.ResponseRecorder {
	t.Helper()

	body, err := json.Marshal(cert)
	if err != nil {
		t.Fatal(err)
	}

	request := httptest.NewRequest(http.MethodPut, CertificatePath, bytes.NewReader(body))

	if signed {
		token, err := auth.NewAccessToken(testKey, testSecret).
			SetIdentity("tomoshibi").
			SetVideoGrant(&auth.VideoGrant{RoomList: true}).
			SetValidFor(time.Minute).
			ToJWT()
		if err != nil {
			t.Fatal(err)
		}

		request.Header.Set("Authorization", "Bearer "+token)
	}

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)

	return recorder
}

func TestARenewedCertificateReplacesTheOneOnDisk(t *testing.T) {
	dir := t.TempDir()
	certPath, keyPath, _ := issued(t, dir, time.Now().Add(30*24*time.Hour))

	handler := CertificateHandler(certPath, keyPath, testKey, testSecret)

	_, _, renewed := issued(t, t.TempDir(), time.Now().Add(90*24*time.Hour))

	if code := pushing(t, handler, renewed, true).Code; code != http.StatusOK {
		t.Fatalf("the relay answered %d", code)
	}

	on, err := os.ReadFile(certPath)
	if err != nil {
		t.Fatal(err)
	}

	if string(on) != renewed.Cert {
		t.Error("the certificate on disk is not the one that was sent, so the fleet would " +
			"expire on schedule with the renewal sitting on the control node")
	}
}

// The check that stops a certificate going backwards.
//
// Without it, anybody who could reach this endpoint could put back a
// certificate about to expire and choose the hour a relay stops answering. It
// is also what makes the hourly push safe to be dull: the control node sends to
// everybody and keeps no record of who has what, so most pushes are of a
// certificate the relay already holds.
func TestAnOlderCertificateIsNotTaken(t *testing.T) {
	dir := t.TempDir()
	certPath, keyPath, current := issued(t, dir, time.Now().Add(60*24*time.Hour))

	handler := CertificateHandler(certPath, keyPath, testKey, testSecret)

	_, _, older := issued(t, t.TempDir(), time.Now().Add(2*24*time.Hour))

	if code := pushing(t, handler, older, true).Code; code != http.StatusOK {
		t.Fatalf("answered %d; being sent something already held is the ordinary case and "+
			"not an error", code)
	}

	on, err := os.ReadFile(certPath)
	if err != nil {
		t.Fatal(err)
	}

	if string(on) != current.Cert {
		t.Error("an older certificate replaced a newer one: whoever can reach this can now " +
			"choose the hour this relay stops answering")
	}
}

func TestAnUnsignedPushIsRefused(t *testing.T) {
	dir := t.TempDir()
	certPath, keyPath, current := issued(t, dir, time.Now().Add(24*time.Hour))

	handler := CertificateHandler(certPath, keyPath, testKey, testSecret)

	_, _, renewed := issued(t, t.TempDir(), time.Now().Add(90*24*time.Hour))

	if code := pushing(t, handler, renewed, false).Code; code != http.StatusUnauthorized {
		t.Errorf("an unsigned push answered %d: anybody who found the port could replace "+
			"what this relay serves", code)
	}

	if on, _ := os.ReadFile(certPath); string(on) != current.Cert {
		t.Error("and it was written anyway")
	}
}

func TestSomethingThatIsNotAKeypairIsRefused(t *testing.T) {
	dir := t.TempDir()
	certPath, keyPath, current := issued(t, dir, time.Now().Add(24*time.Hour))

	handler := CertificateHandler(certPath, keyPath, testKey, testSecret)

	// A certificate with somebody else's key, which is the shape a mistake
	// takes: two files copied from two different renewals.
	_, _, one := issued(t, t.TempDir(), time.Now().Add(90*24*time.Hour))
	_, _, two := issued(t, t.TempDir(), time.Now().Add(90*24*time.Hour))

	mismatched := Certificate{Cert: one.Cert, Key: two.Key}

	if code := pushing(t, handler, mismatched, true).Code; code != http.StatusBadRequest {
		t.Errorf("answered %d, want 400", code)
	}

	if on, _ := os.ReadFile(certPath); string(on) != current.Cert {
		t.Error("a certificate that does not match its key was written, which is a relay that " +
			"comes back from its next restart refusing every handshake")
	}
}
