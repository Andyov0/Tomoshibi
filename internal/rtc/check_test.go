package rtc

import (
	"context"
	"net"
	"testing"
	"time"
)

/*
Checking a relay used to be an HTTPS request to a health endpoint, and that was
the fault rather than an implementation detail of it.

A relay in mainland China is probed by something that opens its TLS port, sends
an ordinary request, and reads what comes back. A port that answers is a
website; an unregistered one is taken off the air. A dashboard checking every
relay every fifteen seconds over HTTPS is precisely that probe, aimed at our own
machines and running forever.

So nothing here speaks HTTP. A socket is opened, the time is taken, and it is
closed without a byte being sent — which is also all a page needs to say whether
a machine is there.
*/

func TestCheckOpensASocketAndSaysNothing(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	// Reads whatever arrives. Nothing should.
	spoken := make(chan int, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()

		_ = conn.SetReadDeadline(time.Now().Add(500 * time.Millisecond))

		buf := make([]byte, 256)
		n, _ := conn.Read(buf)
		spoken <- n
	}()

	cluster := NewCluster(func() []string { return nil }, "key", "secret")

	ok, took, detail := cluster.Check(context.Background(), "ws://"+listener.Addr().String())

	if !ok {
		t.Fatalf("a listening socket was reported unreachable: %s", detail)
	}

	if took <= 0 {
		t.Error("no time was measured")
	}

	select {
	case n := <-spoken:
		if n > 0 {
			t.Errorf("%d bytes were sent to the relay; this must open a socket and say "+
				"nothing, or it is the website probe it was written to stop being", n)
		}
	case <-time.After(2 * time.Second):
		// The read timed out with nothing to read, which is the outcome wanted.
	}
}

func TestCheckReportsAClosedPort(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}

	address := listener.Addr().String()
	listener.Close()

	cluster := NewCluster(func() []string { return nil }, "key", "secret")

	ok, _, detail := cluster.Check(context.Background(), "ws://"+address)
	if ok {
		t.Fatal("a closed port was reported as answering")
	}

	if detail == "" {
		t.Error("nothing was said about why it did not answer")
	}
}

// The addresses this deployment hands out carry explicit ports, and the ones
// that do not fall back to what a browser would use.
func TestHostPortUnderstandsEveryFormWeHandOut(t *testing.T) {
	for _, tc := range []struct{ url, want string }{
		{"wss://gz.relay.example:13377", "gz.relay.example:13377"},
		{"ws://gz.relay.example:13377", "gz.relay.example:13377"},
		{"wss://gz.relay.example:13377/", "gz.relay.example:13377"},
		{"wss://gz.relay.example:13377/rtc", "gz.relay.example:13377"},
		{"wss://gz.relay.example", "gz.relay.example:443"},
		{"ws://gz.relay.example", "gz.relay.example:80"},
	} {
		got, err := hostPort(tc.url)
		if err != nil {
			t.Errorf("%s: %v", tc.url, err)
			continue
		}

		if got != tc.want {
			t.Errorf("%s dialled %s, wanted %s", tc.url, got, tc.want)
		}
	}
}
