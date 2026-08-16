package admin

import (
	"context"
	"sort"
	"sync"
	"time"

	"tomoshibi/internal/rtc"
)

// Fleet is how a control node reads the counters of the machines it does not
// run.
//
// Separate from Control, which asks about rooms. These are the figures only the
// process holding a media server can see — throughput, tracks, CPU — and the
// reason a control node's dashboard was empty: there is no media server here,
// and none of this can be worked out from redis.
type Fleet interface {
	// Relays is the addresses to read, live, so a relay added on a page is
	// included without a restart.
	Relays() []string
	AskStats(ctx context.Context, relay string) (rtc.Stats, error)
}

// nodeReading is one relay's answer, or the reason there was not one.
type nodeReading struct {
	Name string `json:"name"`
	URL  string `json:"url"`

	// Reachable separates a relay holding no calls from one that did not
	// answer. Both would otherwise show as zeros, and the difference between
	// "quiet" and "down" is the whole reason somebody opens this page.
	Reachable bool   `json:"reachable"`
	Detail    string `json:"detail,omitempty"`

	rtc.Stats
}

// fleetReading is every relay, plus the totals across them.
type fleetReading struct {
	Nodes []nodeReading `json:"nodes"`

	// Totals sum only the relays that answered. A sum that silently included
	// zeros for the unreachable ones would fall when a machine went down and
	// read as calls ending.
	Totals rtc.Stats `json:"totals"`

	Answered int `json:"answered"`
	Asked    int `json:"asked"`
}

// readFleet asks every relay at once and adds up what comes back.
//
// In parallel because this is drawn on a page somebody is waiting in front of,
// and in turn the wait would be the sum of every relay's latency — including
// the full timeout of any that is down, which is the case the page is most
// often opened to look at.
func readFleet(ctx context.Context, fleet Fleet, named map[string]string) fleetReading {
	relays := fleet.Relays()

	reading := fleetReading{Asked: len(relays), Nodes: make([]nodeReading, len(relays))}

	ctx, cancel := context.WithTimeout(ctx, 6*time.Second)
	defer cancel()

	var wait sync.WaitGroup
	for i, url := range relays {
		reading.Nodes[i] = nodeReading{URL: url, Name: named[url]}

		wait.Add(1)
		go func(i int, url string) {
			defer wait.Done()

			stats, err := fleet.AskStats(ctx, url)
			if err != nil {
				reading.Nodes[i].Detail = err.Error()
				return
			}

			reading.Nodes[i].Reachable = true
			reading.Nodes[i].Stats = stats
		}(i, url)
	}
	wait.Wait()

	// Sorted by name so a page redrawn every few seconds does not reorder
	// itself under whoever is reading it. Goroutines finish in whatever order
	// the network allows, which is not an order anybody wants to watch.
	sort.Slice(reading.Nodes, func(i, j int) bool {
		if reading.Nodes[i].Name != reading.Nodes[j].Name {
			return reading.Nodes[i].Name < reading.Nodes[j].Name
		}
		return reading.Nodes[i].URL < reading.Nodes[j].URL
	})

	for _, node := range reading.Nodes {
		if !node.Reachable {
			continue
		}

		reading.Answered++

		reading.Totals.Rooms += node.Rooms
		reading.Totals.Clients += node.Clients
		reading.Totals.TracksIn += node.TracksIn
		reading.Totals.TracksOut += node.TracksOut
		reading.Totals.BytesIn += node.BytesIn
		reading.Totals.BytesOut += node.BytesOut
		reading.Totals.InPerSec += node.InPerSec
		reading.Totals.OutPerSec += node.OutPerSec
		reading.Totals.NackTotal += node.NackTotal
		reading.Totals.NackPerSec += node.NackPerSec
		reading.Totals.CPUs += node.CPUs
		reading.Totals.Load += node.Load

		// The widest window of any relay, not the sum. Rates measured over
		// different windows cannot be added into a rate over their total; the
		// honest thing to report is the coarsest of them, so nobody reads a
		// ten-second mean as a two-second one.
		if node.Window > reading.Totals.Window {
			reading.Totals.Window = node.Window
		}
	}

	return reading
}

// relayNames maps an address back to the name it was given, for a page that
// should say "tokyo" rather than an address somebody has to recognise.
func (a *API) relayNames() map[string]string {
	named := map[string]string{}

	if a.relays == nil {
		return named
	}

	list, err := a.relays.Relays()
	if err != nil {
		return named
	}

	for _, relay := range list {
		named[relay.URL] = relay.Name
	}

	return named
}
