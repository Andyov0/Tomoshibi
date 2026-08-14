package admin

import (
	"fmt"
	"net"
	"os"
	"runtime"
	"strconv"
	"strings"
	"time"

	"meet-live/internal/config"
)

// Checks are the things that have gone quietly wrong before.
//
// Every one of these is a fault this deployment actually had, and each was
// expensive in the same way: nothing crashed, no log said anything, and the
// symptom pointed somewhere other than the cause. A microphone level moved while
// nobody could be heard. A shared screen was soft because the sharp version was
// never requested. Sound broke up in a way that reads as a bad network and was a
// socket buffer.
//
// So a check earns its place by having cost somebody an afternoon, and each one
// says what it examined rather than showing a tick. A tick that has gone stale
// is worse than no check at all, and the way to notice a stale one is to be able
// to read what it thought it was proving.

// Verdict is how a check came out.
type Verdict string

const (
	// Good: examined, and as it should be.
	Good Verdict = "good"
	// Warn: examined, and working, but not as intended. Nothing is broken
	// now; something will be, later, in a way that will not point here.
	Warn Verdict = "warn"
	// Unknown: could not be examined from here. Not the same as good, and
	// showing it as good is how a check starts lying.
	Unknown Verdict = "unknown"
)

// A Check is one thing looked at.
type Check struct {
	Name    string  `json:"name"`
	Verdict Verdict `json:"verdict"`
	// Found is what was actually there.
	Found string `json:"found"`
	// Examined says what this check looked at, so that a reader can tell
	// whether it still means what it meant when it was written.
	Examined string `json:"examined"`
	// Remedy is what to do, where there is something to do. Printed rather
	// than offered as a button: the fix for several of these is on the host,
	// outside this container, and reaching across that boundary is not a
	// power a management page should hold.
	Remedy string `json:"remedy,omitempty"`
}

// Health examines the deployment.
func Health(conf *config.Config, nodeIP string) []Check {
	checks := []Check{
		advertised(conf, nodeIP),
		port("Media, UDP", "udp", int(conf.LiveKit.RTC.UDPPort.Start)),
		port("Media, TCP fallback", "tcp", int(conf.LiveKit.RTC.TCPPort)),
		receiveBuffer(),
		loopbackOnly(conf),
	}

	return checks
}

// advertised is the fault that cost the most, twice, on two different services.
//
// The container reaches the world through a gateway that rewrites its source
// address, so what it sees itself as and what a browser must dial are different
// addresses. Left to discover its own, the media server finds the first and
// hands it to clients, who cannot reach it. Text works. Everything works. Only
// the call sits there connecting.
func advertised(conf *config.Config, nodeIP string) Check {
	configured := conf.LiveKit.RTC.NodeIP.V4
	if configured == "" {
		configured = conf.LiveKit.RTC.NodeIP.V6
	}

	switch {
	case configured == "" && conf.LiveKit.RTC.UseExternalIP:
		return Check{
			Name:     "Address given to clients",
			Verdict:  Warn,
			Found:    nodeIP + ", discovered",
			Examined: "Whether the address in ICE candidates was configured or guessed at over STUN.",
			Remedy: "Behind a gateway that rewrites the source address, what is discovered is not " +
				"what clients can reach. Set rtc.node_ip, and rtc.use_external_ip to false.",
		}

	case configured != "" && conf.LiveKit.RTC.UseExternalIP:
		return Check{
			Name:     "Address given to clients",
			Verdict:  Warn,
			Found:    nodeIP + ", discovery still on",
			Examined: "Both rtc.node_ip and rtc.use_external_ip, which are one setting in two halves.",
			Remedy: "A configured address is overwritten while use_external_ip is true. " +
				"Set it to false.",
		}

	case configured == "":
		return Check{
			Name:     "Address given to clients",
			Verdict:  Warn,
			Found:    nodeIP + ", from the interface",
			Examined: "Whether an address was configured for ICE candidates.",
			Remedy:   "Set rtc.node_ip to the address browsers dial, if it differs from this one.",
		}

	default:
		return Check{
			Name:     "Address given to clients",
			Verdict:  Good,
			Found:    configured,
			Examined: "rtc.node_ip, with discovery off so it cannot be overwritten.",
		}
	}
}

// port checks that something is listening where the media is expected.
func port(name, network string, number int) Check {
	if number == 0 {
		return Check{
			Name:     name,
			Verdict:  Warn,
			Found:    "not configured",
			Examined: "Whether a port was set for this at all.",
		}
	}

	found := strconv.Itoa(number)

	// Bound is proved by failing to bind it again. Connecting to it would
	// prove only that this process can reach itself, which is not the
	// question anybody is asking.
	listener, err := listen(network, number)
	if err != nil {
		return Check{
			Name:     name,
			Verdict:  Good,
			Found:    found + ", in use",
			Examined: "Whether the port is held, by trying to take it and being refused.",
		}
	}
	_ = listener.Close()

	return Check{
		Name:     name,
		Verdict:  Warn,
		Found:    found + ", free",
		Examined: "Whether the port is held, by trying to take it and succeeding.",
		Remedy: "Nothing is listening. Media will not arrive on this port; check that the " +
			"media server started and that the port is not being remapped.",
	}
}

func listen(network string, number int) (interface{ Close() error }, error) {
	address := net.JoinHostPort("", strconv.Itoa(number))

	if network == "udp" {
		return net.ListenPacket("udp", address)
	}

	return net.Listen("tcp", address)
}

// receiveBuffer is the one whose symptom points furthest from its cause.
//
// Too small, and packets are dropped in the kernel before the media server ever
// sees them. What a person hears is speech breaking up, which is what a bad
// connection sounds like, and every minute spent looking at the network is a
// minute spent away from a socket option.
func receiveBuffer() Check {
	const suggested = 5_000_000

	if runtime.GOOS != "linux" {
		return Check{
			Name:     "UDP receive buffer",
			Verdict:  Unknown,
			Found:    "not readable on " + runtime.GOOS,
			Examined: "net.core.rmem_max, which only Linux publishes this way.",
		}
	}

	raw, err := os.ReadFile("/proc/sys/net/core/rmem_max")
	if err != nil {
		return Check{
			Name:     "UDP receive buffer",
			Verdict:  Unknown,
			Found:    "could not be read",
			Examined: "/proc/sys/net/core/rmem_max.",
		}
	}

	size, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil {
		return Check{
			Name:     "UDP receive buffer",
			Verdict:  Unknown,
			Found:    strings.TrimSpace(string(raw)),
			Examined: "/proc/sys/net/core/rmem_max, which did not hold a number.",
		}
	}

	if size < suggested {
		return Check{
			Name:     "UDP receive buffer",
			Verdict:  Warn,
			Found:    fmt.Sprintf("%d, below the %d asked for", size, suggested),
			Examined: "net.core.rmem_max against what the media server asks for at startup.",
			Remedy: "Loss here sounds like a bad network. In an unprivileged container this " +
				"cannot be set from inside; set it on the host and restart the container, " +
				"which inherits it: net.core.rmem_max = 8388608",
		}
	}

	return Check{
		Name:     "UDP receive buffer",
		Verdict:  Good,
		Found:    strconv.Itoa(size),
		Examined: "net.core.rmem_max against what the media server asks for at startup.",
	}
}

// loopbackOnly checks that the media server's own HTTP is not facing the world.
//
// It answers to administrative tokens, and this process holds one. Bound to
// every interface it would be a second front door, on a port nobody thinks about
// because nothing in the documentation mentions it.
func loopbackOnly(conf *config.Config) Check {
	addresses := conf.LiveKit.BindAddresses

	if len(addresses) == 0 {
		return Check{
			Name:     "Media server's own HTTP",
			Verdict:  Warn,
			Found:    "every interface",
			Examined: "bind_addresses, which is unset and therefore means all of them.",
			Remedy: "This port answers to administrative tokens. Set bind_addresses to " +
				"[127.0.0.1]; the application forwards signalling to it from there.",
		}
	}

	for _, address := range addresses {
		if ip := net.ParseIP(address); ip == nil || !ip.IsLoopback() {
			return Check{
				Name:     "Media server's own HTTP",
				Verdict:  Warn,
				Found:    strings.Join(addresses, ", "),
				Examined: "bind_addresses, for anything that is not loopback.",
				Remedy:   "This port answers to administrative tokens. Set bind_addresses to [127.0.0.1].",
			}
		}
	}

	return Check{
		Name:     "Media server's own HTTP",
		Verdict:  Good,
		Found:    strings.Join(addresses, ", "),
		Examined: "bind_addresses, for anything that is not loopback.",
	}
}

// Started is when this process came up, for a page that wants to say how long
// it has been running.
var Started = time.Now()
