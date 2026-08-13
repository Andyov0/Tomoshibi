// Package config loads one document describing the whole process: this
// server's own settings alongside the media server's.
//
// They cannot be unmarshalled together. LiveKit's loader can be asked to reject
// keys it does not recognise, and a shared document would make that check
// useless, so the `meet` section is lifted out first and what remains is handed
// over untouched. One file, one deletion, and no fighting the upstream type.
package config

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"time"

	livekit "github.com/livekit/livekit-server/pkg/config"
	"gopkg.in/yaml.v3"
)

// Meet is everything the media server has no opinion about.
type Meet struct {
	// Listen is the address serving the client, the API, and the signalling
	// proxy. The one port anybody outside this machine talks to over TCP.
	Listen string `yaml:"listen"`

	// WebRoot serves the client from a directory instead of the copy built into
	// the binary. Useful while working on the client; unset in a deployment.
	WebRoot string `yaml:"web_root"`

	// Database is the key-value file recording which rooms have been used.
	Database string `yaml:"database"`

	// TripcodeKey signs the passphrases that turn a display name into one
	// nobody else can wear. Created on first use.
	//
	// Its own file rather than the API credentials, because the two have
	// opposite lifetimes: those should be rotated, and rotating this one
	// silently changes everybody's signature, which is the one thing a
	// signature must never do.
	TripcodeKey string `yaml:"tripcode_key"`

	// PublicURL overrides the address clients are told to dial. Only needed
	// behind a proxy or a name the request does not already carry.
	PublicURL string `yaml:"public_url"`

	// TokenTTL is how long a join token stays valid. Short by design: it is
	// spent on the next connect and never reused.
	TokenTTL time.Duration `yaml:"token_ttl"`

	// JoinRate and JoinBurst bound how fast rooms can be asked for. A room
	// exists because somebody named it, so asking for an unused one succeeds
	// exactly like asking for a busy one. There is no failure to count, which
	// leaves the rate as the only thing between a script and somebody's meeting.
	JoinRate  float64 `yaml:"join_rate"`
	JoinBurst int     `yaml:"join_burst"`

	// TrustProxy believes `X-Forwarded-For` and `X-Forwarded-Host`. Only true
	// behind a proxy that sets them; exposed directly they are whatever the
	// caller typed, and believing them would let anyone claim a fresh rate-limit
	// budget per request.
	TrustProxy bool `yaml:"trust_proxy"`
}

// Config is both halves, resolved.
type Config struct {
	Meet    Meet
	LiveKit *livekit.Config

	// Key and Secret are the API credentials the embedded media server verifies
	// with, and therefore the ones this server signs with. Read back out of the
	// resolved LiveKit config rather than configured separately, so there is no
	// second place for them to drift.
	Key    string
	Secret string
}

// Defaults every field falls back to.
//
// Chosen so that running the binary with no configuration at all produces a
// working server. The burst covers a large meeting arriving at once; the rate is
// what a script is left with afterwards.
var defaults = Meet{
	Listen:      ":8080",
	Database:    "meet.db",
	TripcodeKey: "tripcode.key",
	TokenTTL:    5 * time.Minute,
	JoinRate:    10,
	JoinBurst:   120,
	TrustProxy:  false,
}

// Load reads the configuration from path, or returns the defaults if path is
// empty.
func Load(path string) (*Config, error) {
	document := []byte{}

	if path != "" {
		read, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("read %s: %w", path, err)
		}
		document = read
	}

	meet, rest, err := split(document)
	if err != nil {
		return nil, err
	}

	// Strict: a typo in a LiveKit key should be an error rather than a setting
	// that silently did nothing. Ours is checked the same way, in split.
	lk, err := livekit.NewConfig(string(rest), true, nil, nil)
	if err != nil {
		return nil, fmt.Errorf("load the media server configuration: %w", err)
	}

	key, secret, err := credentials(lk)
	if err != nil {
		return nil, err
	}

	return &Config{Meet: meet, LiveKit: lk, Key: key, Secret: secret}, nil
}

// split separates the `meet` section from the rest of the document.
//
// The remainder is re-encoded rather than edited in place, because YAML is not
// a format one can safely cut a section out of with string operations: anchors,
// flow style, and comments all make the textual boundaries of a section
// something only a parser knows.
func split(document []byte) (Meet, []byte, error) {
	meet := defaults

	if len(document) == 0 {
		return meet, nil, nil
	}

	var whole map[string]yaml.Node
	if err := yaml.Unmarshal(document, &whole); err != nil {
		return meet, nil, fmt.Errorf("parse the configuration: %w", err)
	}

	if section, ok := whole["meet"]; ok {
		// Round-tripped through bytes rather than decoded from the node, because
		// only a Decoder can be told to reject unknown fields, and a typo in our
		// half deserves the same error as a typo in theirs.
		raw, err := yaml.Marshal(&section)
		if err != nil {
			return meet, nil, fmt.Errorf("re-encode the meet section: %w", err)
		}

		decoder := yaml.NewDecoder(bytes.NewReader(raw))
		decoder.KnownFields(true)

		if err := decoder.Decode(&meet); err != nil && err != io.EOF {
			return meet, nil, fmt.Errorf("parse the meet section: %w", err)
		}

		delete(whole, "meet")
	}

	rest, err := yaml.Marshal(whole)
	if err != nil {
		return meet, nil, fmt.Errorf("re-encode the configuration: %w", err)
	}

	return meet, rest, nil
}

// credentials pulls the one API key pair out of the resolved config.
//
// Exactly one, because this server signs with it: several would mean choosing,
// and a choice nobody made is a choice that will surprise somebody.
func credentials(lk *livekit.Config) (string, string, error) {
	switch len(lk.Keys) {
	case 0:
		return "", "", fmt.Errorf(
			"no API key: add one under `keys` in the configuration, " +
				"or run `meet-live keygen` to generate a pair",
		)
	case 1:
		for key, secret := range lk.Keys {
			return key, secret, nil
		}
	}

	return "", "", fmt.Errorf(
		"%d API keys configured, but this server signs its own tokens and can only use one: "+
			"leave a single entry under `keys`", len(lk.Keys),
	)
}
