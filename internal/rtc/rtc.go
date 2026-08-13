// Package rtc embeds the media server in this process.
//
// LiveKit ships as a library whose server can be constructed and started
// directly, which is what makes a single binary possible: the token this server
// signs is verified by the same credentials, in the same process, with no second
// service to deploy and no shared secret to distribute.
//
// Its own HTTP listener is kept on the loopback interface. Everything a browser
// talks to arrives at [meet-live/internal/app], which forwards the signalling
// paths here. That leaves one port facing the network for TCP, and it is ours.
package rtc

import (
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"
	"time"

	"github.com/livekit/livekit-server/pkg/config"
	"github.com/livekit/livekit-server/pkg/routing"
	"github.com/livekit/livekit-server/pkg/service"
	"github.com/livekit/livekit-server/pkg/telemetry/prometheus"
)

// Paths the media server owns. Everything else belongs to the application.
//
// `/rtc` is the signalling WebSocket, `/twirp` the management API the client
// never calls but the SDKs expect to find, and `/rtc/validate` a health check
// clients use before connecting.
var Paths = []string{"/rtc", "/rtc/", "/twirp/"}

// Server is the embedded media server together with a proxy to its listener.
type Server struct {
	inner *service.LivekitServer
	proxy *httputil.ReverseProxy
}

// Start builds and starts the media server, returning once it is accepting
// connections.
func Start(conf *config.Config) (*Server, error) {
	// The media server logs through its own package rather than the standard
	// library, and left uninitialised it says nothing at all: a session that
	// fails to set up looks exactly like one that never happened.
	config.InitLoggerFromConfig(&conf.Logging)

	node, err := routing.NewLocalNode(conf)
	if err != nil {
		return nil, fmt.Errorf("build a routing node: %w", err)
	}

	// Before the server is built, not after: it installs the hardware-stats
	// collectors the routing layer reads from, and without it the stats worker
	// dereferences a nil pointer within a second of starting.
	if err := prometheus.Init(string(node.NodeID()), node.NodeType()); err != nil {
		return nil, fmt.Errorf("initialise metrics: %w", err)
	}

	inner, err := service.InitializeServer(conf, node)
	if err != nil {
		return nil, fmt.Errorf("build the media server: %w", err)
	}

	failed := make(chan error, 1)
	go func() {
		// Start blocks until the server stops, so a failure to bind shows up
		// here rather than as a server that quietly never came up.
		failed <- inner.Start()
	}()

	if err := await(inner, failed); err != nil {
		return nil, err
	}

	upstream, err := url.Parse(fmt.Sprintf("http://127.0.0.1:%d", inner.HTTPPort()))
	if err != nil {
		return nil, fmt.Errorf("address the media server: %w", err)
	}

	return &Server{inner: inner, proxy: httputil.NewSingleHostReverseProxy(upstream)}, nil
}

// await blocks until the server is running, it fails, or patience runs out.
func await(inner *service.LivekitServer, failed <-chan error) error {
	deadline := time.After(15 * time.Second)

	for {
		select {
		case err := <-failed:
			if err != nil {
				return fmt.Errorf("start the media server: %w", err)
			}
			return fmt.Errorf("the media server stopped before it finished starting")
		case <-deadline:
			return fmt.Errorf("the media server did not start within fifteen seconds")
		default:
			if inner.IsRunning() {
				return nil
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
}

// Handler forwards a request to the media server.
//
// The standard reverse proxy carries a WebSocket upgrade through unchanged,
// which is the only thing signalling needs from it.
func (s *Server) Handler() http.Handler {
	return s.proxy
}

// Stop shuts the media server down, waiting for sessions to drain unless force
// says otherwise.
func (s *Server) Stop(force bool) {
	s.inner.Stop(force)
}
