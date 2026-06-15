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
	"strconv"
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
	Branch      *string // "hydra/<id>", nil if the git branch does not exist
	Worktree    *string // path to the worktree directory, nil if it does not exist
	ProjectPath string
	// ContainerID / ContainerStatus retain their names for API compatibility but
	// now describe the sandbox session: ContainerID holds the process PID (as a
	// string), ContainerStatus the session status (running|exited|stopped|...).
	ContainerID     string
	ContainerStatus string
	AgentType       sandbox.AgentType
	PrePrompt       string
	Prompt          string
	BaseBranch      string
	Ephemeral       bool
	// AgentStatus holds the computed status for display.
	AgentStatus *api.AgentStatusInfo
	CreatedAt   int64 // Unix timestamp; 0 if not started
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

		containerID := a.ContainerID
		containerStatus := a.ContainerStatus
		if info, ok := live[a.ID]; ok {
			containerID = strconv.Itoa(info.PID)
			containerStatus = sessionStatusToDB(info.Status)
		}

		h := Head{
			ID:              a.ID,
			Branch:          branch,
			Worktree:        worktree,
			ProjectPath:     a.ProjectPath,
			ContainerID:     containerID,
			ContainerStatus: containerStatus,
			AgentType:       sandbox.AgentType(a.AgentType),
			PrePrompt:       a.PrePrompt,
			Prompt:          a.Prompt,
			BaseBranch:      a.BaseBranch,
			Ephemeral:       a.Ephemeral,
			CreatedAt:       a.CreatedAt.Unix(),
			AgentStatus:     computeAgentStatus(&a),
		}
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

// sessionStatusToDB maps a session status to the DB container_status string.
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
	now := time.Now().Format(time.RFC3339)
	event := "polling"

	var status api.AgentStatus
	switch {
	case a.HeadStatus != "idle":
		status = api.AgentStatus(a.HeadStatus)
	case a.ContainerStatus == "running":
		if a.AgentStatus != nil {
			status = api.AgentStatus(*a.AgentStatus)
		} else {
			status = api.Starting
		}
	default:
		status = api.AgentStatus(a.ContainerStatus)
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
	Ephemeral  bool              // if true, runs in the project root, no worktree/branch
	Resume     bool              // if true, resume the agent's prior conversation
	Rows       uint16
	Cols       uint16
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

	branchName := "hydra/" + opts.ID
	worktreePath := paths.GetWorktreeDirFromProjectRoot(projectRoot, opts.ID)
	if opts.Ephemeral {
		branchName = baseBranch
		worktreePath = projectRoot
	}

	opts.PrePrompt = strings.NewReplacer(
		"<branch>", branchName,
		"<base-branch>", baseBranch,
	).Replace(opts.PrePrompt)

	now := time.Now()

	if store != nil {
		agent := &db.Agent{
			ID:              opts.ID,
			ProjectPath:     projectRoot,
			ContainerName:   "hydra-agent-" + opts.ID,
			BranchName:      branchName,
			BaseBranch:      baseBranch,
			AgentType:       string(opts.AgentType),
			PrePrompt:       opts.PrePrompt,
			Prompt:          opts.Prompt,
			Ephemeral:       opts.Ephemeral,
			ContainerStatus: "pending",
			HeadStatus:      "idle",
			CreatedAt:       now,
		}
		if err := store.UpsertAgent(agent); err != nil {
			return nil, errtrace.Wrap(fmt.Errorf("upsert agent: %w", err))
		}
	}

	if !opts.Ephemeral {
		if err := git.CreateWorktree(projectRoot, worktreePath, branchName, baseBranch); err != nil {
			if store != nil {
				_ = store.SoftDeleteAgent(opts.ID)
			}
			RemoveAgentStatusFiles(projectRoot, opts.ID)
			return nil, errtrace.Wrap(err)
		}
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
		Timestamp: now.Format(time.RFC3339),
	}
	if err := WriteAgentStatus(projectRoot, opts.ID, initialStatus); err != nil {
		log.Printf("warn: write initial agent status: %v", err)
	}

	setStatus := func(status api.AgentStatus) {
		s := *initialStatus
		s.Status = status
		s.Timestamp = time.Now().Format(time.RFC3339)
		if err := WriteAgentStatus(projectRoot, opts.ID, &s); err != nil {
			log.Printf("warn: update agent status to %s: %v", status, err)
		}
	}
	setStatus(api.Starting)

	// Build the sandbox launch options.
	cfg, _ := config.Load(projectRoot)
	writable, masked, restore, net := cfg.ResolveSandboxOptions(string(opts.AgentType))

	binds, tmpfsDirs, err := seedHead(projectRoot, opts.ID, opts.AgentType, worktreePath, home)
	if err != nil {
		spawnFail(store, projectRoot, opts.ID, setStatus, fmt.Errorf("seed head: %w", err))
		return nil, errtrace.Wrap(err)
	}

	argv, err := sandbox.AgentArgv(opts.AgentType, opts.Resume, sandbox.CombinePrompt(opts.PrePrompt, opts.Prompt))
	if err != nil {
		spawnFail(store, projectRoot, opts.ID, setStatus, err)
		return nil, errtrace.Wrap(err)
	}

	sess, err := reg.Start(session.StartOptions{
		ID:   opts.ID,
		Rows: opts.Rows,
		Cols: opts.Cols,
		Sandbox: sandbox.Options{
			AgentType:     opts.AgentType,
			WorktreePath:  worktreePath,
			Home:          home,
			WritablePaths: writable,
			MaskedPaths:   masked,
			RestoreRO:     restore,
			Network:       net,
			Binds:         binds,
			TmpfsDirs:     tmpfsDirs,
			Env:           agentEnv(home, username, gitAuthorName, gitAuthorEmail),
			Argv:          argv,
			HardenGUI:     true,
			Seccomp:       true,
		},
	})
	if err != nil {
		spawnFail(store, projectRoot, opts.ID, setStatus, fmt.Errorf("start session: %w", err))
		return nil, errtrace.Wrap(err)
	}

	pid := strconv.Itoa(sess.PID())
	if store != nil {
		if err := store.UpdateContainerInfo(opts.ID, pid, "running"); err != nil {
			log.Printf("warn: update container status to running for %s: %v", opts.ID, err)
		}
	}
	if opts.AgentType == sandbox.AgentTypeBash || opts.AgentType == sandbox.AgentTypeCopilot {
		setStatus(api.Running)
	}

	var hBranch *string
	var hWorktree *string
	if !opts.Ephemeral {
		hBranch = &branchName
		hWorktree = &worktreePath
	}

	return &Head{
		ID:              opts.ID,
		Branch:          hBranch,
		Worktree:        hWorktree,
		ProjectPath:     projectRoot,
		ContainerID:     pid,
		ContainerStatus: "running",
		AgentType:       opts.AgentType,
		PrePrompt:       opts.PrePrompt,
		Prompt:          opts.Prompt,
		BaseBranch:      baseBranch,
		Ephemeral:       opts.Ephemeral,
		AgentStatus:     initialStatus,
		CreatedAt:       now.Unix(),
	}, nil
}

// spawnCleanup tears down a partially-created head after an early failure.
func spawnCleanup(store *db.Store, projectRoot string, opts SpawnHeadOptions, worktreePath, branchName string) {
	if !opts.Ephemeral {
		_ = git.RemoveWorktree(projectRoot, worktreePath)
		_ = git.DeleteBranch(projectRoot, branchName)
	}
	if store != nil {
		_ = store.SoftDeleteAgent(opts.ID)
	}
	RemoveAgentStatusFiles(projectRoot, opts.ID)
}

// spawnFail records a spawn failure in the status file + DB.
func spawnFail(store *db.Store, projectRoot, id string, setStatus func(api.AgentStatus), cause error) {
	log.Printf("error: spawn agent %s: %v", id, cause)
	setStatus(api.Stopped)
	if store != nil {
		if err := store.UpdateContainerInfo(id, "", "stopped"); err != nil {
			log.Printf("warn: update container status to stopped for %s: %v", id, err)
		}
	}
}

// StartShellSession starts (or returns the existing) transient sandboxed bash
// session sharing the head's worktree, used by the web terminal's shell tab.
// Returns the session ID to attach to.
func StartShellSession(reg *session.Registry, projectRoot string, head Head, rows, cols uint16) (string, error) {
	shellID := head.ID + "-shell"
	if _, ok := reg.Get(shellID); ok {
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

	cfg, _ := config.Load(projectRoot)
	writable, masked, restore, net := cfg.ResolveSandboxOptions("bash")
	binds, tmpfsDirs, err := seedHead(projectRoot, shellID, sandbox.AgentTypeBash, worktreePath, home)
	if err != nil {
		return "", errtrace.Wrap(err)
	}

	_, err = reg.Start(session.StartOptions{
		ID:   shellID,
		Rows: rows,
		Cols: cols,
		Sandbox: sandbox.Options{
			AgentType:     sandbox.AgentTypeBash,
			WorktreePath:  worktreePath,
			Home:          home,
			WritablePaths: writable,
			MaskedPaths:   masked,
			RestoreRO:     restore,
			Network:       net,
			Binds:         binds,
			TmpfsDirs:     tmpfsDirs,
			Env:           agentEnv(home, currentUser.Username, readGitConfigVal(projectRoot, "user.name"), readGitConfigVal(projectRoot, "user.email")),
			Argv:          []string{"/bin/bash"},
			HardenGUI:     true,
			Seccomp:       true,
		},
	})
	if err != nil {
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
	writable, masked, restore, net := cfg.ResolveSandboxOptions(string(head.AgentType))
	binds, tmpfsDirs, err := seedHead(projectRoot, head.ID, head.AgentType, worktreePath, home)
	if err != nil {
		return errtrace.Wrap(err)
	}
	argv, err := sandbox.AgentArgv(head.AgentType, true, "")
	if err != nil {
		return errtrace.Wrap(err)
	}

	sess, err := reg.Start(session.StartOptions{
		ID:   head.ID,
		Rows: rows,
		Cols: cols,
		Sandbox: sandbox.Options{
			AgentType:     head.AgentType,
			WorktreePath:  worktreePath,
			Home:          home,
			WritablePaths: writable,
			MaskedPaths:   masked,
			RestoreRO:     restore,
			Network:       net,
			Binds:         binds,
			TmpfsDirs:     tmpfsDirs,
			Env:           agentEnv(home, currentUser.Username, readGitConfigVal(projectRoot, "user.name"), readGitConfigVal(projectRoot, "user.email")),
			Argv:          argv,
			HardenGUI:     true,
			Seccomp:       true,
		},
	})
	if err != nil {
		return errtrace.Wrap(err)
	}
	if store != nil {
		_ = store.UpdateContainerInfo(head.ID, strconv.Itoa(sess.PID()), "running")
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
