package main

import (
	"fmt"
	"net"
	"os"
	"time"

	"github.com/pion/turn/v5"
	"tomoshibi/internal/rtc"
)

// relayThrough allocates on a TURN server and waits for somebody to send to the
// address it was given.
//
// Allocating proves the credentials and the listening port. It proves nothing
// about the relay range: a server whose allocation port is firewalled hands back
// an address, accepts the permission, and then silently carries nothing — which
// from a browser is a call that negotiates, connects, and has no media in it.
func relayThrough(address, key, secret, peer string) {
	forward, err := rtc.Forward(address, key, secret)
	if err != nil {
		fmt.Println("mint:", err)
		os.Exit(1)
	}

	conn, err := net.ListenPacket("udp4", "0.0.0.0:0")
	if err != nil {
		fmt.Println("listen:", err)
		os.Exit(1)
	}
	defer conn.Close()

	client, err := turn.NewClient(&turn.ClientConfig{
		STUNServerAddr: address, TURNServerAddr: address, Conn: conn,
		Username: forward.Username, Password: forward.Credential, Realm: "livekit",
	})
	if err != nil {
		fmt.Println("client:", err)
		os.Exit(1)
	}
	defer client.Close()

	if err := client.Listen(); err != nil {
		fmt.Println("listen:", err)
		os.Exit(1)
	}

	relayed, err := client.Allocate()
	if err != nil {
		fmt.Printf("REFUSED %s: %v\n", address, err)
		os.Exit(1)
	}
	defer relayed.Close()

	// The peer has to be permitted before anything it sends is forwarded. This
	// is the step a browser's ICE stack does on its own and the one nothing
	// visible depends on until traffic is expected.
	from, err := net.ResolveUDPAddr("udp4", peer)
	if err != nil {
		fmt.Println("peer:", err)
		os.Exit(1)
	}

	if err := relayed.(interface{ CreatePermissions(...net.Addr) error }).
		CreatePermissions(from); err != nil {
		fmt.Println("permission:", err)
	}

	fmt.Printf("RELAY %s\n", relayed.LocalAddr())

	_ = relayed.SetReadDeadline(time.Now().Add(20 * time.Second))

	buffer := make([]byte, 1500)

	read, sender, err := relayed.ReadFrom(buffer)
	if err != nil {
		fmt.Printf("NOTHING ARRIVED at %s: the allocation works and the relay range does not\n",
			relayed.LocalAddr())
		os.Exit(1)
	}

	fmt.Printf("OK carried %d bytes from %s\n", read, sender)
}
