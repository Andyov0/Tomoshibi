// Whether a relay will actually allocate for us, from outside.
//
// The unit tests prove the credential format is one the relay's own auth
// handler accepts. They cannot prove the packets arrive: a security group, a
// host firewall, or a relay port range nobody opened all look exactly like a
// working configuration from here, and exactly like a call that never connects
// from a browser.
package main

import (
	"fmt"
	"net"
	"os"
	"time"

	"github.com/pion/turn/v5"
	"tomoshibi/internal/rtc"
)

func main() {
	address, key, secret := os.Args[1], os.Args[2], os.Args[3]

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
		STUNServerAddr: address,
		TURNServerAddr: address,
		Conn:           conn,
		Username:       forward.Username,
		Password:       forward.Credential,
		Realm:          "livekit",
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

	started := time.Now()

	relayed, err := client.Allocate()
	if err != nil {
		fmt.Printf("REFUSED %s: %v\n", address, err)
		os.Exit(1)
	}
	defer relayed.Close()

	fmt.Printf("OK %s -> relays at %s in %dms\n",
		address, relayed.LocalAddr(), time.Since(started).Milliseconds())
}
