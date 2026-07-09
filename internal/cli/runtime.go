package cli

import (
	"context"
	"log"
	"net"
	"net/http"
	"os"
	"time"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/artifacts"
	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/daemon"
	"github.com/trolleyman/hydra/internal/db"
	"github.com/trolleyman/hydra/internal/events"
	"github.com/trolleyman/hydra/internal/gate"
	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/heads"
	httppkg "github.com/trolleyman/hydra/internal/http"
	"github.com/trolleyman/hydra/internal/paths"
	"github.com/trolleyman/hydra/internal/preview"
	"github.com/trolleyman/hydra/internal/projects"
	"github.com/trolleyman/hydra/internal/sandbox"
	"github.com/trolleyman/hydra/internal/services"
	"github.com/trolleyman/hydra/internal/session"
	hydratests "github.com/trolleyman/hydra/internal/tests"
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
	previews    *preview.Manager
	projectRoot string
	deploy      config.DeployConfig
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
		// An ephemeral session is a web bash shell; a standalone sandboxed one may
		// have built its own egress boundary (StartShellSession, agent-not-live path),
		// so tear that proxy down with the tab. A no-op for shells that share the
		// agent's netns or run unfiltered.
		if info.Ephemeral {
			heads.StopShellEgress(info.ID)
		}
		// A head whose process died without hydra asking (an agent pkill-ing
		// itself, a crash, an OOM kill) is brought back automatically -
		// crash-loop capped; see MaybeAutoRestartHead. Deliberate stops carry
		// info.StopRequested and are ignored.
		heads.MaybeAutoRestartHead(reg, store, info)
	})
	// A chat-mode turn that fails mid-response (Claude's "API Error: ... The
	// response above may be incomplete.") emits an isApiErrorMessage assistant
	// line but fires no hook, so the head would otherwise sit silently in
	// "running" with a truncated reply. Flip it into the error status by writing
	// status.json exactly as the in-sandbox hook would; the JSON poller picks it
	// up within a tick, updates the DB, raises the unread flag and broadcasts, and
	// the web surfaces it (red status + a toast/OS notification). It clears itself
	// when the user's next message resumes the agent (its UserPromptSubmit hook
	// writes "running" with a newer timestamp).
	reg.SetOnChatAPIError(func(id, msg string) {
		agent, err := store.GetAgent(id)
		if err != nil || agent == nil {
			return // unknown or archived head - nothing to flag.
		}
		nt := gate.NotificationAPIError
		text := msg
		if text == "" {
			text = "The agent's turn failed mid-response - the reply may be incomplete."
		}
		if err := heads.WriteAgentStatus(agent.ProjectPath, id, &api.AgentStatusInfo{
			Status:           api.Errored,
			Timestamp:        time.Now().Format(time.RFC3339Nano),
			LastMessage:      &text,
			NotificationType: &nt,
		}); err != nil {
			log.Printf("warn: write api-error status for %s: %v", id, err)
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

	// One test-runner Manager per registered project (PLAN #68).
	testReg := hydratests.NewRegistry()

	// Supervises each project's [[services]] (e.g. a host-side emulator pool).
	// Gate the services on activity: a project runs its services only while it has
	// at least one agent, so an idle project doesn't hold a resource pool open (see
	// RunActivityGate below). The probe counts a project's active (non-archived)
	// agents; on a read error it returns 1 so a transient DB blip keeps services up
	// rather than tearing a pool down.
	svcMgr := services.NewManager()
	svcMgr.SetActivityProbe(func(root string) int {
		agents, err := store.ListAgents(root)
		if err != nil {
			log.Printf("services: count agents for %s: %v", root, err)
			return 1
		}
		return len(agents)
	})

	// Holds chat-mode heads' queued (not-yet-sent) user messages, daemon-side and
	// disk-persisted, dumping the whole queue at the next observed step of the
	// running turn (the CLI injects mid-turn stdin messages at its next step
	// boundary, like the interactive terminal) or at the turn's end. Wired to
	// the registry's stdout hooks so the queue drains even with no client
	// attached (the agent keeps working through the queue).
	chatQueues := heads.NewChatQueueManager(reg, store)
	reg.SetOnChatResult(chatQueues.OnTurnEnd)
	reg.SetOnChatStep(chatQueues.OnTurnStep)
	// Auto-approve the ExitPlanMode plan gate for chat heads: with
	// --permission-prompt-tool stdio it arrives as a can_use_tool control_request
	// nothing answers, so the head would hang leaving plan mode. Answer it
	// daemon-side (mirrors the terminal-mode PermissionRequest hook auto-approve),
	// so it fires even with no browser attached.
	reg.SetOnChatPlanApproval(chatQueues.OnPlanApproval)

	// Fans change events to web clients over the events WS, replacing per-tab
	// polling. A supervised service's state transition pushes services_changed.
	eventHub := events.NewHub()
	svcMgr.SetOnChange(eventHub.ServicesChanged)
	// A finished test run settling pushes agents_changed so the sidebar/header
	// verdict chips refresh instantly instead of lagging behind the detail panel.
	testReg.SetOnSettle(eventHub.AgentsChanged)

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
		Tests:           testReg,
		Services:        svcMgr,
		Events:          eventHub,
		ChatQueues:      chatQueues,
		BackgroundCtx:   ctx,
	}

	// A streamed (type=stdout) run's ticking counts push per-head
	// agent_tests_changed payload events (throttled inside the manager), so the
	// sidebar chip counts live mid-run without clients refetching the agent
	// list. Set after the server exists (the summary is computed there); no
	// Manager is created until the first request/prefetch, so nothing races it.
	testReg.SetOnProgress(server.NotifyTestsProgress)

	// A working sandbox is load-bearing: without it agents would either fail to
	// launch or (worse) run with cow_paths silently degraded to read-only binds,
	// producing confusing EROFS build failures. Refuse to start rather than serve a
	// broken sandbox. An operator who deliberately needs a specific bwrap can point
	// HYDRA_BWRAP at it (which also skips the overlay-capability requirement).
	if ok, reason := sandbox.Available(); !ok {
		return nil, errtrace.Errorf("sandbox unavailable: %s", reason)
	}

	// Archived agents (killed/merged heads) are kept indefinitely so they stay
	// browsable in the history list - we no longer prune soft-deleted rows on
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
		// Tests reuse the same slot-pool machinery, so wipe any test checkouts a
		// crash mid-run left behind, the same way as for artifacts above.
		if _, err := os.Stat(paths.GetTestsDirFromProjectRoot(root)); err == nil {
			testReg.Manager(root).CleanCheckouts()
		}
	}

	// Immediate first poller cycles before accepting requests.
	for _, root := range roots() {
		heads.ReconcileLivenessOnce(reg, store, root, eventHub)
		heads.RunJSONStatusPollerOnce(store, root)
	}

	go heads.RunLivenessReconciler(ctx, reg, store, roots, eventHub)
	// On a head transitioning into a resting status (finished/waiting/needs_input)
	// the agent has stopped editing, so pre-generate its diff artifacts at once
	// rather than waiting for the periodic worktree-settle sweep below. Run in its
	// own goroutine so the 1s poller loop never blocks on the (git + build-kickoff)
	// work, and against the server-lifetime context so it dies on shutdown.
	go heads.RunJSONStatusPoller(ctx, store, roots, eventHub, func(projectRoot, headID string) {
		go server.PrefetchHeadNow(server.BackgroundCtx, projectRoot, headID)
	})
	go runStoragePruner(ctx, artifactReg, roots)
	// Proactively pre-generate artifacts for settled heads so they're ready
	// before a user clicks in, instead of starting the work only on view.
	go server.RunArtifactPrefetcher(ctx, roots)
	// Likewise re-run heads' test suites in the background when their verdict goes
	// stale (a new commit landed), so the verdict is fresh before it's looked at.
	go server.RunTestPrefetcher(ctx, roots)
	// Watch heads with auto-merge armed and merge them once their tests pass.
	go server.RunAutoMergeWatcher(ctx)
	// Poll MR-linked heads: refresh cached MR state, detect remote merges (fetch +
	// ff local target + teardown), and auto-publish armed publish-when-green heads.
	go server.RunReviewWatcher(ctx)
	// Perform commits for heads whose git_isolation locks .git refs (the in-sandbox
	// git_commit tool can't update a ref, so it hands the commit to the daemon).
	go server.RunCommitWatcher(ctx, roots)
	// Mirror git_isolation=clone heads' branches from their standalone repos back
	// into the main repo, so their commits appear in diffs/tests/merge.
	go server.RunCloneMirrorWatcher(ctx, roots)

	// Register each project's [[services]]. Done after the pollers so a slow
	// service launch never delays request serving; StopAll on shutdown. Whether a
	// project's services launch now is gated on it having agents (a project with
	// none boots paused); the reconciler below flips them as agents come and go.
	for _, root := range roots() {
		svcMgr.StartProject(root)
	}
	go svcMgr.RunActivityGate(ctx)

	// Remote-access auth: loopback (and the unix control socket) are always
	// trusted; a configured key gates every non-localhost request. The key lives
	// in the boot project's .hydra/deploy.toml (uncommitted). A single daemon can
	// serve several projects on one TCP port, so the boot project's key is the
	// one that applies to the web UI.
	deployCfg, err := config.LoadDeploy(projectRoot)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	auth := httppkg.NewAuthenticator(deployCfg.AuthKey)
	if auth.Enabled() {
		log.Printf("Auth: non-localhost requests require the key in %s", paths.GetDeployConfigPath(projectRoot))
	}

	// Live server previews ([[artifacts]] type = "server"): each instance's
	// proxy listener binds the same host as the web UI (resolveWebAddr), so
	// previews are exposed exactly when the UI is - localhost by default,
	// every interface only under an explicit exposed deploy - and every
	// proxied request runs through the same auth gate (the hydra_auth cookie
	// is host-scoped, so one UI login covers the preview ports too).
	previewBindHost := "127.0.0.1"
	if addr, err := resolveWebAddr(deployCfg); err == nil {
		if h, _, err := net.SplitHostPort(addr); err == nil && h != "" {
			previewBindHost = h
		}
	}
	previewMgr := preview.NewManager(previewBindHost, auth)
	server.Previews = previewMgr
	go previewMgr.Run(ctx)

	mux := buildMux(server, auth)
	return &daemonRuntime{
		server:      server,
		handler:     httppkg.LoggingMiddleware(auth.Middleware(mux)),
		store:       store,
		reg:         reg,
		services:    svcMgr,
		previews:    previewMgr,
		projectRoot: projectRoot,
		deploy:      deployCfg,
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

// buildMux wires the API, websocket terminal, and frontend routes. The
// authenticator registers its own /api/auth/* endpoints (login/status/logout),
// which are exempt from the auth gate so a remote browser can reach them.
func buildMux(server *httppkg.Server, auth *httppkg.Authenticator) *http.ServeMux {
	mux := http.NewServeMux()
	auth.RegisterRoutes(mux)
	apiHandler := httppkg.RequestBodyLimitMiddleware(10 * 1024 * 1024)(httppkg.NewHandler(server))
	mux.Handle("/api/", apiHandler)
	mux.Handle("/health", apiHandler)
	mux.HandleFunc("/ws/projects/{project_id}/agents/{id}/terminal", server.HandleTerminalWS)
	mux.HandleFunc("/ws/projects/{project_id}/agents/{id}/artifacts", server.HandleArtifactsWS)
	mux.HandleFunc("/ws/projects/{project_id}/agents/{id}/tests", server.HandleTestsWS)
	mux.HandleFunc("/ws/projects/{project_id}/events", server.HandleEventsWS)
	mux.HandleFunc("POST /shells/projects/{project_id}/agents/{id}/close", server.HandleShellClose)
	mux.HandleFunc("/artifacts/projects/{project_id}/blob", server.HandleArtifactBlob)
	mux.HandleFunc("/artifacts/projects/{project_id}/log", server.HandleArtifactLog)
	mux.HandleFunc("/tests/projects/{project_id}/log", server.HandleTestLog)
	mux.HandleFunc("/repository/projects/{project_id}/blob", server.HandleRepositoryBlob)
	mux.HandleFunc("/repository/projects/{project_id}/agents/{id}/blob", server.HandleAgentBlob)
	mux.HandleFunc("GET /project-icon/projects/{project_id}", server.HandleProjectIcon)
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

// resumeVerifyGrace is how long resumeHeadsOnBoot waits after launching a
// resume before checking whether the agent's process actually came up. A resume
// can launch a process that dies immediately (e.g. claude --continue with no
// resumable conversation); its read loop may never observe the PTY close,
// leaving a stale "running" session that pins the head. The grace lets a healthy
// resume start its turn before we judge a silent one dead.
const resumeVerifyGrace = 3 * time.Second

// resumeHeadsOnBoot restarts agents that the DB marks as running but have no
// live session (e.g. after a daemon restart), via each agent's own --resume.
func resumeHeadsOnBoot(reg *session.Registry, store *db.Store, projectRoot string) {
	hs, err := heads.ListHeads(context.Background(), reg, store, projectRoot)
	if err != nil {
		log.Printf("warn: resume on boot: list heads: %v", err)
		return
	}
	var resumed []string
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
		// default - otherwise the agent repaints at 80 cols and that wrapped output
		// is baked into the scrollback before the first client ever attaches.
		rows, cols := heads.LoadResumeSize(store, projectRoot, h.ID)
		if err := heads.ResumeHead(reg, store, projectRoot, h, rows, cols); err != nil {
			log.Printf("warn: resume head %s: %v", h.ID, err)
			errMsg := err.Error()
			_ = store.ClearHeadStatus(h.ID, &errMsg)
			_ = store.UpdateSessionInfo(h.ID, 0, "stopped")
			continue
		}
		resumed = append(resumed, h.ID)
	}

	// Fail-fast on resumes that launched but died immediately. The liveness
	// reconciler would eventually reap these, but verifying here marks them
	// stopped promptly (and logs why) instead of leaving them stuck "running"
	// until the next reconcile tick. Async so a slow grace never delays boot.
	if len(resumed) > 0 {
		go func(ids []string) {
			time.Sleep(resumeVerifyGrace)
			for _, id := range ids {
				if reg.ReapDead(id) {
					log.Printf("daemon: resumed head %s exited immediately; marking stopped", id)
					errMsg := "resumed session exited immediately"
					_ = store.ClearHeadStatus(id, &errMsg)
					_ = store.UpdateSessionInfo(id, 0, "stopped")
				}
			}
		}(resumed)
	}
}
