package heads

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"braces.dev/errtrace"

	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/db"
	"github.com/trolleyman/hydra/internal/gate"
	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/nshost"
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
	// Archived is true for a finished (killed/merged) head retained in the
	// history list; such heads have no live session or worktree and are
	// read-only. EndState records how it ended ("killed" | "merged").
	Archived bool
	EndState string
	// MergeWhenGreen is true when auto-merge is armed for this head (PLAN #68).
	MergeWhenGreen bool
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
			ID:               a.ID,
			Title:            a.Title,
			Branch:           branch,
			Worktree:         worktree,
			ProjectPath:      a.ProjectPath,
			SessionPID:       sessionPID,
			SessionStatus:    sessionStatus,
			AgentType:        sandbox.AgentType(a.AgentType),
			PrePrompt:        a.PrePrompt,
			Prompt:           a.Prompt,
			BaseBranch:       a.BaseBranch,
			Ephemeral:        a.Ephemeral,
			CreatedAt:        a.CreatedAt.Unix(),
			AgentStatus:      computeAgentStatus(&a),
			HasUnreadChanges: a.HasUnreadChanges,
			MergeWhenGreen:   a.MergeWhenGreen,
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

// ResolveMergeDir returns a working directory in which target is checked out, so
// a merge can advance that branch. It is the mechanism behind merging a stacked
// agent into its base branch (which may be another agent's branch). Resolution:
//
//  1. If target is an agent branch hydra/<id> whose worktree exists and has that
//     branch checked out, use that worktree (the parent agent's checkout).
//  2. Else if target is the project root's current branch, use the project root
//     (the common case: merging into main).
//  3. Else create a throwaway worktree checked out on target, returned with a
//     cleanup that removes it. (Handles a base branch checked out nowhere.)
//
// cleanup is always non-nil and must be called by the caller (it is a no-op for
// cases 1 and 2).
func ResolveMergeDir(projectRoot, target string) (dir string, cleanup func(), err error) {
	noop := func() {}

	if strings.HasPrefix(target, "hydra/") {
		id := strings.TrimPrefix(target, "hydra/")
		wt := paths.GetWorktreeDirFromProjectRoot(projectRoot, id)
		if _, statErr := os.Stat(wt); statErr == nil {
			if cur, brErr := git.GetCurrentBranch(wt); brErr == nil && cur == target {
				return wt, noop, nil
			}
		}
	}

	if cur, brErr := git.GetCurrentBranch(projectRoot); brErr == nil && cur == target {
		return projectRoot, noop, nil
	}

	tmp, err := os.MkdirTemp("", "hydra-merge-")
	if err != nil {
		return "", noop, errtrace.Wrap(err)
	}
	if err := git.AddWorktreeForBranch(projectRoot, tmp, target); err != nil {
		_ = os.RemoveAll(tmp)
		return "", noop, errtrace.Wrap(err)
	}
	cleanup = func() {
		_ = git.RemoveWorktree(projectRoot, tmp)
		_ = os.RemoveAll(tmp)
	}
	return tmp, cleanup, nil
}

// ListArchivedHeads returns a page of archived (killed/merged) heads for the
// project, newest-archived first. limit <= 0 returns all; offset paginates.
// Archived heads carry no live session or worktree and are read-only.
func ListArchivedHeads(store *db.Store, projectRoot string, limit, offset int) ([]Head, error) {
	rows, err := store.ListArchivedAgents(projectRoot, limit, offset)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	result := make([]Head, 0, len(rows))
	for i := range rows {
		result = append(result, archivedHead(&rows[i]))
	}
	return result, nil
}

// GetArchivedHeadByID returns the archived head with the given ID, or nil if no
// such archived record exists.
func GetArchivedHeadByID(store *db.Store, id string) (*Head, error) {
	a, err := store.GetArchivedAgent(id)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	if a == nil {
		return nil, nil
	}
	h := archivedHead(a)
	return &h, nil
}

// archivedHead builds a read-only Head from an archived DB record. Its worktree
// and branch no longer exist on disk, so Worktree is nil; BranchName is kept for
// display only. The status reflects the last reported activity status (not the
// transient head_status left over from the kill/merge operation).
func archivedHead(a *db.Agent) Head {
	var branch *string
	if a.BranchName != "" {
		b := a.BranchName
		branch = &b
	}
	return Head{
		ID:          a.ID,
		Title:       a.Title,
		Branch:      branch,
		Worktree:    nil,
		ProjectPath: a.ProjectPath,
		AgentType:   sandbox.AgentType(a.AgentType),
		PrePrompt:   a.PrePrompt,
		Prompt:      a.Prompt,
		BaseBranch:  a.BaseBranch,
		Ephemeral:   a.Ephemeral,
		CreatedAt:   a.CreatedAt.Unix(),
		AgentStatus: archivedAgentStatus(a),
		Archived:    true,
		EndState:    a.EndState,
	}
}

// archivedAgentStatus derives the display status for an archived head from its
// last reported activity status, defaulting to stopped. (It deliberately ignores
// HeadStatus, which is left as "killing"/"merging" on the soft-deleted row.)
func archivedAgentStatus(a *db.Agent) *api.AgentStatusInfo {
	status := api.Stopped
	if a.AgentStatus != nil && *a.AgentStatus != "" {
		status = api.AgentStatus(*a.AgentStatus)
	}
	ts := a.AgentStatusTime
	if ts == "" {
		ts = a.UpdatedAt.Format(time.RFC3339Nano)
	}
	event := "archived"
	return &api.AgentStatusInfo{Status: status, Event: &event, Timestamp: ts}
}

// SpawnHeadOptions holds parameters for spawning a new agent head.
type SpawnHeadOptions struct {
	ID         string            // empty = auto-generated from the prompt, uniquified with a -2/-3... suffix
	PrePrompt  string            // pre-prompt
	Prompt     string            // prompt
	AgentType  sandbox.AgentType // empty = "claude"
	Model      string            // model alias for the CLI's --model flag; empty = CLI default
	BaseBranch string            // empty = current HEAD branch
	Ephemeral  bool              // if true, a throwaway test agent: torn down on close, not resumed or listed by default
	Resume     bool              // if true, resume the agent's prior conversation
	// Replace allows an explicit ID to take over an ARCHIVED head with the same
	// ID in the SAME project, overwriting its archived record (the restart and
	// `hydra spawn --force` paths). Without it any existing record - active or
	// archived, this project or another - fails the spawn with *HeadExistsError.
	Replace bool
	Rows    uint16
	Cols    uint16
	// BackgroundCtx is the server-lifetime context for detached best-effort work
	// kicked off by the spawn (currently the async title-refinement claude call),
	// so that work is cancelled on shutdown rather than orphaning a child process.
	// It must NOT be the request context (which ends when the spawn handler
	// returns). nil falls back to context.Background().
	BackgroundCtx context.Context
	// OnTitleChange, if set, is called after the async title refinement persists a
	// new title, so the caller can push an agents_changed event instead of waiting
	// for the next poll. Best-effort, runs on the title goroutine; nil = no-op.
	OnTitleChange func()
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
	// Resolve the head ID. Auto-generated IDs are derived from the prompt and
	// uniquified against the whole shared DB (IDs are a global primary key
	// across projects) plus this repo's branches/worktrees, so a repeated
	// prompt can never collide with an existing head. Explicit IDs are
	// validated and any collision is reported instead of silently overwriting
	// the existing record (which used to hijack same-ID heads from other
	// projects and resurrect archived ones).
	replacing := false
	if opts.ID == "" {
		opts.ID = pickUniqueHeadID(store, projectRoot, opts.Prompt)
	} else {
		if err := ValidateHeadID(opts.ID); err != nil {
			return nil, errtrace.Wrap(err)
		}
		var existing *db.Agent
		if store != nil {
			var err error
			existing, err = store.GetAgentAny(opts.ID)
			if err != nil {
				return nil, errtrace.Wrap(fmt.Errorf("check existing agent: %w", err))
			}
		}
		if existing != nil {
			sameProject := existing.ProjectPath == projectRoot
			archived := existing.DeletedAt.Valid
			if !opts.Replace || !sameProject || !archived {
				return nil, errtrace.Wrap(&HeadExistsError{
					ID:          opts.ID,
					ProjectPath: existing.ProjectPath,
					SameProject: sameProject,
					Archived:    archived,
				})
			}
			replacing = true
		}
		if !replacing && (git.BranchExists(projectRoot, "hydra/"+opts.ID) || headWorktreeExists(projectRoot, opts.ID)) {
			return nil, errtrace.Wrap(&HeadExistsError{ID: opts.ID})
		}
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
	// sandbox - and especially the pre-spawn script - runs against the same layout
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
		if replacing {
			// Take over the archived same-project record (Replace path): the
			// unscoped save un-deletes and overwrites it.
			if err := store.UpsertAgent(agent); err != nil {
				return nil, errtrace.Wrap(fmt.Errorf("replace archived agent: %w", err))
			}
		} else if err := store.CreateAgent(agent); err != nil {
			if errors.Is(err, db.ErrAgentIDTaken) {
				// Race backstop: another spawn claimed the ID between the
				// uniqueness check and the insert.
				if existing, lookErr := store.GetAgentAny(opts.ID); lookErr == nil && existing != nil {
					return nil, errtrace.Wrap(&HeadExistsError{
						ID:          opts.ID,
						ProjectPath: existing.ProjectPath,
						SameProject: existing.ProjectPath == projectRoot,
						Archived:    existing.DeletedAt.Valid,
					})
				}
				return nil, errtrace.Wrap(&HeadExistsError{ID: opts.ID, ProjectPath: projectRoot, SameProject: true})
			}
			return nil, errtrace.Wrap(fmt.Errorf("create agent: %w", err))
		}
	}

	if err := git.CreateWorktree(projectRoot, worktreePath, branchName, baseBranch); err != nil {
		if store != nil {
			// Hard-delete: an aborted spawn never really existed, and a
			// soft-deleted tombstone would reserve the ID forever.
			_ = store.HardDeleteAgent(opts.ID)
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
	// Pre-spawn is per-launch sandbox setup, not a once-per-head constructor: it
	// runs on every agent launch - spawn and resume alike (see ResumeHead) - so a
	// configured script must be idempotent.
	// COW mounts are re-applied on every launch (they are mount-time, not
	// persistent), with a per-head writable upper so the agent's overwrites
	// persist across resumes but never touch the real source.
	cowMounts := buildCowMounts(projectRoot, worktreePath, opts.ID, cowPaths, true)

	seed, err := seedHead(projectRoot, opts.ID, opts.AgentType, worktreePath, home, opts.PrePrompt, resolveGatePolicy(cfg, string(opts.AgentType)))
	if err != nil {
		spawnFail(store, projectRoot, opts.ID, setStatus, fmt.Errorf("seed head: %w", err))
		return nil, errtrace.Wrap(err)
	}

	argv, err := sandbox.AgentArgv(opts.AgentType, opts.Resume, opts.PrePrompt, opts.Prompt, opts.Model)
	if err != nil {
		spawnFail(store, projectRoot, opts.ID, setStatus, err)
		return nil, errtrace.Wrap(err)
	}

	env := append(agentEnv(home, username, gitAuthorName, gitAuthorEmail), seed.Env...)
	env = append(env, sandbox.MiseTrustEnv(projectRoot, worktreePath)...)
	env = append(env, headContextEnv(opts.ID, opts.AgentType, projectRoot, worktreePath, branchName, baseBranch)...)
	env = append(env, claudeRenderingEnv(opts.AgentType, cfg.ResolveFullscreen(string(opts.AgentType)))...)
	// Filtering egress: when the head has a network allow-list, route its outbound
	// HTTP(S) through a per-head proxy that only relays allow-listed hosts (hard
	// netns+nft boundary when available, else advisory proxy env).
	egressEnv, egressWrap := startEgress(projectRoot, opts.ID, opts.AgentType, &net)
	env = append(env, egressEnv...)

	sess, err := startAgentSession(reg, projectRoot, opts.ID, opts.AgentType, worktreePath, opts.Rows, opts.Cols, sandbox.Options{
		AgentType:      opts.AgentType,
		WorktreePath:   worktreePath,
		GitCommonDir:   gitCommonDir(projectRoot),
		Home:           home,
		TmpDir:         ensureHeadTmpDir(projectRoot, opts.ID),
		WritablePaths:  append(writable, seed.WritablePaths...),
		MaskedPaths:    masked,
		RestoreRO:      restore,
		Network:        net,
		Binds:          seed.Binds,
		ROOverlays:     seed.ROOverlays,
		CowMounts:      cowMounts,
		Env:            env,
		Argv:           argv,
		PreSpawnScript: preSpawn,
		EgressWrap:     egressWrap,
		HardenGUI:      true,
		Seccomp:        true,
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
	if opts.AgentType == sandbox.AgentTypeBash || opts.AgentType == sandbox.AgentTypeCopilot || opts.AgentType == sandbox.AgentTypeCodex {
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
		generateTitleAsync(bgCtx, store, opts.ID, opts.Prompt, opts.OnTitleChange)
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
		// Hard-delete: an aborted spawn never really existed, and a soft-deleted
		// tombstone would reserve the ID forever.
		_ = store.HardDeleteAgent(opts.ID)
	}
	RemoveAgentStatusFiles(projectRoot, opts.ID)
	removeNamespaceHost(opts.ID)
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

// shellStartGate serializes concurrent StartShellSession calls for one shell ID.
// refs tracks the callers holding (or waiting on) it so the entry can be dropped
// once idle, keeping shellStartGates bounded rather than accumulating one mutex
// per distinct shell tab for the daemon's lifetime.
type shellStartGate struct {
	mu   sync.Mutex
	refs int
}

var shellStartGates = struct {
	mu sync.Mutex
	m  map[string]*shellStartGate
}{m: map[string]*shellStartGate{}}

// acquireShellStart returns the gate for a shell ID, registering a reference so a
// concurrent releaser does not delete it out from under this caller. The caller
// must Lock/Unlock the returned gate's mu and then call releaseShellStart.
func acquireShellStart(id string) *shellStartGate {
	shellStartGates.mu.Lock()
	defer shellStartGates.mu.Unlock()
	g, ok := shellStartGates.m[id]
	if !ok {
		g = &shellStartGate{}
		shellStartGates.m[id] = g
	}
	g.refs++
	return g
}

// releaseShellStart drops one reference to a shell ID's gate, removing it once no
// caller holds it.
func releaseShellStart(id string) {
	shellStartGates.mu.Lock()
	defer shellStartGates.mu.Unlock()
	if g, ok := shellStartGates.m[id]; ok {
		g.refs--
		if g.refs == 0 {
			delete(shellStartGates.m, id)
		}
	}
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

	// Serialize concurrent starts of the same shell. Two WebSocket connections for
	// one terminal tab can race here - e.g. a pane remounting on a fast navigate-
	// away-and-back opens a second socket (reusing the persisted tab id, hence the
	// same shell ID) before the first has registered its session. Without this the
	// loser's reg.Start finds the winner's freshly-registered session and returns
	// session.ErrExists ("session already exists"), which the terminal handler
	// shows the user as a fatal error; in the reserve/register gap both could even
	// launch a process, orphaning one. Holding the per-id gate and re-checking
	// IsLive makes the loser simply reattach to the shell the winner started.
	startGate := acquireShellStart(shellID)
	startGate.mu.Lock()
	defer func() {
		startGate.mu.Unlock()
		releaseShellStart(shellID)
	}()
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

	// If the head's agent is running inside a supervisor, spawn this bash terminal
	// as a sibling child of that one bwrap. It then shares the agent's single
	// writable COW overlay - the whole point of the namespace host - rather than
	// getting the COW sources read-only. When no supervisor is live (e.g. the agent
	// has not started yet), we fall through to a standalone read-only-COW sandbox.
	if sandboxed {
		if host, ok := namespaceHostFor(head.ID); ok {
			sp, err := host.client.Spawn(nshost.SpawnRequest{
				Argv: []string{"/bin/bash"},
				Env:  env,
				Cwd:  worktreePath,
				Rows: rows,
				Cols: cols,
			})
			if err != nil {
				return "", errtrace.Wrap(fmt.Errorf("spawn shell in namespace host: %w", err))
			}
			if _, err := reg.StartWithProc(shellID, sandbox.AgentTypeBash, worktreePath, rows, cols, true, sp); err != nil {
				return "", errtrace.Wrap(err)
			}
			return shellID, nil
		}
	}

	var sb sandbox.Options
	if sandboxed {
		cfg, _ := config.Load(projectRoot)
		// The pre-spawn script is intentionally NOT run for bash shells: it is a
		// once-per-head agent-spawn hook, and these interactive shells open
		// repeatedly over a head's life. Running it here also made a failing
		// script (e.g. a bashism error) abort the shell before /bin/bash ever
		// exec'd, closing the terminal instantly.
		writable, masked, restore, cowPaths, net, _ := cfg.ResolveSandboxOptions("bash")
		// Bash is an interactive shell, not an agent - no system prompt to inject,
		// and no PreToolUse gate (it has no hook system); the empty policy disables it.
		seed, err := seedHead(projectRoot, shellID, sandbox.AgentTypeBash, worktreePath, home, "", gate.Policy{})
		if err != nil {
			return "", errtrace.Wrap(err)
		}
		// Expose the head's COW sources read-only here: this shell shares the
		// head's worktree, and a live agent may already own a writable overlay on
		// the same upperdir - two overlays must never share one, so the shell only
		// gets to read.
		cowMounts := buildCowMounts(projectRoot, worktreePath, head.ID, cowPaths, false)
		sb = sandbox.Options{
			AgentType:     sandbox.AgentTypeBash,
			WorktreePath:  worktreePath,
			GitCommonDir:  gitCommonDir(projectRoot),
			Home:          home,
			TmpDir:        ensureHeadTmpDir(projectRoot, head.ID),
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
// RestartHead relaunches a live head in a fresh sandbox: it kills the current
// session, waits for it to exit, then resumes (re-seeding from the current
// config). Used after granting an MCP-server request so the newly allow-listed
// server - which MCP only loads at launch - becomes usable without the user
// manually resuming. The conversation is restored by the resume's --continue.
func RestartHead(reg *session.Registry, store *db.Store, projectRoot string, head Head, rows, cols uint16) error {
	if reg.IsLive(head.ID) {
		_ = reg.Kill(head.ID)
		// Wait for the session to actually exit before relaunching, so the fresh
		// session doesn't collide with the dying one in the registry.
		deadline := time.Now().Add(10 * time.Second)
		for reg.IsLive(head.ID) {
			if time.Now().After(deadline) {
				_ = reg.KillNow(head.ID)
				break
			}
			time.Sleep(100 * time.Millisecond)
		}
	}
	return errtrace.Wrap(ResumeHead(reg, store, projectRoot, head, rows, cols))
}

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
	// Capture the agent's last-known work status BEFORE the status writes below
	// overwrite it: a "Continue" nudge is sent only to an agent that was actively
	// working when it was cut off - never one that was idle waiting on the user
	// (e.g. an unanswered question) or already finished. Read it from the DB so
	// every resume path (boot, terminal attach, TUI) agrees on the same signal.
	priorStatus := ""
	if store != nil {
		if a, err := store.GetAgent(head.ID); err == nil && a != nil && a.AgentStatus != nil {
			priorStatus = *a.AgentStatus
		}
	}
	nudge := cfg.ResumeContinueMessage()
	willNudge := nudge != "" && shouldNudgeResumedAgent(priorStatus)
	// Pre-spawn is per-launch sandbox setup, so it runs on resume too: resume
	// re-launches the agent in a fresh sandbox, and re-running the script is the
	// only way a pre_spawn_script added (or changed) after a head was created ever
	// reaches that head. It must therefore be idempotent - it runs on every launch
	// - and, as on spawn, a non-zero exit gates the launch (here, aborts resume).
	writable, masked, restore, cowPaths, net, preSpawn := cfg.ResolveSandboxOptions(string(head.AgentType))
	seed, err := seedHead(projectRoot, head.ID, head.AgentType, worktreePath, home, head.PrePrompt, resolveGatePolicy(cfg, string(head.AgentType)))
	if err != nil {
		return errtrace.Wrap(err)
	}
	// Re-apply the writable COW mounts; the per-head upper persists the agent's
	// earlier overwrites across this resume.
	cowMounts := buildCowMounts(projectRoot, worktreePath, head.ID, cowPaths, true)
	// Resume passes no model: the agent restores the model its transcript was
	// saved with (and any in-session change), avoiding a cache-missing re-read.
	argv, err := sandbox.AgentArgv(head.AgentType, true, head.PrePrompt, "", "")
	if err != nil {
		return errtrace.Wrap(err)
	}

	env := append(agentEnv(home, currentUser.Username, readGitConfigVal(projectRoot, "user.name"), readGitConfigVal(projectRoot, "user.email")), seed.Env...)
	env = append(env, sandbox.MiseTrustEnv(projectRoot, worktreePath)...)
	env = append(env, headContextEnv(head.ID, head.AgentType, projectRoot, worktreePath, derefStr(head.Branch), head.BaseBranch)...)
	env = append(env, claudeRenderingEnv(head.AgentType, cfg.ResolveFullscreen(string(head.AgentType)))...)
	// Filtering egress (see SpawnHead): restart it fresh on resume.
	egressEnv, egressWrap := startEgress(projectRoot, head.ID, head.AgentType, &net)
	env = append(env, egressEnv...)

	sess, err := startAgentSession(reg, projectRoot, head.ID, head.AgentType, worktreePath, rows, cols, sandbox.Options{
		AgentType:      head.AgentType,
		WorktreePath:   worktreePath,
		GitCommonDir:   gitCommonDir(projectRoot),
		Home:           home,
		TmpDir:         ensureHeadTmpDir(projectRoot, head.ID),
		WritablePaths:  append(writable, seed.WritablePaths...),
		MaskedPaths:    masked,
		RestoreRO:      restore,
		Network:        net,
		Binds:          seed.Binds,
		ROOverlays:     seed.ROOverlays,
		CowMounts:      cowMounts,
		Env:            env,
		Argv:           argv,
		PreSpawnScript: preSpawn,
		EgressWrap:     egressWrap,
		HardenGUI:      true,
		Seccomp:        true,
	})
	if err != nil {
		return errtrace.Wrap(err)
	}
	// A resumed agent restores its prior conversation and then sits idle waiting
	// for the user - it is not actively working. Report it as waiting rather than
	// letting it inherit a stale "running" (or the "stopped" left by a daemon
	// restart): mark it in both status.json and the DB so the displayed status is
	// correct immediately, instead of after the next JSON poll, and the two stay
	// consistent. Claude's own SessionStart hook (source="resume") reports the same
	// once it fires; doing it here also covers agents (e.g. Gemini) whose resume
	// hook carries no resume signal.
	//
	// Exception: a head that had already *finished* its turn before the daemon
	// stopped hasn't started waiting on anything just by being resumed - forcing it
	// to "waiting" would spuriously revert a finished head to "waiting" on every
	// restart. Preserve its finished status instead. (A running head is nudged
	// below, which flips it back to running, so its momentary "waiting" is fine.)
	resumeStatus := api.Waiting
	if priorStatus == string(api.Finished) {
		resumeStatus = api.Finished
	}
	ts := time.Now().Format(time.RFC3339Nano)
	event := "resume"
	resumed := &api.AgentStatusInfo{Status: resumeStatus, Event: &event, Timestamp: ts}
	if err := WriteAgentStatus(projectRoot, head.ID, resumed); err != nil {
		log.Printf("warn: write resume status for %s: %v", head.ID, err)
	}
	if store != nil {
		_ = store.UpdateSessionInfo(head.ID, sess.PID(), "running")
		if err := store.UpdateAgentStatus(head.ID, string(resumeStatus), ts, false); err != nil {
			log.Printf("warn: update resume agent status for %s: %v", head.ID, err)
		}
	}
	if willNudge {
		// The agent restored its prior conversation but won't act on it on its
		// own, so type the nudge to make it continue. Done async because the TUI
		// can take a while to finish rendering a large restored conversation, and
		// ResumeHead must not block its callers (daemon boot, terminal attach).
		// The agent's own hooks flip its status back to running once the nudge
		// submits, so the "waiting" written above is only momentary.
		go nudgeResumedAgent(reg, head.ID, nudge)
	}
	return nil
}

// shouldNudgeResumedAgent reports whether a just-resumed agent should be sent a
// continue nudge, based on its work status at the moment it was cut off. Only an
// agent that was actively working ("running") is nudged; one that was waiting on
// the user, finished, or never reported a status is left alone.
func shouldNudgeResumedAgent(priorStatus string) bool {
	return priorStatus == string(api.Running)
}

// resumeNudgeTiming controls how nudgeResumedAgent waits for a resumed agent's
// TUI to be ready for input. Defaults are overridden in tests for speed.
type resumeNudgeTiming struct {
	// minDelay is the floor before the nudge may be sent, giving the agent's
	// input handler time to mount even if it renders nothing.
	minDelay time.Duration
	// quietFor is how long output must stay silent (after minDelay) before the
	// TUI is considered done rendering its restored conversation and idle.
	quietFor time.Duration
	// maxWait caps the total wait so a TUI that never goes quiet (e.g. an
	// animated status line) is still nudged eventually.
	maxWait time.Duration
	// enterDelay separates typing the message from pressing Enter, so the TUI
	// registers the text before it submits.
	enterDelay time.Duration
	// poll is the readiness-check interval.
	poll time.Duration
}

var defaultResumeNudge = resumeNudgeTiming{
	minDelay:   1500 * time.Millisecond,
	quietFor:   1200 * time.Millisecond,
	maxWait:    25 * time.Second,
	enterDelay: 400 * time.Millisecond,
	poll:       150 * time.Millisecond,
}

// nudgeResumedAgent waits for a resumed agent's TUI to settle, then types the
// given message followed by Enter into its PTY. Resume CLIs (claude --continue,
// gemini --resume) restore the conversation but won't auto-submit a prompt
// passed on the command line, so the only reliable way to make the agent
// continue is to inject keystrokes once it is interactive.
func nudgeResumedAgent(reg *session.Registry, id, message string) {
	nudgeResumedAgentWith(reg, id, message, defaultResumeNudge)
}

func nudgeResumedAgentWith(reg *session.Registry, id, message string, t resumeNudgeTiming) {
	att, err := reg.Attach(id, 0, 0)
	if err != nil {
		log.Printf("warn: resume nudge: attach %s: %v", id, err)
		return
	}
	defer att.Close()

	if !waitUntilQuiet(att, t) {
		// Session died before it was ready; nothing to nudge.
		return
	}

	// Type the message, then submit with a discrete carriage return. Sending the
	// text and Enter separately (rather than "message\r" in one write) avoids the
	// newline being absorbed into a bracketed paste, and gives the TUI a beat to
	// register the typed text before it submits.
	if err := reg.Write(id, []byte(message)); err != nil {
		log.Printf("warn: resume nudge: type into %s: %v", id, err)
		return
	}
	time.Sleep(t.enterDelay)
	if err := reg.Write(id, []byte("\r")); err != nil {
		log.Printf("warn: resume nudge: submit to %s: %v", id, err)
	}
}

// waitUntilQuiet blocks until the attached session's output has been silent for
// t.quietFor (after at least t.minDelay), or t.maxWait elapses. It returns false
// if the session exits first.
func waitUntilQuiet(att *session.Attachment, t resumeNudgeTiming) bool {
	start := time.Now()
	lastOutput := start
	ticker := time.NewTicker(t.poll)
	defer ticker.Stop()
	for {
		select {
		case <-att.Done:
			return false
		case _, ok := <-att.Output:
			if !ok {
				return false
			}
			lastOutput = time.Now()
		case <-ticker.C:
			now := time.Now()
			if now.Sub(start) >= t.maxWait {
				return true
			}
			if now.Sub(start) >= t.minDelay && now.Sub(lastOutput) >= t.quietFor {
				return true
			}
		}
	}
}

// KillHead removes a Hydra head in safe order: session -> worktree -> branch.
// When store is non-nil, uses atomic CAS to prevent concurrent kill operations
// and archives the record. endState records how it ended ("killed" | "merged",
// or "" to leave it out of the archived-history list, e.g. ephemeral cleanup).
func KillHead(ctx context.Context, reg *session.Registry, store *db.Store, head Head, endState string) error {
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
	return errtrace.Wrap(KillHeadNoLock(ctx, reg, store, head, endState))
}

// KillHeadNoLock performs the kill cleanup without acquiring the head_status
// lock. On success it archives the record with the given endState (see KillHead).
func KillHeadNoLock(ctx context.Context, reg *session.Registry, store *db.Store, head Head, endState string) error {
	var killErr error

	if reg != nil {
		log.Printf("heads: killing session for agent %s", head.ID)
		if err := reg.Kill(head.ID); err != nil {
			log.Printf("warn: heads: kill session failed for %s: %v", head.ID, err)
			killErr = errtrace.Wrap(err)
		}
		reg.Remove(head.ID)
		// Tear down the head's filtering egress proxy, if any.
		stopEgressProxy(head.ID)
		// Tear down any web bash shells for this head - they share its worktree,
		// which is about to be removed, so they must not outlive it.
		reg.KillMatching(head.ID + "-shell")
	}
	if killErr == nil {
		// Sandboxed teardown hook: the agent's session is dead but the worktree is
		// still present, so run the configured pre_exit_script (best-effort,
		// cwd=worktree) BEFORE the worktree is removed - e.g. to release a claimed
		// emulator slot from .hydra/emu.env. In shared-namespace mode this runs
		// inside the head's still-live supervisor (the same bwrap as the agent), so
		// it sees the agent's COW writes - which is why it must precede the
		// removeNamespaceHost teardown below.
		runPreExitScript(ctx, head, endState)
	}

	// Stop the shared-namespace supervisor (if any) - after the pre-exit hook, the
	// single bwrap owning the writable COW overlay is no longer needed. Unconditional
	// so a failed kill still reclaims it.
	removeNamespaceHost(head.ID)

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
		removeHeadTmpDir(head.ProjectPath, head.ID)
	}

	if store != nil {
		if killErr != nil {
			errMsg := killErr.Error()
			_ = store.ClearHeadStatus(head.ID, &errMsg)
		} else {
			log.Printf("heads: archiving agent %s (end_state=%q)", head.ID, endState)
			_ = store.ArchiveAgent(head.ID, endState)
		}
	}

	log.Printf("heads: kill complete for agent %s", head.ID)
	return errtrace.Wrap(killErr)
}

// preExitTimeout bounds how long a pre_exit_script may run before it is killed,
// so a hung teardown hook can't wedge a kill/merge request.
const preExitTimeout = 30 * time.Second

// runPreExitScript runs the project's configured pre_exit_script for a head that
// is ending, in a fresh SANDBOX with the head's sandbox policy, with the worktree
// as the working directory - called after the agent's session is killed but
// before the worktree is removed. It is best-effort: any failure is logged, never
// returned. The script receives the same HYDRA_* head-context variables as the
// agent, plus HYDRA_END_STATE ("killed"|"merged"|""). endState mirrors
// KillHeadNoLock's argument. Being sandboxed, it can touch the worktree (e.g.
// .hydra/emu.env) but not host-only resources.
func runPreExitScript(ctx context.Context, head Head, endState string) {
	if head.ProjectPath == "" || head.Worktree == nil {
		return
	}
	worktree := *head.Worktree
	cfg, err := config.Load(head.ProjectPath)
	if err != nil {
		log.Printf("warn: pre_exit_script: load config for %s: %v", head.ID, err)
		return
	}
	script := cfg.ResolvePreExitScript(string(head.AgentType))
	if strings.TrimSpace(script) == "" {
		return
	}

	currentUser, err := user.Current()
	if err != nil {
		log.Printf("warn: pre_exit_script for %s: current user: %v", head.ID, err)
		return
	}
	home := currentUser.HomeDir

	if ctx == nil {
		ctx = context.Background()
	}
	runCtx, cancel := context.WithTimeout(ctx, preExitTimeout)
	defer cancel()

	writable, masked, restore, _, net, _ := cfg.ResolveSandboxOptions(string(head.AgentType))
	env := append(agentEnv(home, currentUser.Username, readGitConfigVal(head.ProjectPath, "user.name"), readGitConfigVal(head.ProjectPath, "user.email")), sandbox.MiseTrustEnv(head.ProjectPath, worktree)...)
	env = append(env, headContextEnv(head.ID, head.AgentType, head.ProjectPath, worktree, derefStr(head.Branch), head.BaseBranch)...)
	env = append(env, "HYDRA_END_STATE="+endState)

	// Run the hook inside the head's live supervisor so it executes in the SAME
	// bwrap as the agent - sharing the writable COW overlay and seeing the agent's
	// writes - rather than in a fresh sandbox. Falls through to the standalone
	// sandbox below when there is no namespace host for this head.
	if host, ok := namespaceHostFor(head.ID); ok {
		log.Printf("heads: running pre_exit_script for agent %s in namespace host (end_state=%q)", head.ID, endState)
		out, err := runPreExitInNamespace(runCtx, host, worktree, env, script)
		if err != nil {
			log.Printf("warn: pre_exit_script for %s failed: %v; output:\n%s", head.ID, err, bytes.TrimSpace(out))
		} else if trimmed := bytes.TrimSpace(out); len(trimmed) > 0 {
			log.Printf("heads: pre_exit_script for %s output:\n%s", head.ID, trimmed)
		}
		return
	}

	spec, err := sandbox.BuildSpec(sandbox.Options{
		AgentType:     sandbox.AgentTypeBash,
		WorktreePath:  worktree,
		GitCommonDir:  gitCommonDir(head.ProjectPath),
		Home:          home,
		TmpDir:        ensureHeadTmpDir(head.ProjectPath, head.ID),
		WritablePaths: writable,
		MaskedPaths:   masked,
		RestoreRO:     restore,
		Network:       net,
		Env:           env,
		Argv:          []string{"bash", "-c", sandbox.StrictScript(script)},
		HardenGUI:     true,
		Seccomp:       true,
	})
	if err != nil {
		log.Printf("warn: pre_exit_script for %s: build sandbox: %v", head.ID, err)
		return
	}
	defer spec.Cleanup()

	log.Printf("heads: running pre_exit_script for agent %s (end_state=%q)", head.ID, endState)
	cmd := exec.CommandContext(runCtx, spec.Path, spec.Args[1:]...)
	cmd.Dir = spec.Dir
	cmd.Env = spec.Env
	cmd.ExtraFiles = spec.ExtraFiles
	out, err := cmd.CombinedOutput()
	if err != nil {
		log.Printf("warn: pre_exit_script for %s failed: %v; output:\n%s", head.ID, err, bytes.TrimSpace(out))
		return
	}
	if trimmed := bytes.TrimSpace(out); len(trimmed) > 0 {
		log.Printf("heads: pre_exit_script for %s output:\n%s", head.ID, trimmed)
	}
}

// PurgeHead permanently and irreversibly deletes a head, leaving no trace. Unlike
// KillHead (which soft-deletes the record into the browsable archived-history
// list), PurgeHead: stops any live session, removes the worktree/branch and the
// on-disk status/cow files, deletes the agent's Claude session-history directory
// under ~/.claude/projects, and HARD-deletes the database row.
//
// It works on both live and already-archived heads (an archived head's session,
// worktree and branch are already gone, so those steps are no-ops). Per-step
// cleanup failures are logged but do not abort the purge - the aim is to remove
// as much as possible - except a failure to hard-delete the DB row, which is
// returned so the caller knows the record still exists.
func PurgeHead(ctx context.Context, reg *session.Registry, store *db.Store, head Head) error {
	log.Printf("heads: permanent delete requested for agent %s", head.ID)

	if reg != nil {
		if err := reg.Kill(head.ID); err != nil {
			log.Printf("warn: heads: purge kill session failed for %s: %v", head.ID, err)
		}
		reg.Remove(head.ID)
		stopEgressProxy(head.ID)
		reg.KillMatching(head.ID + "-shell")
	}

	if head.Worktree != nil && head.ProjectPath != "" {
		if err := git.RemoveWorktree(head.ProjectPath, *head.Worktree); err != nil {
			log.Printf("warn: heads: purge remove worktree %s failed for %s: %v", *head.Worktree, head.ID, err)
		}
	}

	if head.Branch != nil && head.ProjectPath != "" && strings.HasPrefix(*head.Branch, "hydra/") {
		if err := git.DeleteBranch(head.ProjectPath, *head.Branch); err != nil {
			// Expected to fail for archived heads (branch already deleted on kill).
			log.Printf("heads: purge delete branch %s for %s: %v", *head.Branch, head.ID, err)
		}
	}

	if head.ProjectPath != "" {
		RemoveAgentStatusFiles(head.ProjectPath, head.ID)
		removeCowDir(head.ProjectPath, head.ID)
		removeClaudeSessionDir(head)
	}

	if store == nil {
		return nil
	}
	if err := store.HardDeleteAgent(head.ID); err != nil {
		return errtrace.Wrap(err)
	}
	log.Printf("heads: permanent delete complete for agent %s", head.ID)
	return nil
}

// removeClaudeSessionDir deletes the agent's Claude Code session-history
// directory. Claude derives it from the working directory (the head's worktree)
// by replacing every non-alphanumeric character with '-', stored under
// ~/.claude/projects/<slug>. Only Claude agents have one; other agent types are a
// no-op (see the "delete for real" feature note). Best-effort - a missing dir or
// any error is logged and ignored.
func removeClaudeSessionDir(head Head) {
	if head.AgentType != sandbox.AgentTypeClaude {
		return
	}
	u, err := user.Current()
	if err != nil || u.HomeDir == "" {
		log.Printf("warn: heads: purge cannot resolve home for %s: %v", head.ID, err)
		return
	}
	// Archived heads carry no live Worktree, so recompute the deterministic path
	// Claude saw as its cwd: <project>/.hydra/local/worktrees/<id>.
	worktree := paths.GetWorktreeDirFromProjectRoot(head.ProjectPath, head.ID)
	slug := paths.ClaudeProjectsSlug(worktree)
	if slug == "" {
		return
	}
	dir := filepath.Join(u.HomeDir, ".claude", "projects", slug)
	if err := os.RemoveAll(dir); err != nil {
		log.Printf("warn: heads: purge remove claude session dir %s for %s: %v", dir, head.ID, err)
	} else {
		log.Printf("heads: purge removed claude session dir %s for agent %s", dir, head.ID)
	}
}
