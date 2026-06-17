package heads

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log"
	"os"
	"os/user"
	"sort"
	"strings"
	"time"

	"braces.dev/errtrace"

	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/db"
	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/paths"
	"github.com/trolleyman/hydra/internal/sandbox"
	"github.com/trolleyman/hydra/internal/session"
)

// Head represents a Hydra agent unit: an ID with optional branch, worktree, and
// running sandbox session.
type Head struct {
	ID          string
	Title       string  // mutable, user-facing display name (empty falls back to ID)
	Branch      *string // "hydra/<id>", nil if the git branch does not exist
	Worktree    *string // path to the worktree directory, nil if it does not exist
	ProjectPath string
	// SessionPID is the running sandbox process PID (0 if not running);
	// SessionStatus is the session status (running|exited|stopped|...).
	SessionPID    int
	SessionStatus string
	AgentType     sandbox.AgentType
	PrePrompt     string
	Prompt        string
	BaseBranch    string
	Ephemeral     bool
	// AgentStatus holds the computed status for display.
	AgentStatus *api.AgentStatusInfo
	CreatedAt   int64 // Unix timestamp; 0 if not started
	// HasUnreadChanges drives the "unread changes" dot in the UI.
	HasUnreadChanges bool
}

// ListHeads returns all Hydra heads from the DB, cross-referenced with live
// session state from the registry (best-effort; nil registry is allowed).
func ListHeads(ctx context.Context, reg *session.Registry, store *db.Store, projectRoot string) ([]Head, error) {
	dbAgents, err := store.ListAgents(projectRoot)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}

	live := make(map[string]session.Info)
	if reg != nil {
		for _, info := range reg.Snapshot() {
			live[info.ID] = info
		}
	}

	result := make([]Head, 0, len(dbAgents))
	for _, a := range dbAgents {
		worktreePath := paths.GetWorktreeDirFromProjectRoot(projectRoot, a.ID)
		var worktree *string
		if _, err := os.Stat(worktreePath); err == nil {
			worktree = &worktreePath
		}

		var branch *string
		if a.BranchName != "" {
			b := a.BranchName
			branch = &b
		}

		sessionPID := a.SessionPID
		sessionStatus := a.SessionStatus
		if info, ok := live[a.ID]; ok {
			sessionPID = info.PID
			sessionStatus = sessionStatusToDB(info.Status)
		}

		h := Head{
			ID:            a.ID,
			Title:         a.Title,
			Branch:        branch,
			Worktree:      worktree,
			ProjectPath:   a.ProjectPath,
			SessionPID:    sessionPID,
			SessionStatus: sessionStatus,
			AgentType:     sandbox.AgentType(a.AgentType),
			PrePrompt:     a.PrePrompt,
			Prompt:        a.Prompt,
			BaseBranch:    a.BaseBranch,
			Ephemeral:     a.Ephemeral,
			CreatedAt:     a.CreatedAt.Unix(),
			AgentStatus:   computeAgentStatus(&a),
			HasUnreadChanges: a.HasUnreadChanges,
		}
		enrichAgentStatus(a.ProjectPath, a.ID, h.AgentStatus)
		result = append(result, h)
	}

	sort.Slice(result, func(i, j int) bool {
		if result[i].CreatedAt != result[j].CreatedAt {
			return result[i].CreatedAt > result[j].CreatedAt
		}
		return result[i].ID < result[j].ID
	})

	return result, nil
}

// sessionStatusToDB maps a session status to the DB session_status string.
func sessionStatusToDB(s session.Status) string {
	switch s {
	case session.StatusRunning, session.StatusStarting:
		return "running"
	default:
		return "stopped"
	}
}

// computeAgentStatus derives the single API-facing status from the three DB status fields.
func computeAgentStatus(a *db.Agent) *api.AgentStatusInfo {
	now := time.Now().Format(time.RFC3339Nano)
	event := "polling"

	var status api.AgentStatus
	switch {
	case a.HeadStatus != "idle":
		status = api.AgentStatus(a.HeadStatus)
	case a.SessionStatus == "running":
		if a.AgentStatus != nil {
			status = api.AgentStatus(*a.AgentStatus)
		} else {
			status = api.Starting
		}
	default:
		status = api.AgentStatus(a.SessionStatus)
	}

	ts := now
	if a.AgentStatusTime != "" {
		ts = a.AgentStatusTime
	}

	return &api.AgentStatusInfo{
		Status:    status,
		Event:     &event,
		Timestamp: ts,
	}
}

// GetHeadByID returns the head with the given ID, or nil if not found.
func GetHeadByID(ctx context.Context, reg *session.Registry, store *db.Store, projectRoot, id string) (*Head, error) {
	hs, err := ListHeads(ctx, reg, store, projectRoot)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	for _, h := range hs {
		if h.ID == id {
			return &h, nil
		}
	}
	return nil, nil
}

// SpawnHeadOptions holds parameters for spawning a new agent head.
type SpawnHeadOptions struct {
	ID         string            // empty = auto-generated
	PrePrompt  string            // pre-prompt
	Prompt     string            // prompt
	AgentType  sandbox.AgentType // empty = "claude"
	BaseBranch string            // empty = current HEAD branch
	Ephemeral  bool              // if true, a throwaway test agent: torn down on close, not resumed or listed by default
	Resume     bool              // if true, resume the agent's prior conversation
	Rows       uint16
	Cols       uint16
	// BackgroundCtx is the server-lifetime context for detached best-effort work
	// kicked off by the spawn (currently the async title-refinement claude call),
	// so that work is cancelled on shutdown rather than orphaning a child process.
	// It must NOT be the request context (which ends when the spawn handler
	// returns). nil falls back to context.Background().
	BackgroundCtx context.Context
}

// SpawnHead creates a new git worktree, branch, and sandbox session for an agent.
// Returns the newly created Head.
func SpawnHead(ctx context.Context, reg *session.Registry, store *db.Store, projectRoot string, opts SpawnHeadOptions) (*Head, error) {
	norm, err := paths.NormalizePath(projectRoot)
	if err == nil {
		projectRoot = norm
	}

	log.Printf("heads: spawning agent %q (type=%v, project=%q, ephemeral=%v)", opts.ID, opts.AgentType, projectRoot, opts.Ephemeral)

	if opts.AgentType == "" {
		opts.AgentType = sandbox.AgentTypeClaude
	}
	if opts.ID == "" {
		b := make([]byte, 4)
		if _, err := rand.Read(b); err != nil {
			return nil, errtrace.Wrap(fmt.Errorf("generate id: %w", err))
		}
		opts.ID = hex.EncodeToString(b)
	}

	baseBranch := opts.BaseBranch
	if baseBranch == "" {
		var err error
		baseBranch, err = git.GetCurrentBranch(projectRoot)
		if err != nil {
			return nil, errtrace.Wrap(fmt.Errorf("detect current branch: %w", err))
		}
	}

	// Even ephemeral (test) agents get a real throwaway worktree + branch so the
	// sandbox — and especially the pre-spawn script — runs against the same layout
	// a real agent sees: HYDRA_WORKTREE distinct from HYDRA_PROJECT_ROOT, never the
	// project root itself. The worktree/branch are torn down when the test closes.
	branchName := "hydra/" + opts.ID
	worktreePath := paths.GetWorktreeDirFromProjectRoot(projectRoot, opts.ID)

	opts.PrePrompt = strings.NewReplacer(
		"<branch>", branchName,
		"<base-branch>", baseBranch,
	).Replace(opts.PrePrompt)

	now := time.Now()

	// Seed the user-facing title from the prompt immediately; an optional
	// best-effort LLM pass (below) may refine it once the agent is up.
	title := DeriveTitle(opts.Prompt)

	if store != nil {
		agent := &db.Agent{
			ID:            opts.ID,
			ProjectPath:   projectRoot,
			BranchName:    branchName,
			BaseBranch:    baseBranch,
			AgentType:     string(opts.AgentType),
			PrePrompt:     opts.PrePrompt,
			Prompt:        opts.Prompt,
			Title:         title,
			Ephemeral:     opts.Ephemeral,
			SessionStatus: "pending",
			HeadStatus:    "idle",
			CreatedAt:     now,
		}
		if err := store.UpsertAgent(agent); err != nil {
			return nil, errtrace.Wrap(fmt.Errorf("upsert agent: %w", err))
		}
	}

	if err := git.CreateWorktree(projectRoot, worktreePath, branchName, baseBranch); err != nil {
		if store != nil {
			_ = store.SoftDeleteAgent(opts.ID)
		}
		RemoveAgentStatusFiles(projectRoot, opts.ID)
		return nil, errtrace.Wrap(err)
	}

	currentUser, err := user.Current()
	if err != nil {
		spawnCleanup(store, projectRoot, opts, worktreePath, branchName)
		return nil, errtrace.Wrap(fmt.Errorf("get current user: %w", err))
	}
	home := currentUser.HomeDir
	username := currentUser.Username

	gitAuthorName := readGitConfigVal(projectRoot, "user.name")
	gitAuthorEmail := readGitConfigVal(projectRoot, "user.email")

	e := "polling"
	initialStatus := &api.AgentStatusInfo{
		Status:    api.Pending,
		Event:     &e,
		Timestamp: now.Format(time.RFC3339Nano),
	}
	if err := WriteAgentStatus(projectRoot, opts.ID, initialStatus); err != nil {
		log.Printf("warn: write initial agent status: %v", err)
	}

	setStatus := func(status api.AgentStatus) {
		s := *initialStatus
		s.Status = status
		s.Timestamp = time.Now().Format(time.RFC3339Nano)
		if err := WriteAgentStatus(projectRoot, opts.ID, &s); err != nil {
			log.Printf("warn: update agent status to %s: %v", status, err)
		}
	}
	setStatus(api.Starting)

	// Build the sandbox launch options.
	cfg, _ := config.Load(projectRoot)
	writable, masked, restore, cowPaths, net, preSpawn := cfg.ResolveSandboxOptions(string(opts.AgentType))
	// Pre-spawn is a once-per-head hook: it runs only when a head is first
	// spawned, never on a resume (where the prior conversation is restored).
	if opts.Resume {
		preSpawn = ""
	}
	// COW mounts are re-applied on every launch (they are mount-time, not
	// persistent), with a per-head writable upper so the agent's overwrites
	// persist across resumes but never touch the real source.
	cowMounts := buildCowMounts(projectRoot, worktreePath, opts.ID, cowPaths, true)

	seed, err := seedHead(projectRoot, opts.ID, opts.AgentType, worktreePath, home, opts.PrePrompt)
	if err != nil {
		spawnFail(store, projectRoot, opts.ID, setStatus, fmt.Errorf("seed head: %w", err))
		return nil, errtrace.Wrap(err)
	}

	argv, err := sandbox.AgentArgv(opts.AgentType, opts.Resume, opts.PrePrompt, opts.Prompt)
	if err != nil {
		spawnFail(store, projectRoot, opts.ID, setStatus, err)
		return nil, errtrace.Wrap(err)
	}

	env := append(agentEnv(home, username, gitAuthorName, gitAuthorEmail), seed.Env...)
	env = append(env, sandbox.MiseTrustEnv(projectRoot, worktreePath)...)
	env = append(env, headContextEnv(opts.ID, opts.AgentType, projectRoot, worktreePath, branchName, baseBranch)...)

	sess, err := reg.Start(session.StartOptions{
		ID:   opts.ID,
		Rows: opts.Rows,
		Cols: opts.Cols,
		Sandbox: sandbox.Options{
			AgentType:      opts.AgentType,
			WorktreePath:   worktreePath,
			GitCommonDir:   gitCommonDir(projectRoot),
			Home:           home,
			WritablePaths:  append(writable, seed.WritablePaths...),
			MaskedPaths:    masked,
			RestoreRO:      restore,
			Network:        net,
			Binds:          seed.Binds,
			CowMounts:      cowMounts,
			Env:            env,
			Argv:           argv,
			PreSpawnScript: preSpawn,
			HardenGUI:      true,
			Seccomp:        true,
		},
	})
	if err != nil {
		spawnFail(store, projectRoot, opts.ID, setStatus, fmt.Errorf("start session: %w", err))
		return nil, errtrace.Wrap(err)
	}

	pid := sess.PID()
	if store != nil {
		if err := store.UpdateSessionInfo(opts.ID, pid, "running"); err != nil {
			log.Printf("warn: update session status to running for %s: %v", opts.ID, err)
		}
	}
	if opts.AgentType == sandbox.AgentTypeBash || opts.AgentType == sandbox.AgentTypeCopilot {
		setStatus(api.Running)
	}

	// Best-effort: refine the prompt-derived title via a cheap one-shot LLM call
	// in the background. Skipped for resumes (title already set) and ephemeral
	// test agents (never displayed). The next agent-list poll surfaces the result.
	if !opts.Resume && !opts.Ephemeral {
		bgCtx := opts.BackgroundCtx
		if bgCtx == nil {
			bgCtx = context.Background()
		}
		generateTitleAsync(bgCtx, store, opts.ID, opts.Prompt)
	}

	return &Head{
		ID:            opts.ID,
		Title:         title,
		Branch:        &branchName,
		Worktree:      &worktreePath,
		ProjectPath:   projectRoot,
		SessionPID:    pid,
		SessionStatus: "running",
		AgentType:     opts.AgentType,
		PrePrompt:     opts.PrePrompt,
		Prompt:        opts.Prompt,
		BaseBranch:    baseBranch,
		Ephemeral:     opts.Ephemeral,
		AgentStatus:   initialStatus,
		CreatedAt:     now.Unix(),
	}, nil
}

// spawnCleanup tears down a partially-created head after an early failure.
func spawnCleanup(store *db.Store, projectRoot string, opts SpawnHeadOptions, worktreePath, branchName string) {
	_ = git.RemoveWorktree(projectRoot, worktreePath)
	_ = git.DeleteBranch(projectRoot, branchName)
	if store != nil {
		_ = store.SoftDeleteAgent(opts.ID)
	}
	RemoveAgentStatusFiles(projectRoot, opts.ID)
	removeCowDir(projectRoot, opts.ID)
}

// spawnFail records a spawn failure in the status file + DB.
func spawnFail(store *db.Store, projectRoot, id string, setStatus func(api.AgentStatus), cause error) {
	log.Printf("error: spawn agent %s: %v", id, cause)
	setStatus(api.Stopped)
	if store != nil {
		if err := store.UpdateSessionInfo(id, 0, "stopped"); err != nil {
			log.Printf("warn: update session status to stopped for %s: %v", id, err)
		}
	}
}

// gitCommonDir resolves the repo's shared git dir for the sandbox to bind
// writable, so the agent can commit from its worktree. Non-fatal: logs and
// returns "" on failure (commits would then fail, but the spawn proceeds).
func gitCommonDir(projectRoot string) string {
	dir, err := git.GetCommonDir(projectRoot)
	if err != nil {
		log.Printf("warn: resolve git common dir for %s: %v", projectRoot, err)
		return ""
	}
	return dir
}

// ShellSessionID derives the registry session ID for a head's web bash shell
// from its head ID, sandbox mode and per-tab token. The same inputs always yield
// the same ID, so a tab's reconnect reattaches and an explicit close can target
// it. Mirrors the `<head>-shell[-host][-<token>]` shape KillMatching tears down.
func ShellSessionID(headID string, sandboxed bool, token string) string {
	id := headID + "-shell"
	if !sandboxed {
		id += "-host"
	}
	if tok := sanitizeShellToken(token); tok != "" {
		id += "-" + tok
	}
	return id
}

// KillShellSession terminates a single web bash shell immediately (used when the
// user closes its terminal tab, rather than waiting out the idle grace period).
// Best-effort: a no-op if the session is already gone.
func KillShellSession(reg *session.Registry, headID string, sandboxed bool, token string) {
	id := ShellSessionID(headID, sandboxed, token)
	_ = reg.Kill(id)
	reg.Remove(id)
}

// sanitizeShellToken reduces a client-supplied terminal-tab token to a safe
// session-ID suffix: alphanumerics, '-' and '_' only, capped in length. The
// token becomes part of a session ID and seed directory name, so anything else
// (path separators, '..') is dropped to prevent traversal.
func sanitizeShellToken(token string) string {
	var b strings.Builder
	for _, r := range token {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_' {
			b.WriteRune(r)
		}
		if b.Len() >= 64 {
			break
		}
	}
	return b.String()
}

// StartShellSession opens an interactive bash session sharing the head's
// worktree. When sandboxed is true the shell runs inside the same OS sandbox as
// the agent; when false it runs directly on the host with no confinement (an
// explicit user opt-in).
//
// token uniquely identifies a terminal tab so each opened shell gets its own
// independent process (rather than all tabs sharing one), and is stable across a
// tab's reconnects (a refresh reattaches to the same shell). Shells are started
// ephemeral: closing the tab terminates the process after a short grace period.
func StartShellSession(reg *session.Registry, projectRoot string, head Head, rows, cols uint16, sandboxed bool, token string) (string, error) {
	shellID := ShellSessionID(head.ID, sandboxed, token)
	if reg.IsLive(shellID) {
		return shellID, nil
	}

	worktreePath := projectRoot
	if head.Worktree != nil {
		worktreePath = *head.Worktree
	}

	currentUser, err := user.Current()
	if err != nil {
		return "", errtrace.Wrap(fmt.Errorf("get current user: %w", err))
	}
	home := currentUser.HomeDir
	env := agentEnv(home, currentUser.Username, readGitConfigVal(projectRoot, "user.name"), readGitConfigVal(projectRoot, "user.email"))
	env = append(env, sandbox.MiseTrustEnv(projectRoot, worktreePath)...)
	// The shell shares the head's worktree; report it as a bash session since
	// the pre-spawn config it runs is the bash agent's.
	env = append(env, headContextEnv(head.ID, sandbox.AgentTypeBash, projectRoot, worktreePath, derefStr(head.Branch), head.BaseBranch)...)

	var sb sandbox.Options
	if sandboxed {
		cfg, _ := config.Load(projectRoot)
		// The pre-spawn script is intentionally NOT run for bash shells: it is a
		// once-per-head agent-spawn hook, and these interactive shells open
		// repeatedly over a head's life. Running it here also made a failing
		// script (e.g. a bashism error) abort the shell before /bin/bash ever
		// exec'd, closing the terminal instantly.
		writable, masked, restore, cowPaths, net, _ := cfg.ResolveSandboxOptions("bash")
		// Bash is an interactive shell, not an agent — no system prompt to inject.
		seed, err := seedHead(projectRoot, shellID, sandbox.AgentTypeBash, worktreePath, home, "")
		if err != nil {
			return "", errtrace.Wrap(err)
		}
		// Expose the head's COW sources read-only here: this shell shares the
		// head's worktree, and a live agent may already own a writable overlay on
		// the same upperdir — two overlays must never share one, so the shell only
		// gets to read.
		cowMounts := buildCowMounts(projectRoot, worktreePath, head.ID, cowPaths, false)
		sb = sandbox.Options{
			AgentType:     sandbox.AgentTypeBash,
			WorktreePath:  worktreePath,
			GitCommonDir:  gitCommonDir(projectRoot),
			Home:          home,
			WritablePaths: append(writable, seed.WritablePaths...),
			MaskedPaths:   masked,
			RestoreRO:     restore,
			Network:       net,
			Binds:         seed.Binds,
			CowMounts:     cowMounts,
			Env:           append(env, seed.Env...),
			Argv:          []string{"/bin/bash"},
			HardenGUI:     true,
			Seccomp:       true,
		}
	} else {
		// Regular shell: plain host bash in the worktree, no confinement.
		sb = sandbox.Options{
			AgentType:    sandbox.AgentTypeBash,
			WorktreePath: worktreePath,
			Home:         home,
			Env:          env,
			Argv:         []string{"/bin/bash"},
			NoSandbox:    true,
		}
	}

	if _, err = reg.Start(session.StartOptions{ID: shellID, Rows: rows, Cols: cols, Sandbox: sb, Ephemeral: true}); err != nil {
		return "", errtrace.Wrap(err)
	}
	return shellID, nil
}

// ResumeHead starts a new sandbox session for an existing head (worktree and
// branch already exist), running the agent's own --resume flow. Used by the TUI
// and by the daemon to restore heads after a restart.
func ResumeHead(reg *session.Registry, store *db.Store, projectRoot string, head Head, rows, cols uint16) error {
	worktreePath := projectRoot
	if head.Worktree != nil {
		worktreePath = *head.Worktree
	}

	currentUser, err := user.Current()
	if err != nil {
		return errtrace.Wrap(fmt.Errorf("get current user: %w", err))
	}
	home := currentUser.HomeDir

	cfg, _ := config.Load(projectRoot)
	// Pre-spawn runs once, at the head's initial spawn — not on resume (the agent
	// is being restored, not freshly created), so the returned script is ignored.
	writable, masked, restore, cowPaths, net, _ := cfg.ResolveSandboxOptions(string(head.AgentType))
	seed, err := seedHead(projectRoot, head.ID, head.AgentType, worktreePath, home, head.PrePrompt)
	if err != nil {
		return errtrace.Wrap(err)
	}
	// Re-apply the writable COW mounts; the per-head upper persists the agent's
	// earlier overwrites across this resume.
	cowMounts := buildCowMounts(projectRoot, worktreePath, head.ID, cowPaths, true)
	argv, err := sandbox.AgentArgv(head.AgentType, true, head.PrePrompt, "")
	if err != nil {
		return errtrace.Wrap(err)
	}

	env := append(agentEnv(home, currentUser.Username, readGitConfigVal(projectRoot, "user.name"), readGitConfigVal(projectRoot, "user.email")), seed.Env...)
	env = append(env, sandbox.MiseTrustEnv(projectRoot, worktreePath)...)
	env = append(env, headContextEnv(head.ID, head.AgentType, projectRoot, worktreePath, derefStr(head.Branch), head.BaseBranch)...)

	sess, err := reg.Start(session.StartOptions{
		ID:   head.ID,
		Rows: rows,
		Cols: cols,
		Sandbox: sandbox.Options{
			AgentType:     head.AgentType,
			WorktreePath:  worktreePath,
			GitCommonDir:  gitCommonDir(projectRoot),
			Home:          home,
			WritablePaths: append(writable, seed.WritablePaths...),
			MaskedPaths:   masked,
			RestoreRO:     restore,
			Network:       net,
			Binds:         seed.Binds,
			CowMounts:     cowMounts,
			Env:           env,
			Argv:          argv,
			HardenGUI:     true,
			Seccomp:       true,
		},
	})
	if err != nil {
		return errtrace.Wrap(err)
	}
	// A resumed agent restores its prior conversation and then sits idle waiting
	// for the user — it is not actively working. Report it as waiting rather than
	// letting it inherit a stale "running"/"finished" (or the "stopped" left by a
	// daemon restart): mark it waiting in both status.json and the DB so the
	// displayed status is correct immediately, instead of after the next JSON poll,
	// and the two stay consistent. Claude's own SessionStart hook (source="resume")
	// reports the same once it fires; doing it here also covers agents (e.g. Gemini)
	// whose resume hook carries no resume signal.
	ts := time.Now().Format(time.RFC3339Nano)
	event := "resume"
	waiting := &api.AgentStatusInfo{Status: api.Waiting, Event: &event, Timestamp: ts}
	if err := WriteAgentStatus(projectRoot, head.ID, waiting); err != nil {
		log.Printf("warn: write resume status for %s: %v", head.ID, err)
	}
	if store != nil {
		_ = store.UpdateSessionInfo(head.ID, sess.PID(), "running")
		if err := store.UpdateAgentStatus(head.ID, "waiting", ts, false); err != nil {
			log.Printf("warn: update resume agent status for %s: %v", head.ID, err)
		}
	}
	return nil
}

// KillHead removes a Hydra head in safe order: session -> worktree -> branch.
// When store is non-nil, uses atomic CAS to prevent concurrent kill operations and soft-deletes the record.
func KillHead(ctx context.Context, reg *session.Registry, store *db.Store, head Head) error {
	log.Printf("heads: kill requested for agent %s", head.ID)
	if store != nil {
		ok, err := store.TrySetHeadStatus(head.ID, "idle", "killing")
		if err != nil {
			return errtrace.Wrap(err)
		}
		if !ok {
			log.Printf("heads: kill already in progress for agent %s", head.ID)
			return errtrace.Wrap(db.ErrOperationInProgress)
		}
	}
	return errtrace.Wrap(KillHeadNoLock(ctx, reg, store, head))
}

// KillHeadNoLock performs the kill cleanup without acquiring the head_status lock.
func KillHeadNoLock(ctx context.Context, reg *session.Registry, store *db.Store, head Head) error {
	var killErr error

	if reg != nil {
		log.Printf("heads: killing session for agent %s", head.ID)
		if err := reg.Kill(head.ID); err != nil {
			log.Printf("warn: heads: kill session failed for %s: %v", head.ID, err)
			killErr = errtrace.Wrap(err)
		}
		reg.Remove(head.ID)
		// Tear down any web bash shells for this head — they share its worktree,
		// which is about to be removed, so they must not outlive it.
		reg.KillMatching(head.ID + "-shell")
	}

	if killErr == nil {
		if head.Worktree != nil && head.ProjectPath != "" {
			log.Printf("heads: removing worktree %s for agent %s", *head.Worktree, head.ID)
			if err := git.RemoveWorktree(head.ProjectPath, *head.Worktree); err != nil {
				log.Printf("warn: heads: remove worktree %s failed for %s: %v", *head.Worktree, head.ID, err)
			}
		}

		if head.Branch != nil && head.ProjectPath != "" {
			if strings.HasPrefix(*head.Branch, "hydra/") {
				log.Printf("heads: deleting branch %s for agent %s", *head.Branch, head.ID)
				if err := git.DeleteBranch(head.ProjectPath, *head.Branch); err != nil {
					log.Printf("warn: heads: delete branch %s failed for %s: %v", *head.Branch, head.ID, err)
				}
			} else {
				log.Printf("heads: skipping branch deletion for %s (not a hydra branch)", *head.Branch)
			}
		}

		RemoveAgentStatusFiles(head.ProjectPath, head.ID)
		removeCowDir(head.ProjectPath, head.ID)
	}

	if store != nil {
		if killErr != nil {
			errMsg := killErr.Error()
			_ = store.ClearHeadStatus(head.ID, &errMsg)
		} else {
			log.Printf("heads: soft-deleting agent %s from database", head.ID)
			_ = store.SoftDeleteAgent(head.ID)
		}
	}

	log.Printf("heads: kill complete for agent %s", head.ID)
	return errtrace.Wrap(killErr)
}
