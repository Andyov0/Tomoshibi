package room

import (
	"strings"
	"testing"
	"time"

	"github.com/livekit/protocol/auth"
)

const (
	key    = "APItest"
	secret = "a-secret-long-enough-to-sign-with"
)

func TestValidName(t *testing.T) {
	for _, name := range []string{"demo", "weekly-standup", "room-2", "a"} {
		if !ValidName(name) {
			t.Errorf("ValidName(%q) = false, want true", name)
		}
	}

	// Rejected for reasons worth stating: uppercase and spaces because the name
	// is normalised before it gets here, edge dashes because they read as
	// truncation, and length because a name is meant to be repeatable aloud.
	for _, name := range []string{"", "Demo", "with space", "-lead", "trail-", "under_score",
		strings.Repeat("a", MaxName+1)} {
		if ValidName(name) {
			t.Errorf("ValidName(%q) = true, want false", name)
		}
	}
}

func TestMintedIdentityIsValid(t *testing.T) {
	minted := MintIdentity("")

	if !ValidIdentity(minted) {
		t.Fatalf("ValidIdentity(%q) = false for a minted identity", minted)
	}

	if minted == MintIdentity("") {
		t.Fatal("two minted identities are the same")
	}
}

func TestIdentityWeDidNotMintIsRejected(t *testing.T) {
	for _, identity := range []string{"", "alice", "g-short", "g-" + strings.Repeat("Z", 32)} {
		if ValidIdentity(identity) {
			t.Errorf("ValidIdentity(%q) = true, want false", identity)
		}
	}
}

// An identity a caller invented is replaced rather than refused, so they get a
// working session instead of an error they cannot act on, and cannot choose what
// they are known as.
func TestInventedIdentityIsReplaced(t *testing.T) {
	grant, err := Authorise(key, secret, Request{
		Room: "demo", Identity: "alice", Display: "Alice", TTL: time.Minute,
	})
	if err != nil {
		t.Fatalf("Authorise: %v", err)
	}

	if grant.Identity == "alice" {
		t.Fatal("a caller chose their own identity")
	}
	if !ValidIdentity(grant.Identity) {
		t.Fatalf("replacement identity %q is not one we would mint", grant.Identity)
	}
}

func TestIdentityWeMintedIsKept(t *testing.T) {
	minted := MintIdentity("")

	grant, err := Authorise(key, secret, Request{
		Room: "demo", Identity: minted, Display: "Alice", TTL: time.Minute,
	})
	if err != nil {
		t.Fatalf("Authorise: %v", err)
	}

	if grant.Identity != minted {
		t.Fatalf("identity = %q, want the one sent back (%q)", grant.Identity, minted)
	}
}

// The grant has to be narrow, since a leaked token is one somebody else holds.
func TestGrantIsScopedToOneRoom(t *testing.T) {
	grant, err := Authorise(key, secret, Request{
		Room: "demo", Display: "Alice", TTL: time.Minute,
	})
	if err != nil {
		t.Fatalf("Authorise: %v", err)
	}

	verified, err := auth.ParseAPIToken(grant.Token)
	if err != nil {
		t.Fatalf("parse the token: %v", err)
	}

	_, claims, err := verified.Verify(secret)
	if err != nil {
		t.Fatalf("verify the token: %v", err)
	}

	if claims.Video.Room != "demo" {
		t.Errorf("room = %q, want demo", claims.Video.Room)
	}
	if claims.Video.RoomAdmin || claims.Video.RoomCreate || claims.Video.RoomList {
		t.Error("the grant carries administrative rights it has no use for")
	}
	if claims.Identity != grant.Identity {
		t.Errorf("identity = %q, want %q", claims.Identity, grant.Identity)
	}
}

// Signed in rather than set after connecting, so nobody can rename themselves to
// somebody else mid-call.
func TestDisplayNameIsSignedIn(t *testing.T) {
	grant, err := Authorise(key, secret, Request{
		Room: "demo", Display: "  Alice  ", TTL: time.Minute,
	})
	if err != nil {
		t.Fatalf("Authorise: %v", err)
	}

	claims := verify(t, grant.Token)
	if claims.Name != "Alice" {
		t.Errorf("name = %q, want it trimmed to Alice", claims.Name)
	}
}

// An empty name would leave a tile with nothing under it and no way to tell
// whose it is.
func TestAnEmptyNameFallsBackToTheIdentity(t *testing.T) {
	grant, err := Authorise(key, secret, Request{Room: "demo", Display: "   ", TTL: time.Minute})
	if err != nil {
		t.Fatalf("Authorise: %v", err)
	}

	if claims := verify(t, grant.Token); claims.Name != grant.Identity {
		t.Errorf("name = %q, want the identity %q", claims.Name, grant.Identity)
	}
}

func TestALongNameIsTrimmedRatherThanRefused(t *testing.T) {
	grant, err := Authorise(key, secret, Request{
		Room: "demo", Display: strings.Repeat("a", MaxDisplayName+20), TTL: time.Minute,
	})
	if err != nil {
		t.Fatalf("Authorise: %v", err)
	}

	if claims := verify(t, grant.Token); len([]rune(claims.Name)) != MaxDisplayName {
		t.Errorf("name is %d runes, want %d", len([]rune(claims.Name)), MaxDisplayName)
	}
}

func TestAnInvalidRoomIsRefused(t *testing.T) {
	if _, err := Authorise(key, secret, Request{Room: "Bad Room", TTL: time.Minute}); err == nil {
		t.Fatal("an invalid room name was authorised")
	}
}

func verify(t *testing.T, token string) *auth.ClaimGrants {
	t.Helper()

	parsed, err := auth.ParseAPIToken(token)
	if err != nil {
		t.Fatalf("parse the token: %v", err)
	}

	_, claims, err := parsed.Verify(secret)
	if err != nil {
		t.Fatalf("verify the token: %v", err)
	}

	return claims
}
