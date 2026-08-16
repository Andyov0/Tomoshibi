package rtc

import (
	"context"
	"net"
	"sync"
	"time"
)

/*
A control node that runs a relay beside it reaches that relay by the name it
publishes, which resolves to the machine's own public address — and on most
hosts a packet sent to your own public address does not come back. Some routers
do it, most do not, and a cloud network almost never does. The connection is not
refused; it is simply never answered, so every request waits out its timeout.

Nothing looks broken. The relay is up, the page eventually draws, and the
management surface merely takes six seconds a panel. The one deployment where
this was measured spent twelve seconds per call and answered 502 on the slowest
page, because nginx gave up first.

So a connection to an address this machine already holds is turned around at the
socket rather than sent to the network. The name is left alone, which matters:
the certificate is issued for it, and rewriting the URL to 127.0.0.1 would make
every one of these calls fail verification instead of merely being slow.
*/

// loopback dials through the local interface whenever the destination is an
// address this machine holds.
type loopback struct {
	dialer *net.Dialer

	once  sync.Once
	local map[string]bool
}

func newLoopback() *loopback {
	return &loopback{dialer: &net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}}
}

// addresses is every address this machine answers on.
//
// Read once and kept. An address can be added to an interface while a process
// runs, but a relay whose address changed under it has a larger problem than
// this, and re-reading the interface list on every dial would put a syscall in
// front of every management request to save a case that does not happen.
func (l *loopback) addresses() map[string]bool {
	l.once.Do(func() {
		l.local = map[string]bool{}

		addrs, err := net.InterfaceAddrs()
		if err != nil {
			return
		}

		for _, addr := range addrs {
			if ipnet, ok := addr.(*net.IPNet); ok {
				l.local[ipnet.IP.String()] = true
			}
		}
	})

	return l.local
}

// DialContext connects, short-circuiting anything that would leave and come
// back.
func (l *loopback) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return l.dialer.DialContext(ctx, network, address)
	}

	// Resolved first, because what is dialled is usually a name. A name that
	// does not resolve is left to the ordinary dialler to fail on, so that the
	// error a caller sees is the one it would have seen anyway.
	ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil || len(ips) == 0 {
		return l.dialer.DialContext(ctx, network, address)
	}

	mine := l.addresses()

	for _, ip := range ips {
		if mine[ip.IP.String()] {
			// Loopback rather than the address itself: binding to a public
			// address this machine holds works, but going through the loopback
			// interface is the shorter path and is what makes this eleven
			// milliseconds instead of twelve seconds.
			return l.dialer.DialContext(ctx, network, net.JoinHostPort("127.0.0.1", port))
		}
	}

	return l.dialer.DialContext(ctx, network, address)
}
