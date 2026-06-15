package cli

import (
	"context"
	"log"
	"net"
	"net/http"
	"os"
	"time"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/artifacts"
	"github.com/trolleyman/hydra/internal/daemon"
	"github.com/trolleyman/hydra/internal/db"
	"github.com/trolleyman/hydra/internal/heads"
	httppkg "github.com/trolleyman/hydra/internal/http"
	"github.com/trolleyman/hydra/internal/paths"
	"github.com/trolleyman/hydra/internal/projects"
	"github.com/trolleyman/hydra/internal/sandbox"
	"github.com/trolleyman/hydra/internal/session"
)

// runtime bundles the long-lived server state shared by `hydra server` and the
// `hydra __daemon` process: the session registry, DB, HTTP handler, and the
// background pollers (already started).
type daemonRuntime struct {
	server      *httppkg.Server
	handler     http.Handler
	store       *db.Store
	reg         *session.Registry
	projectRoot string
}

// setupRuntime opens the DB, builds the session registry + HTTP server, starts
// the background pollers, and returns a ready-to-serve handler.
func setupRuntime(ctx context.Context, projectRoot string) (*daemonRuntime, error) {
	worktreesDir := paths.GetWorktreesDirFromProjectRoot(projectRoot)
	log.Printf("Worktrees: %s", worktreesDir)

	store, err := db.Open(projectRoot)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	log.Printf("Database: %s", paths.GetDBPathFromProjectRoot(projectRoot))

	reg := session.NewRegistry()
	reg.SetOnExit(func(info session.Info) {
		if err := store.UpdateSessionInfo(info.ID, 0, "stopped"); err != nil {
			log.Printf("warn: mark session %s stopped: %v", info.ID, err)
		}
	})

	pm, err := projects.NewManager()
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	defaultProject, err := pm.AddProject(projectRoot)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	log.Printf("Default project: %s (%s)", defaultProject.Name, defaultProject.ID)

	artifactMgr := artifacts.NewManager(projectRoot)
	artifactMgr.CleanCheckouts()

	server := &httppkg.Server{
		WorktreesDir:    worktreesDir,
		ProjectRoot:     projectRoot,
		DefaultProject:  defaultProject,
		ProjectsManager: pm,
		Sessions:        reg,
		DB:              store,
		StartTime:       time.Now(),
		Development:     os.Getenv("HYDRA_DEV_RESTART") == "1",
		Artifacts:       artifactMgr,
	}

	if ok, reason := sandbox.Available(); !ok {
		log.Printf("warn: sandbox unavailable: %s", reason)
		server.SetSandboxError(errtrace.Errorf("%s", reason))
	}

	if err := store.PruneDeletedAgents(30 * 24 * time.Hour); err != nil {
		log.Printf("warn: prune deleted agents: %v", err)
	}

	// Resume heads that were running before a restart (best-effort).
	resumeHeadsOnBoot(reg, store, projectRoot)

	// Immediate first poller cycles before accepting requests.
	heads.ReconcileLivenessOnce(reg, store, projectRoot)
	heads.RunJSONStatusPollerOnce(store, projectRoot)

	go heads.RunLivenessReconciler(ctx, reg, store, projectRoot)
	go heads.RunJSONStatusPoller(ctx, store, projectRoot)
	go runArtifactPruner(ctx, artifactMgr)

	mux := buildMux(server)
	return &daemonRuntime{
		server:      server,
		handler:     httppkg.LoggingMiddleware(mux),
		store:       store,
		reg:         reg,
		projectRoot: projectRoot,
	}, nil
}

// serveUnixSocket makes srv also serve the project's daemon control socket, so
// the same process handles both the web UI (TCP) and CLI commands. It first
// takes over any existing daemon for the project, removes a stale socket,
// records the daemon pid/stamp, and serves the socket in the background.
// Returns a cleanup function to run on shutdown.
func serveUnixSocket(ctx context.Context, srv *http.Server, projectRoot string) (func(), error) {
	if err := daemon.StopDaemon(ctx, projectRoot); err != nil {
		return nil, errtrace.Wrap(err)
	}
	sockPath, err := daemon.SocketPath(projectRoot)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	_ = os.Remove(sockPath)
	ln, err := net.Listen("unix", sockPath)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	_ = os.Chmod(sockPath, 0o600)
	if err := daemon.WriteDaemonFiles(projectRoot); err != nil {
		log.Printf("warn: write daemon files: %v", err)
	}
	log.Printf("Control socket: %s", sockPath)
	go func() { _ = srv.Serve(ln) }()

	return func() {
		_ = os.Remove(sockPath)
		daemon.RemoveDaemonFiles(projectRoot)
	}, nil
}

// buildMux wires the API, websocket terminal, and frontend routes.
func buildMux(server *httppkg.Server) *http.ServeMux {
	mux := http.NewServeMux()
	apiHandler := httppkg.RequestBodyLimitMiddleware(10 * 1024 * 1024)(httppkg.NewHandler(server))
	mux.Handle("/api/", apiHandler)
	mux.Handle("/health", apiHandler)
	mux.HandleFunc("/ws/projects/{project_id}/agents/{id}/terminal", server.HandleTerminalWS)
	mux.HandleFunc("/artifacts/projects/{project_id}/blob", server.HandleArtifactBlob)
	mux.HandleFunc("/uploads/projects/{project_id}", server.HandleUpload)
	mux.Handle("/.well-known/", apiHandler)
	registerFrontend(mux)
	return mux
}

// runArtifactPruner periodically evicts stale/oversized diff artifacts. The
// first cycle runs immediately; thereafter once an hour until ctx is done.
func runArtifactPruner(ctx context.Context, mgr *artifacts.Manager) {
	prune := func() {
		if err := mgr.PruneStale(artifacts.DefaultMaxAge, artifacts.DefaultMaxBytes); err != nil {
			log.Printf("warn: prune artifacts: %v", err)
		}
	}
	prune()
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			prune()
		}
	}
}

// resumeHeadsOnBoot restarts agents that the DB marks as running but have no
// live session (e.g. after a daemon restart), via each agent's own --resume.
func resumeHeadsOnBoot(reg *session.Registry, store *db.Store, projectRoot string) {
	hs, err := heads.ListHeads(context.Background(), reg, store, projectRoot)
	if err != nil {
		log.Printf("warn: resume on boot: list heads: %v", err)
		return
	}
	for _, h := range hs {
		if h.Ephemeral || h.SessionStatus != "running" {
			continue
		}
		if reg.IsLive(h.ID) {
			continue
		}
		log.Printf("daemon: resuming head %s after restart", h.ID)
		if err := heads.ResumeHead(reg, store, projectRoot, h, 24, 80); err != nil {
			log.Printf("warn: resume head %s: %v", h.ID, err)
			errMsg := err.Error()
			_ = store.ClearHeadStatus(h.ID, &errMsg)
			_ = store.UpdateSessionInfo(h.ID, 0, "stopped")
		}
	}
}
