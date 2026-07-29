package cli

import (
	"context"
	"log"
	"net"
	"net/http"
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

	// BaseContext ties every request context to the signal context so Ctrl-C
	// cancels in-flight handlers immediately (e.g. the up-to-20s `claude /usage`
	// probe), letting srv.Shutdown return promptly instead of blocking on its
	// 5s deadline. See the matching note in server.go.
	srv := &http.Server{
		Handler:        rt.handler,
		MaxHeaderBytes: 1 << 20,
		BaseContext:    func(net.Listener) context.Context { return ctx },
	}

	cleanup, err := serveUnixSocket(ctx, srv, projectRoot)
	if err != nil {
		return errtrace.Wrap(err)
	}
	defer cleanup()

	// Serve the web UI on TCP (best-effort; the unix socket is authoritative).
	// Defaults to localhost; if a non-loopback bind is requested without an auth
	// key configured, resolveWebAddr refuses it and the web UI is simply left off
	// rather than exposed without a password.
	if daemonFlags.web {
		if addr, err := resolveWebAddr(rt.deploy); err != nil {
			log.Printf("warn: daemon: web UI disabled: %v", err)
		} else if tcpLn, err := webListener(addr); err != nil {
			log.Printf("warn: daemon: web UI listen %s failed: %v", addr, err)
		} else {
			log.Printf("daemon: web UI on http://%s", addr)
			attachSelfUpdate(rt, tcpLn)
			go func() { _ = srv.Serve(tcpLn) }()
		}
	} else {
		// No web listener to carry over, but the daemon can still re-exec itself
		// (a restart asked for over the control socket).
		attachSelfUpdate(rt, nil)
	}

	log.Printf("daemon: ready (project %s)", projectRoot)

	<-ctx.Done()
	log.Printf("daemon: shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	rt.services.StopAll()
	rt.previews.StopAll()
	rt.reg.StopAll()
	_ = srv.Shutdown(shutdownCtx)
	return nil
}
