// Command meet-live is a video meeting server: the media server, the join
// endpoint, and the client, in one binary.
//
// The media server is embedded rather than run alongside. Folding the two
// together means the token is signed with the same credentials, in the same
// process, that verify it, and that deploying this is copying one file.
package main

import (
	"context"
	"crypto/rand"
	"embed"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"text/tabwriter"
	"time"

	"meet-live/internal/app"
	"meet-live/internal/config"
	"meet-live/internal/rtc"
	"meet-live/internal/store"
)

// The built client.
//
// `all:` so that files beginning with a dot or an underscore are kept, which
// some build outputs rely on and which is also what keeps the tracked marker
// file inside this directory from being skipped. The directory has to exist at
// compile time even when nothing has been built into it, so the repository
// carries that marker and ignores everything else here.
//
//go:embed all:web/dist
var bundled embed.FS

// What to serve when nothing was built.
//
// Kept as its own file rather than as a document inside the client's output
// directory, so that building the client cannot overwrite it and leave a
// spurious change behind in the working tree.
//
//go:embed placeholder.html
var placeholder []byte

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	command, rest := split(args)

	switch command {
	case "serve":
		return serve(rest)
	case "keygen":
		return keygen()
	case "rooms":
		return listRooms(rest)
	case "help", "-h", "--help":
		usage(os.Stdout)
		return nil
	default:
		usage(os.Stderr)
		return fmt.Errorf("unknown command %q", command)
	}
}

// split separates the command from its arguments, defaulting to serve.
//
// Defaulting rather than requiring it, because running the binary with no
// arguments should start a server: that is what somebody trying it out means,
// and a usage message would be a worse answer than a working default.
func split(args []string) (string, []string) {
	if len(args) == 0 {
		return "serve", nil
	}

	switch args[0] {
	case "serve", "keygen", "rooms", "help", "-h", "--help":
		return args[0], args[1:]
	default:
		// Anything else is taken as the configuration file, so
		// `meet-live meet.yaml` works without the ceremony.
		return "serve", args
	}
}

func usage(w *os.File) {
	fmt.Fprint(w, `meet-live: a video meeting server in one binary

  meet-live [serve] [config.yaml]   Serve the client, the API, and the media
  meet-live keygen                  Print a fresh API key and secret
  meet-live rooms <database>        List the rooms a store has seen

Running with no arguments serves with built-in defaults.
`)
}

func serve(args []string) error {
	path := ""
	if len(args) > 0 {
		path = args[0]
	}

	conf, err := config.Load(path)
	if err != nil {
		return err
	}

	logging(conf.LiveKit.Logging.Level)

	web, err := client(conf.Meet.WebRoot)
	if err != nil {
		return err
	}

	st, err := store.Open(conf.Meet.Database)
	if err != nil {
		return err
	}
	defer st.Close()

	media, err := rtc.Start(conf.LiveKit)
	if err != nil {
		return err
	}

	server := &http.Server{
		Addr:    conf.Meet.Listen,
		Handler: app.New(conf, st, media, web).Handler(),
		// Absent on purpose: a signalling WebSocket is meant to stay open for
		// the length of a meeting, and a write timeout would cut it. Read
		// headers are still bounded, which is what protects against a client
		// that connects and says nothing.
		ReadHeaderTimeout: 10 * time.Second,
	}

	listener, err := net.Listen("tcp", conf.Meet.Listen)
	if err != nil {
		return fmt.Errorf("listen on %s: %w", conf.Meet.Listen, err)
	}

	announce(listener.Addr())

	stopping := make(chan os.Signal, 1)
	signal.Notify(stopping, os.Interrupt, syscall.SIGTERM)

	failed := make(chan error, 1)
	go func() {
		if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			failed <- err
		}
	}()

	select {
	case err := <-failed:
		return err
	case <-stopping:
		slog.Info("shutting down")
	}

	// Sessions first, then the listener: draining the media server while the
	// door is still open lets a participant finish their sentence, where the
	// other order would drop them and then wait politely for nothing.
	media.Stop(false)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	return server.Shutdown(ctx)
}

// client picks where the client is served from.
//
// A configured directory wins, so that a running server can be pointed at a
// fresh build without recompiling. Otherwise it is the copy inside the binary,
// which is what a deployment uses and why there is only one file to copy.
func client(root string) (http.Handler, error) {
	if root != "" {
		files, err := app.Dir(root)
		if err != nil {
			return nil, fmt.Errorf("serve the client from %s: %w", root, err)
		}

		slog.Info("serving the client from disk", "path", root)
		return app.Web(files), nil
	}

	files, err := fs.Sub(bundled, "web/dist")
	if err != nil {
		return nil, fmt.Errorf("read the bundled client: %w", err)
	}

	// Nothing was built into this binary. Answering 404 for every path would be
	// accurate and useless; one page saying which command to run is what this
	// situation actually needs.
	if _, err := fs.Stat(files, "index.html"); err != nil {
		slog.Warn("no client was built into this binary, serving instructions instead")
		return app.Placeholder(placeholder), nil
	}

	return app.Web(files), nil
}

// keygen prints a fresh credential pair.
//
// Printed rather than written, because where it belongs is a question only the
// operator can answer: a configuration file, a secret store, or an environment
// variable in a deployment system.
func keygen() error {
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		return fmt.Errorf("read random bytes: %w", err)
	}

	name := make([]byte, 6)
	if _, err := rand.Read(name); err != nil {
		return fmt.Errorf("read random bytes: %w", err)
	}

	fmt.Printf("keys:\n  API%s: %s\n", hex.EncodeToString(name), hex.EncodeToString(secret))
	return nil
}

// listRooms prints every room a store has seen, most recent first.
func listRooms(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("which store? pass the path to the database file")
	}

	st, err := store.Open(args[0])
	if err != nil {
		return err
	}
	defer st.Close()

	rooms, err := st.Rooms()
	if err != nil {
		return err
	}

	if len(rooms) == 0 {
		fmt.Printf("no rooms recorded in %s\n", args[0])
		return nil
	}

	out := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(out, "ROOM\tJOINS\tLAST SEEN")
	for _, named := range rooms {
		fmt.Fprintf(out, "%s\t%d\t%s\n",
			named.Name, named.Room.Joins, named.Room.Seen.Format(time.RFC3339))
	}

	return out.Flush()
}

// announce prints where to open the client.
//
// Including the addresses of the outward-facing interface, because somebody
// meaning to use this from another machine otherwise has to go looking for it.
func announce(addr net.Addr) {
	tcp, ok := addr.(*net.TCPAddr)
	if !ok {
		slog.Info("listening", "addr", addr.String())
		return
	}

	slog.Info("client", "url", fmt.Sprintf("http://localhost:%d/", tcp.Port))

	for _, ip := range outward() {
		slog.Info("client on the network", "url", fmt.Sprintf("http://%s:%d/", ip, tcp.Port))
	}
}

// outward returns the address this host would use to reach the wider network.
//
// Connecting a UDP socket sends nothing; it asks the routing table which local
// address would carry a packet outward, which is the one worth printing.
func outward() []net.IP {
	conn, err := net.Dial("udp4", "203.0.113.1:80")
	if err != nil {
		return nil
	}
	defer conn.Close()

	addr, ok := conn.LocalAddr().(*net.UDPAddr)
	if !ok || addr.IP.IsLoopback() {
		return nil
	}

	return []net.IP{addr.IP}
}

// logging installs a handler at the level the configuration asked for.
func logging(level string) {
	var parsed slog.Level
	if err := parsed.UnmarshalText([]byte(level)); err != nil {
		parsed = slog.LevelInfo
	}

	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: parsed})))
}
