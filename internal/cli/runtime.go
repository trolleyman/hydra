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
	"github.com/trolleyman/hydra/internal/events"
	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/heads"
	httppkg "github.com/trolleyman/hydra/internal/http"
	"github.com/trolleyman/hydra/internal/paths"
	"github.com/trolleyman/hydra/internal/projects"
	"github.com/trolleyman/hydra/internal/sandbox"
	"github.com/trolleyman/hydra/internal/services"
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
	services    *services.Manager
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

	// One artifacts Manager per registered project, created lazily on first use.
	artifactReg := artifacts.NewRegistry()

	// Supervises each project's [[services]] (e.g. a host-side emulator pool).
	svcMgr := services.NewManager()

	// Fans change events to web clients over the events WS, replacing per-tab
	// polling. A supervised service's state transition pushes services_changed.
	eventHub := events.NewHub()
	svcMgr.SetOnChange(eventHub.ServicesChanged)

	server := &httppkg.Server{
		WorktreesDir:    worktreesDir,
		ProjectRoot:     projectRoot,
		DefaultProject:  defaultProject,
		ProjectsManager: pm,
		Sessions:        reg,
		DB:              store,
		StartTime:       time.Now(),
		Development:     os.Getenv("HYDRA_DEV_RESTART") == "1",
		Artifacts:       artifactReg,
		Services:        svcMgr,
		Events:          eventHub,
		BackgroundCtx:   ctx,
	}

	if ok, reason := sandbox.Available(); !ok {
		log.Printf("warn: sandbox unavailable: %s", reason)
		server.SetSandboxError(errtrace.Errorf("%s", reason))
	}

	// Archived agents (killed/merged heads) are kept indefinitely so they stay
	// browsable in the history list — we no longer prune soft-deleted rows on
	// boot. PruneDeletedAgents is retained for a future opt-in retention window
	// if the table ever grows uncomfortably large.
	_ = store.PruneDeletedAgents

	// One-time backfill: heads killed/merged before the EndState column existed
	// were soft-deleted with an empty EndState, so they don't appear in the
	// archived-history list. Upgrade the ones that actually ran to "killed" so
	// they become browsable; aborted spawns (never ran) stay excluded. Idempotent.
	if n, err := store.BackfillArchivedEndState(); err != nil {
		log.Printf("warn: backfill archived end_state: %v", err)
	} else if n > 0 {
		log.Printf("Backfilled %d pre-existing soft-deleted agent(s) into the archived history", n)
	}

	// The pollers and boot-time resume cover every registered project, not just
	// the project the daemon was launched in: a single daemon/DB serves all
	// projects added via the web UI, and their agents' status must stay fresh
	// too. roots is re-evaluated each cycle so runtime add/remove is picked up.
	roots := func() []string { return projectRoots(pm) }

	// Migrate every registered project from the old flat .hydra/<dir> layout to
	// .hydra/local/<dir> before anything touches their worktrees or caches. The
	// boot project was already migrated by db.Open above; this covers projects
	// loaded from disk that share this daemon. Idempotent and best-effort.
	for _, root := range roots() {
		if err := paths.MigrateHydraLayout(root); err != nil {
			log.Printf("warn: migrate .hydra layout in %s: %v", root, err)
		}
	}

	// Correct archived heads that were merged but recorded as "killed" (the
	// backfill above defaults everything to "killed", and CLI merges historically
	// archived via the kill path). A merge leaves a "Merge branch 'hydra/<id>'"
	// commit, so git history recovers the distinction. Per project, best-effort;
	// fast-forward merges leave no merge commit and so remain "killed".
	for _, root := range roots() {
		merged, err := git.MergedHydraBranches(root)
		if err != nil {
			log.Printf("warn: detect merged branches in %s: %v", root, err)
			continue
		}
		if len(merged) == 0 {
			continue
		}
		names := make([]string, 0, len(merged))
		for n := range merged {
			names = append(names, n)
		}
		if n, err := store.SetArchivedEndStateMerged(root, names); err != nil {
			log.Printf("warn: correct merged end_state in %s: %v", root, err)
		} else if n > 0 {
			log.Printf("Corrected %d archived agent(s) to end_state=merged in %s", n, root)
		}
	}

	// Resume heads that were running before a restart (best-effort), clear out
	// any ephemeral artifact checkouts left behind by a crash mid-generation, and
	// migrate any cache still in the old flat key layout to the current
	// commit/<sha> & worktree/<hash> layout. Only touch projects that already have
	// an artifacts dir, so we don't create empty ones in projects that never
	// generated artifacts.
	for _, root := range roots() {
		resumeHeadsOnBoot(reg, store, root)
		if _, err := os.Stat(paths.GetArtifactsDirFromProjectRoot(root)); err == nil {
			mgr := artifactReg.Manager(root)
			if n := mgr.MigrateLegacyLayout(); n > 0 {
				log.Printf("Migrated %d artifact cache entr(y/ies) to the new layout in %s", n, root)
			}
			mgr.CleanCheckouts()
		}
	}

	// Immediate first poller cycles before accepting requests.
	for _, root := range roots() {
		heads.ReconcileLivenessOnce(reg, store, root, eventHub)
		heads.RunJSONStatusPollerOnce(store, root)
	}

	go heads.RunLivenessReconciler(ctx, reg, store, roots, eventHub)
	go heads.RunJSONStatusPoller(ctx, store, roots, eventHub)
	go runStoragePruner(ctx, artifactReg, roots)

	// Start each registered project's [[services]]. Done after the pollers so a
	// slow service launch never delays request serving; StopAll on shutdown.
	for _, root := range roots() {
		svcMgr.StartProject(root)
	}

	mux := buildMux(server)
	return &daemonRuntime{
		server:      server,
		handler:     httppkg.LoggingMiddleware(mux),
		store:       store,
		reg:         reg,
		services:    svcMgr,
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
	mux.HandleFunc("/ws/projects/{project_id}/agents/{id}/artifacts", server.HandleArtifactsWS)
	mux.HandleFunc("/ws/projects/{project_id}/events", server.HandleEventsWS)
	mux.HandleFunc("POST /shells/projects/{project_id}/agents/{id}/close", server.HandleShellClose)
	mux.HandleFunc("/artifacts/projects/{project_id}/blob", server.HandleArtifactBlob)
	mux.HandleFunc("/artifacts/projects/{project_id}/log", server.HandleArtifactLog)
	mux.HandleFunc("/repository/projects/{project_id}/blob", server.HandleRepositoryBlob)
	mux.HandleFunc("/repository/projects/{project_id}/agents/{id}/blob", server.HandleAgentBlob)
	mux.HandleFunc("GET /uploads/projects/{project_id}/blob", server.HandleUploadBlob)
	mux.HandleFunc("/uploads/projects/{project_id}", server.HandleUpload)
	mux.HandleFunc("GET /folder-picker/available", server.HandleFolderPickerAvailable)
	mux.HandleFunc("POST /folder-picker/open", server.HandleFolderPickerOpen)
	mux.Handle("/.well-known/", apiHandler)
	registerFrontend(mux)
	return mux
}

// runStoragePruner periodically evicts stale/oversized diff artifacts and
// aged-out prompt uploads across every registered project (roots is
// re-evaluated each cycle). The first cycle runs immediately; thereafter once
// an hour until ctx is done.
func runStoragePruner(ctx context.Context, artifactReg *artifacts.Registry, roots func() []string) {
	prune := func() {
		// Artifacts: prune only projects with a live Manager (lazily created on
		// first artifact request). Reusing the live managers keeps in-flight
		// generation tracking intact and skips projects that never generated any.
		for root, mgr := range artifactReg.Snapshot() {
			if err := mgr.PruneStale(artifacts.DefaultMaxAge, artifacts.DefaultMaxBytes); err != nil {
				log.Printf("warn: prune artifacts (%s): %v", root, err)
			}
		}
		// Uploads are a plain per-project directory, so prune every project.
		for _, root := range roots() {
			if err := httppkg.PruneUploads(root, httppkg.DefaultUploadMaxAge); err != nil {
				log.Printf("warn: prune uploads (%s): %v", root, err)
			}
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

// projectRoots returns the normalized root path of every registered project.
// Paths are normalized to match how agents are stored (project_path) and looked
// up (resolveProjectRoot), so the pollers query the right rows.
func projectRoots(pm *projects.Manager) []string {
	ps := pm.ListProjects()
	out := make([]string, 0, len(ps))
	for _, p := range ps {
		root := p.Path
		if norm, err := paths.NormalizePath(p.Path); err == nil {
			root = norm
		}
		out = append(out, root)
	}
	return out
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
		if reg.IsLive(h.ID) {
			continue
		}
		// Ephemeral test agents never resume: a daemon restart means their test
		// session is gone for good. Tear down the throwaway worktree/branch they
		// left behind (e.g. a crash mid-test) so it doesn't linger.
		if h.Ephemeral {
			log.Printf("daemon: cleaning up orphaned ephemeral head %s after restart", h.ID)
			// "" end state: ephemeral test heads are not part of the browsable
			// archived history, so they stay out of the archived list.
			if err := heads.KillHeadNoLock(context.Background(), reg, store, h, ""); err != nil {
				log.Printf("warn: cleanup ephemeral head %s: %v", h.ID, err)
			}
			continue
		}
		if h.SessionStatus != "running" {
			continue
		}
		log.Printf("daemon: resuming head %s after restart", h.ID)
		// No client is connected on boot, so seed the PTY from the last geometry a
		// browser/TUI reported for this project rather than the narrow 80x24
		// default — otherwise the agent repaints at 80 cols and that wrapped output
		// is baked into the scrollback before the first client ever attaches.
		rows, cols := heads.LoadResumeSize(store, projectRoot, h.ID)
		if err := heads.ResumeHead(reg, store, projectRoot, h, rows, cols); err != nil {
			log.Printf("warn: resume head %s: %v", h.ID, err)
			errMsg := err.Error()
			_ = store.ClearHeadStatus(h.ID, &errMsg)
			_ = store.UpdateSessionInfo(h.ID, 0, "stopped")
		}
	}
}
