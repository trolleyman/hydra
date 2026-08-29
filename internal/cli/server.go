package cli

import (
	"context"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"braces.dev/errtrace"
	"github.com/spf13/cobra"
	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/config"
	httppkg "github.com/trolleyman/hydra/internal/http"
	"github.com/trolleyman/hydra/internal/paths"
)

var simulationMode bool

func init() {
	serverCmd.Flags().BoolVar(&simulationMode, "simulation", false, "Run in simulation mode with mock data")
	rootCmd.AddCommand(serverCmd)
}

var serverCmd = &cobra.Command{
	Use:   "server",
	Short: "Run a web server",
	RunE:  runServer,
}

func runServer(_ *cobra.Command, _ []string) error {
	if simulationMode {
		return errtrace.Wrap(runSimulationServer())
	}

	projectRoot, err := paths.GetProjectRootFromCwd()
	if err != nil {
		log.Fatalf("Resolve project root: %v", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	rt, err := setupRuntime(ctx, projectRoot)
	if err != nil {
		return errtrace.Wrap(err)
	}

	addr, err := resolveWebAddr(rt.deploy)
	if err != nil {
		return errtrace.Wrap(err)
	}
	srv := &http.Server{
		Addr:           addr,
		Handler:        rt.handler,
		MaxHeaderBytes: 1 << 20, // 1 MB
		// Derive every request context from the signal context so Ctrl-C cancels
		// in-flight handlers immediately. Without this, a long-running handler
		// (notably the `claude /usage` probe, up to 20s) keeps srv.Shutdown
		// blocked until its 5s deadline, which races mage's own 5s cleanup
		// timeout and can leave an orphaned server holding the port.
		BaseContext: func(net.Listener) context.Context { return ctx },
	}

	// Also serve the daemon control socket so CLI commands (spawn/attach/list)
	// share this process's session registry - agents started from the CLI show
	// up in the web UI and vice versa. Takes over any existing daemon.
	cleanup, err := serveUnixSocket(ctx, srv, projectRoot)
	if err != nil {
		return errtrace.Wrap(err)
	}
	defer cleanup()

	// Prefer a listener handed over by the process we replaced: inheriting it
	// means a restart never unbinds the port, so requests arriving mid-swap queue
	// in the accept backlog instead of being refused.
	tcpLn, err := webListener(addr)
	if err != nil {
		return errtrace.Wrap(err)
	}
	cleanupDesktopReady, err := publishDesktopReady(tcpLn.Addr())
	if err != nil {
		_ = tcpLn.Close()
		return errtrace.Wrap(err)
	}
	defer cleanupDesktopReady()
	attachSelfUpdate(rt, tcpLn)
	log.Printf("Server starting on http://%s", tcpLn.Addr())

	serveErr := make(chan error, 1)
	go func() { serveErr <- srv.Serve(tcpLn) }()

	// Wait for a signal or a fatal serve error, then shut down cleanly so the
	// port + control socket are released (avoids orphaned servers holding the web port).
	select {
	case <-ctx.Done():
		log.Printf("server: shutting down")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		rt.services.StopAll()
		rt.previews.StopAll()
		rt.reg.StopAll()
		_ = srv.Shutdown(shutdownCtx)
		return nil
	case err := <-serveErr:
		if err == http.ErrServerClosed {
			return nil
		}
		return errtrace.Wrap(err)
	}
}

// defaultWebAddr is the web UI/API bind address when HYDRA_API_ADDR is unset.
const defaultWebAddr = "localhost:26600"

// resolveWebAddr returns the web UI's bind address and refuses an unsafe one.
// The default is localhost:26600 (reachable only from this machine; the
// distinctive registered-range port keeps clear of the heavily-squatted 8080,
// and sits directly below the preview_ports range 26601-26699 so Hydra's whole
// footprint is one contiguous, firewall-friendly block); a normal
// `hydra server` or the CLI-auto-started daemon never exposes the port. Exposing
// it is a deliberate, separate action: `mage deploy:service` (and anything else
// setting HYDRA_API_ADDR=0.0.0.0:<port>) opts in, which this honours. Binding any non-loopback
// address with no auth key configured is refused outright, so the port can never
// be opened to the network without a password.
func resolveWebAddr(deploy config.DeployConfig) (string, error) {
	addr := defaultWebAddr
	if env := os.Getenv("HYDRA_API_ADDR"); env != "" {
		addr = env
	}
	if !isLoopbackBind(addr) && deploy.AuthKey == "" {
		return "", errtrace.Wrap(fmt.Errorf(
			"refusing to bind %s: that exposes Hydra to the network with no password. "+
				"Run `mage deploy:setup` to generate an auth key first", addr))
	}
	return addr, nil
}

// isLoopbackBind reports whether addr binds only the local loopback interface.
// An empty host (e.g. ":26600") or 0.0.0.0/:: binds every interface, so it is not
// loopback.
func isLoopbackBind(addr string) bool {
	host := addr
	if h, _, err := net.SplitHostPort(addr); err == nil {
		host = h
	}
	if host == "" {
		return false
	}
	host = strings.TrimPrefix(strings.TrimSuffix(host, "]"), "[")
	if ip := net.ParseIP(host); ip != nil {
		return ip.IsLoopback()
	}
	return host == "localhost"
}

func runSimulationServer() error {
	log.Printf("Starting Hydra in SIMULATION mode")

	server := &httppkg.SimulationServer{
		Development: true,
	}

	mux := http.NewServeMux()

	// Register API routes (into mux)
	api.HandlerFromMux(server, mux)

	// Mock WebSocket terminal endpoint
	mux.HandleFunc("/ws/projects/{project_id}/agents/{agent_id}/terminal", server.HandleTerminalWS)

	// Mock WebSocket artifacts endpoint (streams the simulated artifact states).
	mux.HandleFunc("/ws/projects/{project_id}/agents/{agent_id}/artifacts", server.HandleArtifactsWS)

	// Mock WebSocket tests endpoint (streams the simulated test verdicts).
	mux.HandleFunc("/ws/projects/{project_id}/agents/{agent_id}/tests", server.HandleTestsWS)

	// Mock WebSocket events endpoint (sends the initial refetch nudge, then idles).
	mux.HandleFunc("/ws/projects/{project_id}/events", server.HandleEventsWS)

	// Raw repository blob - image bytes and raw text (mirrors the real server's
	// hand-served route; backs the image preview and the file viewer's Raw link).
	mux.HandleFunc("/api/projects/{project_id}/repository/blob", server.HandleRepositoryBlob)
	mux.HandleFunc("/api/projects/{project_id}/agents/{agent_id}/repository/blob", server.HandleAgentBlob)

	// Images an agent embedded in a chat message by local path (mirrors the real
	// server's hand-served route), so the inline-image rendering can be demoed.
	mux.HandleFunc("GET /api/projects/{project_id}/agents/{agent_id}/media/blob", server.HandleAgentFileBlob)

	// Prompt/comment attachments (mirrors the real server's hand-served routes),
	// so an attachment chip has bytes behind it here too - the review-comment and
	// chat composers otherwise show a broken thumbnail and log a 404.
	mux.HandleFunc("GET /api/projects/{project_id}/uploads/blob", server.HandleUploadBlob)
	mux.HandleFunc("/api/projects/{project_id}/uploads", server.HandleUpload)

	// Persisted build logs behind the artifacts / tests "Show build log" toggles
	// (mirrors the real server's hand-served routes), so those toggles can be
	// screenshotted - and so a settled test card's log button is live, as it is
	// against a real project.
	// Simulated artifact bytes. The pictures are addressed the way generated ones
	// are (blob?script=&key=&file=), because that triple is an artifact's identity
	// and the review pins derive their anchor from it - a data URL is a picture
	// nothing can be pinned to. See simArtifactBlob.
	mux.HandleFunc("/api/projects/{project_id}/artifacts/{script}/{key_kind}/{key_id}/files/{file...}", server.HandleArtifactBlob)
	mux.HandleFunc("/api/projects/{project_id}/artifacts/{script}/{key_kind}/{key_id}/log", server.HandleArtifactLog)
	mux.HandleFunc("/api/projects/{project_id}/tests/log", server.HandleTestLog)

	// Simulated self-update stream, so the update panel is drivable here too.
	mux.HandleFunc("/ws/server/update", server.HandleServerUpdateWS)

	// Auth status (mirrors the real server's hand-served route): the sim is
	// always local/authenticated. Without it every page load logs a 404 in the
	// console - noise when the sim is used as a live preview.
	mux.HandleFunc("GET /api/auth/status", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"auth_required":false,"authenticated":true}`))
	})

	// Folder-picker availability (mirrors the real server's hand-served route).
	// The sim has no native picker to open, so it answers "no" - the project
	// dropdown just hides its "Browse..." button. Same reason as the auth route:
	// without it every project-dropdown open logs a 404.
	mux.HandleFunc("GET /api/folder-picker/available", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"available":false}`))
	})

	registerFrontend(mux)

	addr := defaultWebAddr
	if envAddr := os.Getenv("HYDRA_API_ADDR"); envAddr != "" {
		addr = envAddr
	}
	log.Printf("Simulation Server starting on http://%s", addr)
	return errtrace.Wrap(http.ListenAndServe(addr, httppkg.CompressionMiddleware(httppkg.LoggingMiddleware(mux))))
}

func trimSlash(s string) string {
	if len(s) > 0 && s[0] == '/' {
		return s[1:]
	}
	return s
}
