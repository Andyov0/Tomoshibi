package config

import "testing"

/*
A music library half set up is refused at startup.

Each of these would otherwise start, offer nothing that worked, and be found by
somebody pressing play: a token with nowhere to send it, an address with no
token the gateway would accept, a token short enough to guess, and an address
that is not one.
*/

func TestNoLibraryIsFine(t *testing.T) {
	if err := checkMusic(Music{}); err != nil {
		t.Fatalf("a deployment without a library was refused: %v", err)
	}
}

func TestAWholeLibraryIsAccepted(t *testing.T) {
	if err := checkMusic(Music{URL: "http://10.0.0.13:18300", Token: "a-token-long-enough-to-trust"}); err != nil {
		t.Fatalf("a complete library was refused: %v", err)
	}
}

func TestAHalfSetUpLibraryIsRefused(t *testing.T) {
	long := "a-token-long-enough-to-trust"

	for name, music := range map[string]Music{
		"a token with no address":       {Token: long},
		"an address with no token":      {URL: "http://10.0.0.13:18300"},
		"a token short enough to guess": {URL: "http://10.0.0.13:18300", Token: "short"},
		"an address that is not one":    {URL: "10.0.0.13:18300", Token: long},
		"a scheme it cannot speak":      {URL: "ftp://10.0.0.13", Token: long},
	} {
		if err := checkMusic(music); err == nil {
			t.Errorf("%s was accepted", name)
		}
	}
}
