// Command tomoshibi is a video meeting server: the media server, the join
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
	"strings"
	"syscall"
	"text/tabwriter"
	"time"

	"tomoshibi/internal/app"
	"tomoshibi/internal/config"
	"tomoshibi/internal/room"
	"tomoshibi/internal/rtc"
	"tomoshibi/internal/store"
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
	case "admin":
		return adminCommand(rest)
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
	case "serve", "keygen", "rooms", "admin", "help", "-h", "--help":
		return args[0], args[1:]
	default:
		// Anything else is taken as the configuration file, so
		// `tomoshibi meet.yaml` works without the ceremony.
		return "serve", args
	}
}

func usage(w *os.File) {
	fmt.Fprint(w, `tomoshibi: a video meeting server in one binary

  tomoshibi [serve] [config.yaml]   Serve the client, the API, and the media
  tomoshibi keygen                  Print a fresh API key and secret
  tomoshibi rooms <database>        List the rooms a store has seen
  tomoshibi admin new [config.yaml] Make an administrator's passphrase and trip
  tomoshibi admin trip [config.yaml] <passphrase>
                                    Work out the trip an existing passphrase gives

Running with no arguments serves with built-in defaults.
`)
}

// adminCommand turns a passphrase into the signature a configuration file
// lists, in both directions.
//
// It needs the configuration because a signature is only meaningful against one
// deployment's key: the same passphrase on two servers produces two different
// marks, which is what stops one deployment's signatures being worth anything on
// another.
func adminCommand(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("admin needs `new` or `trip`")
	}

	action, rest := args[0], args[1:]

	path := ""
	if len(rest) > 0 && strings.HasSuffix(rest[0], ".yaml") {
		path, rest = rest[0], rest[1:]
	}

	conf, err := config.Load(path)
	if err != nil {
		return err
	}

	key, err := room.LoadTripKey(conf.Meet.TripcodeKey)
	if err != nil {
		return err
	}

	switch action {
	case "new":
		// Generated, never chosen. A signature cannot be attacked offline
		// without this deployment's key, so the only way at one is through the
		// join endpoint — where the limiter stands. But the limiter counts per
		// address and an attacker picks how many addresses to be, and against a
		// passphrase somebody thought of that is about a quarter of an hour.
		passphrase := room.NewPassphrase()

		fmt.Printf("passphrase  %s\n", passphrase)
		fmt.Printf("trip        %s\n\n", room.Trip(key, passphrase))
		fmt.Print("Put the trip in the configuration and the passphrase in a password manager.\n" +
			"The passphrase is not stored here and cannot be recovered; the trip is public and\n" +
			"is printed beside its owner's name in every room they join.\n")

		return nil

	case "trip":
		if len(rest) == 0 {
			return fmt.Errorf("admin trip needs a passphrase")
		}

		fmt.Println(room.Trip(key, strings.TrimSpace(strings.Join(rest, " "))))
		return nil

	default:
		return fmt.Errorf("admin has no %q; the two are `new` and `trip`", action)
	}
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

	// What this process is made of follows from its role. A relay carries media
	// and keeps nothing; a control node keeps everything and carries none.
	var (
		web     http.Handler
		st      *store.Store
		tripKey []byte
		media   *rtc.Server
	)

	if conf.Meet.Role != config.RoleRelay {
		var err error

		if web, err = client(conf.Meet.WebRoot); err != nil {
			return err
		}

		if st, err = store.Open(conf.Meet.Database); err != nil {
			return err
		}
		defer st.Close()

		if err := adoptOpening(st, conf); err != nil {
			return err
		}

		if err := adoptRelays(st, conf); err != nil {
			return err
		}

		if tripKey, err = room.LoadTripKey(conf.Meet.TripcodeKey); err != nil {
			return err
		}
	}

	// A control node starts none: the meetings it authorises are held on the
	// relays it lists, and a media server here would sit idle holding a UDP
	// port open on a machine nobody was ever told to dial.
	if conf.Meet.Role != config.RoleControl {
		var err error
		if media, err = rtc.Start(conf.LiveKit); err != nil {
			return err
		}
	}

	announceRole(conf)

	application := app.New(conf, st, media, web, tripKey)
	defer application.Close()

	// A control node has no media server of its own, so the management pages
	// would have nothing to ask about rooms or participants. Pointed at the
	// relays instead, they work as a full deployment's do: the questions go to
	// whichever relay answers, and redis makes any one of them speak for all.
	if conf.Meet.Role == config.RoleControl {
		application.UseCluster(rtc.NewCluster(
			func() []string { return application.RelayURLs() },
			conf.Key, conf.Secret,
		))
	}

	server := &http.Server{
		Addr:    conf.Meet.Listen,
		Handler: application.Handler(),
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

	announce(listener.Addr(), conf.Meet.TLSCert != "")

	stopping := make(chan os.Signal, 1)
	signal.Notify(stopping, os.Interrupt, syscall.SIGTERM)

	failed := make(chan error, 1)
	go func() {
		// Configured certificate wins. Checked at load, so a file that is
		// missing or does not match its key has already been a message rather
		// than a listener that quietly never came up — or worse, one that came
		// up plaintext on a deployment that believed otherwise.
		var err error
		if conf.Meet.TLSCert != "" {
			err = server.ServeTLS(listener, conf.Meet.TLSCert, conf.Meet.TLSKey)
		} else {
			err = server.Serve(listener)
		}

		if err != nil && !errors.Is(err, http.ErrServerClosed) {
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
	//
	// A control node has none to drain.
	if media != nil {
		media.Stop(false)
	}

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
// The address on the network comes with a warning rather than on its own,
// because over plain HTTP it is a link that loads and then cannot open a camera:
// browsers withhold devices outside a secure context, and only localhost is
// exempt. Printing it unqualified would be an invitation into that dead end.
// adoptOpening settles who may open a room, and says so.
//
// The configuration file is the starting value and only that: it is written into
// the store the first time this runs, and after that the management pages are
// what change it. Said out loud on every start because there is no other way to
// find out — a file that no longer matches is the likeliest reason somebody is
// standing in front of this wondering why a room will not open.
// adoptRelays writes the configured relays into the store the first time this
// runs, and says what is in effect.
//
// The file is the starting value and only that, exactly as the opening policy
// is: after the first start the management pages are what change this, and a
// file that no longer matches is the likeliest reason somebody is looking at a
// relay list that is not the one they edited.
func adoptRelays(st *store.Store, conf *config.Config) error {
	configured := make([]store.Relay, 0, len(conf.Meet.Relays))
	for _, relay := range conf.Meet.Relays {
		configured = append(configured, store.Relay{
			Name: relay.Name, URL: relay.URL, Region: relay.Region, Enabled: true,
		})
	}

	adopted, err := st.AdoptRelays(configured)
	if err != nil {
		return err
	}

	live, err := st.Relays()
	if err != nil {
		return err
	}

	if adopted && len(configured) > 0 {
		slog.Info("adopted the relays from the configuration file; the management pages "+
			"are what change them from here", "relays", len(configured))
	}

	if !adopted && len(conf.Meet.Relays) > 0 {
		slog.Warn("meet.relays in the configuration file is the starting value only, and this "+
			"deployment already has its own list. Edit the relays from the management pages",
			"configured", len(conf.Meet.Relays), "in effect", len(live))
	}

	for _, relay := range live {
		slog.Info("relay", "name", relay.Name, "url", relay.URL,
			"region", relay.Region, "enabled", relay.Enabled)
	}

	return nil
}

func adoptOpening(st *store.Store, conf *config.Config) error {
	chosen, err := st.AdoptOpening(conf.Meet.Rooms.OpenedBy)
	if err != nil {
		return err
	}

	admins := len(conf.Meet.Admins)

	if opening := chosen.InEffect(admins); opening != chosen {
		slog.Warn(
			"rooms are set to be opened by an administrator, and nobody is configured as one. "+
				"Nothing could satisfy that, so anybody may open one until somebody is listed",
			"chosen", chosen, "in effect", opening)

		return nil
	}

	if chosen != conf.Meet.Rooms.OpenedBy {
		slog.Warn(
			"who may open a room was changed from the management pages and no longer matches "+
				"the configuration file, which is only ever the starting value",
			"configured", conf.Meet.Rooms.OpenedBy, "in effect", chosen)

		return nil
	}

	slog.Info("rooms", "opened by", chosen, "administrators", admins)

	return nil
}

// announceRole says which half of a deployment this process is, and what that
// means for the ports it is about to open.
//
// Said out loud because the roles fail quietly when confused. A relay nobody
// realises is a relay looks like a broken server: the address serves no client
// and answers 404 for everything a browser asks for, which is correct and looks
// exactly like a deployment gone wrong.
func announceRole(conf *config.Config) {
	switch conf.Meet.Role {
	case config.RoleRelay:
		slog.Info("relay: media and signalling only, no client and no join endpoint",
			"udp", conf.LiveKit.RTC.UDPPort, "tcp", conf.LiveKit.RTC.TCPPort)

		// A relay's whole purpose is being dialled from elsewhere, and the
		// address it advertises comes from this. Left false it hands out an
		// address only the machine itself can reach, and every connection to it
		// fails after appearing to succeed.
		if !conf.LiveKit.RTC.UseExternalIP {
			slog.Warn("rtc.use_external_ip is false on a relay: clients will be handed an " +
				"address only this machine can reach. Set it unless a proxy rewrites candidates")
		}

		if conf.LiveKit.Redis.Address == "" {
			slog.Warn("no redis is configured: this relay cannot join others in a cluster, so " +
				"a meeting split across relays will not be able to hear itself")
		}

	case config.RoleControl:
		slog.Info("control: client, joins and management; media is held on the relays below",
			"relays", len(conf.Meet.Relays), "policy", conf.Meet.RelayPolicy)

		for _, relay := range conf.Meet.Relays {
			slog.Info("relay", "name", relay.Name, "url", relay.URL, "region", relay.Region)
		}

		if conf.LiveKit.Redis.Address == "" {
			slog.Warn("no redis is configured: the relays cannot route between themselves, so " +
				"everybody in one meeting must land on one relay. The sticky policy does that")
		}

	default:
		slog.Info("serving the client, the joins and the media from this one process")
	}
}

func announce(addr net.Addr, secure bool) {
	tcp, ok := addr.(*net.TCPAddr)
	if !ok {
		slog.Info("listening", "addr", addr.String())
		return
	}

	scheme := "http"
	if secure {
		scheme = "https"
	}

	slog.Info("client", "url", fmt.Sprintf("%s://localhost:%d/", scheme, tcp.Port))

	for _, ip := range outward() {
		if secure {
			slog.Info("reachable on the network", "url", fmt.Sprintf("https://%s:%d/", ip, tcp.Port))
			continue
		}

		slog.Warn(
			"reachable on the network, but cameras need a secure page: put this behind HTTPS "+
				"before using it from another machine",
			"url", fmt.Sprintf("http://%s:%d/", ip, tcp.Port),
		)
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
