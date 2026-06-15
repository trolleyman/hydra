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
	"github.com/trolleyman/hydra/internal/paths"
)

var daemonFlags struct {
	project string
	web     bool
}

func init() {
	daemonCmd.Flags().StringVar(&daemonFlags.project, "project", "", "Project root (default: CWD)")
	daemonCmd.Flags().BoolVar(&daemonFlags.web, "web", true, "Also serve the web UI on a localhost TCP port")
	rootCmd.AddCommand(daemonCmd)
}

// daemonCmd runs hydrad: the per-project background process that owns agent
// sessions and serves the API over a unix socket (and optionally TCP for the
// web UI). It is started automatically by the CLI; users rarely run it directly.
var daemonCmd = &cobra.Command{
	Use:    "__daemon",
	Hidden: true,
	Short:  "Run the hydra daemon (internal)",
	RunE:   runDaemon,
}

func runDaemon(_ *cobra.Command, _ []string) error {
	projectRoot := daemonFlags.project
	if projectRoot == "" {
		var err error
		projectRoot, err = paths.GetProjectRootFromCwd()
		if err != nil {
			return errtrace.Wrap(err)
		}
	}
	if norm, err := paths.NormalizePath(projectRoot); err == nil {
		projectRoot = norm
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	rt, err := setupRuntime(ctx, projectRoot)
	if err != nil {
		return errtrace.Wrap(err)
	}

	srv := &http.Server{Handler: rt.handler, MaxHeaderBytes: 1 << 20}

	cleanup, err := serveUnixSocket(ctx, srv, projectRoot)
	if err != nil {
		return errtrace.Wrap(err)
	}
	defer cleanup()

	// Serve the web UI on TCP (best-effort; the unix socket is authoritative).
	if daemonFlags.web {
		addr := "localhost:8080"
		if env := os.Getenv("HYDRA_API_ADDR"); env != "" {
			addr = env
		}
		if tcpLn, err := net.Listen("tcp", addr); err != nil {
			log.Printf("warn: daemon: web UI listen %s failed: %v", addr, err)
		} else {
			log.Printf("daemon: web UI on http://%s", addr)
			go func() { _ = srv.Serve(tcpLn) }()
		}
	}

	log.Printf("daemon: ready (project %s)", projectRoot)

	<-ctx.Done()
	log.Printf("daemon: shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	rt.reg.StopAll()
	_ = srv.Shutdown(shutdownCtx)
	return nil
}
