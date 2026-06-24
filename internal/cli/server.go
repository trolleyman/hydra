package cli

import (
	"context"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"braces.dev/errtrace"
	"github.com/spf13/cobra"
	"github.com/trolleyman/hydra/internal/api"
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

	addr := "localhost:8080"
	if envAddr := os.Getenv("HYDRA_API_ADDR"); envAddr != "" {
		addr = envAddr
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
	// share this process's session registry — agents started from the CLI show
	// up in the web UI and vice versa. Takes over any existing daemon.
	cleanup, err := serveUnixSocket(ctx, srv, projectRoot)
	if err != nil {
		return errtrace.Wrap(err)
	}
	defer cleanup()

	tcpLn, err := net.Listen("tcp", addr)
	if err != nil {
		return errtrace.Wrap(err)
	}
	log.Printf("Server starting on http://%s", addr)

	serveErr := make(chan error, 1)
	go func() { serveErr <- srv.Serve(tcpLn) }()

	// Wait for a signal or a fatal serve error, then shut down cleanly so the
	// port + control socket are released (avoids orphaned servers holding :8080).
	select {
	case <-ctx.Done():
		log.Printf("server: shutting down")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		rt.services.StopAll()
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

func runSimulationServer() error {
	log.Printf("Starting Hydra in SIMULATION mode")

	server := &httppkg.SimulationServer{
		Development: true,
	}

	mux := http.NewServeMux()

	// Register API routes (into mux)
	api.HandlerFromMux(server, mux)

	// Mock WebSocket terminal endpoint
	mux.HandleFunc("/ws/projects/{project_id}/agents/{id}/terminal", server.HandleTerminalWS)

	// Mock WebSocket artifacts endpoint (streams the simulated artifact states).
	mux.HandleFunc("/ws/projects/{project_id}/agents/{id}/artifacts", server.HandleArtifactsWS)

	// Mock WebSocket events endpoint (sends the initial refetch nudge, then idles).
	mux.HandleFunc("/ws/projects/{project_id}/events", server.HandleEventsWS)

	// Raw repository blob — image bytes and raw text (mirrors the real server's
	// non-OpenAPI route; backs the image preview and the file viewer's Raw link).
	mux.HandleFunc("/repository/projects/{project_id}/blob", server.HandleRepositoryBlob)

	registerFrontend(mux)

	addr := "localhost:8080"
	if envAddr := os.Getenv("HYDRA_API_ADDR"); envAddr != "" {
		addr = envAddr
	}
	log.Printf("Simulation Server starting on http://%s", addr)
	return errtrace.Wrap(http.ListenAndServe(addr, httppkg.LoggingMiddleware(mux)))
}

func trimSlash(s string) string {
	if len(s) > 0 && s[0] == '/' {
		return s[1:]
	}
	return s
}
