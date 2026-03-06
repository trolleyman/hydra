package heads

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log"
	"os"
	"os/exec"
	"os/user"
	"sort"
	"strconv"
	"strings"
	"time"

	"braces.dev/errtrace"
	dockerclient "github.com/docker/docker/client"
	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/db"
	"github.com/trolleyman/hydra/internal/docker"
	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/paths"
)

// Head represents a Hydra agent unit: an ID with optional branch, worktree, and container.
type Head struct {
	ID              string
	Branch          *string // "hydra/<id>", nil if the git branch does not exist
	Worktree        *string // path to the worktree directory, nil if it does not exist
	ProjectPath     string
	ContainerID     string
	ContainerStatus string
	AgentType       docker.AgentType
	PrePrompt       string
	Prompt          string
	BaseBranch      string
	Ephemeral       bool
	// AgentStatus holds the computed status for display.
	AgentStatus *api.AgentStatusInfo
	CreatedAt   int64 // Unix timestamp from container creation; 0 if no container
}

// ListHeads returns all Hydra heads from the DB, cross-referenced with live Docker state.
func ListHeads(ctx context.Context, cli *dockerclient.Client, store *db.Store, projectRoot string) ([]Head, error) {
	dbAgents, err := store.ListAgents(projectRoot)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}

	// Get live Docker state for confirmation (best-effort).
	dockerAgents, dockerErr := docker.ListAgents(ctx, cli)
	dockerByID := make(map[string]docker.Agent)
	if dockerErr != nil {
		log.Printf("warn: list docker agents: %v", dockerErr)
	} else {
		for _, a := range dockerAgents {
			dockerByID[a.Meta.Id] = a
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

		// Use live Docker container ID if available, else DB value.
		containerID := a.ContainerID
		if da, ok := dockerByID[a.ID]; ok && da.ContainerID != "" {
			containerID = da.ContainerID
		}

		h := Head{
			ID:              a.ID,
			Branch:          branch,
			Worktree:        worktree,
			ProjectPath:     a.ProjectPath,
			ContainerID:     containerID,
			ContainerStatus: a.ContainerStatus,
			AgentType:       docker.AgentType(a.AgentType),
			PrePrompt:       a.PrePrompt,
			Prompt:          a.Prompt,
			BaseBranch:      a.BaseBranch,
			Ephemeral:       a.Ephemeral,
			CreatedAt:       a.CreatedAt.Unix(),
			AgentStatus:     computeAgentStatus(&a),
		}
		result = append(result, h)
	}

	// Sort: newest first, ID as tiebreaker.
	sort.Slice(result, func(i, j int) bool {
		if result[i].CreatedAt != result[j].CreatedAt {
			return result[i].CreatedAt > result[j].CreatedAt
		}
		return result[i].ID < result[j].ID
	})

	return result, nil
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
func GetHeadByID(ctx context.Context, cli *dockerclient.Client, store *db.Store, projectRoot, id string) (*Head, error) {
	hs, err := ListHeads(ctx, cli, store, projectRoot)
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
	ID                 string           // empty = auto-generated
	PrePrompt          string           // pre-prompt
	Prompt             string           // prompt
	AgentType          docker.AgentType // empty = "claude"
	BaseBranch         string           // empty = current HEAD branch
	DockerfilePath     string           // optional custom Dockerfile path
	DockerfileContents string           // optional custom Dockerfile contents
	Ephemeral          bool             // if true, container is auto-removed
}

// SpawnHead creates a new git worktree, branch, and Docker container for an agent.
// Returns the newly created Head.
func SpawnHead(ctx context.Context, cli *dockerclient.Client, store *db.Store, projectRoot string, opts SpawnHeadOptions) (*Head, error) {
	if opts.AgentType == "" {
		opts.AgentType = docker.AgentTypeClaude
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
	now := time.Now()

	// Write DB record first so the agent is visible immediately.
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

	worktreePath := paths.GetWorktreeDirFromProjectRoot(projectRoot, opts.ID)
	if err := git.CreateWorktree(projectRoot, worktreePath, branchName, baseBranch); err != nil {
		if store != nil {
			_ = store.SoftDeleteAgent(opts.ID)
		}
		return nil, errtrace.Wrap(err)
	}

	currentUser, err := user.Current()
	if err != nil {
		_ = git.RemoveWorktree(projectRoot, worktreePath)
		_ = git.DeleteBranch(projectRoot, branchName)
		if store != nil {
			_ = store.SoftDeleteAgent(opts.ID)
		}
		return nil, errtrace.Wrap(fmt.Errorf("get current user: %w", err))
	}
	uid, _ := strconv.Atoi(currentUser.Uid)
	gid, _ := strconv.Atoi(currentUser.Gid)
	groupName := currentUser.Username
	if grp, err := user.LookupGroupId(currentUser.Gid); err == nil {
		groupName = grp.Name
	}

	gitAuthorName := readGitConfigVal(projectRoot, "user.name")
	gitAuthorEmail := readGitConfigVal(projectRoot, "user.email")

	// If no dockerfile provided in opts, resolve it from config.
	if opts.DockerfilePath == "" {
		if cfg, cfgErr := config.Load(projectRoot); cfgErr == nil {
			resolved := cfg.GetResolvedConfig(string(opts.AgentType))
			if resolved.Dockerfile != nil {
				opts.DockerfilePath = *resolved.Dockerfile
			}
		}
	}

	// Write initial JSON status file for backward compatibility.
	e := "polling"
	initialStatus := &api.AgentStatusInfo{
		Status:    api.Pending,
		Event:     &e,
		Timestamp: now.Format(time.RFC3339),
	}
	if err := WriteAgentStatus(projectRoot, opts.ID, initialStatus); err != nil {
		log.Printf("warn: write initial agent status: %v", err)
	}

	// Launch background spawn.
	go func() {
		bgCtx := context.Background()

		if store != nil {
			if err := store.UpdateContainerInfo(opts.ID, "", "building"); err != nil {
				log.Printf("warn: update container status to building for %s: %v", opts.ID, err)
			}
		}

		containerID, err := docker.SpawnAgent(bgCtx, cli, docker.SpawnOptions{
			Id:                 opts.ID,
			AgentType:          opts.AgentType,
			DockerfilePath:     opts.DockerfilePath,
			DockerfileContents: opts.DockerfileContents,
			PrePrompt:          opts.PrePrompt,
			Prompt:             opts.Prompt,
			ProjectPath:        projectRoot,
			WorktreePath:       worktreePath,
			BranchName:         branchName,
			BaseBranch:         baseBranch,
			GitAuthorName:      gitAuthorName,
			GitAuthorEmail:     gitAuthorEmail,
			UID:                uid,
			GID:                gid,
			Username:           currentUser.Username,
			GroupName:          groupName,
			Ephemeral:          opts.Ephemeral,
			OnStatus: func(status api.AgentStatus) {
				s := initialStatus
				s.Status = status
				s.Timestamp = time.Now().Format(time.RFC3339)
				if err := WriteAgentStatus(projectRoot, opts.ID, s); err != nil {
					log.Printf("warn: update agent status to %s: %v", status, err)
				}
			},
		})
		if err != nil {
			log.Printf("error: background spawn agent %s: %v", opts.ID, err)
			s := initialStatus
			s.Status = api.Stopped
			e := "error"
			s.Event = &e
			s.Timestamp = time.Now().Format(time.RFC3339)
			_ = WriteAgentStatus(projectRoot, opts.ID, s)
			if store != nil {
				if err := store.UpdateContainerInfo(opts.ID, "", "stopped"); err != nil {
					log.Printf("warn: update container status to stopped for %s: %v", opts.ID, err)
				}
			}
			return
		}

		if store != nil {
			if err := store.UpdateContainerInfo(opts.ID, containerID, "starting"); err != nil {
				log.Printf("warn: update container status to starting for %s: %v", opts.ID, err)
			}
		}
	}()

	return &Head{
		ID:              opts.ID,
		Branch:          &branchName,
		Worktree:        &worktreePath,
		ProjectPath:     projectRoot,
		ContainerID:     "",
		ContainerStatus: "pending",
		AgentType:       opts.AgentType,
		PrePrompt:       opts.PrePrompt,
		Prompt:          opts.Prompt,
		BaseBranch:      baseBranch,
		Ephemeral:       opts.Ephemeral,
		AgentStatus:     initialStatus,
		CreatedAt:       now.Unix(),
	}, nil
}

// readGitConfigVal reads a single git config value.
func readGitConfigVal(projectRoot, key string) string {
	out, err := exec.Command("git", "-C", projectRoot, "config", key).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// KillHead removes a Hydra head in safe order: container -> worktree -> branch.
// When store is non-nil, uses atomic CAS to prevent concurrent kill operations and soft-deletes the record.
func KillHead(ctx context.Context, cli *dockerclient.Client, store *db.Store, head Head) error {
	if store != nil {
		ok, err := store.TrySetHeadStatus(head.ID, "idle", "killing")
		if err != nil {
			return errtrace.Wrap(err)
		}
		if !ok {
			return errtrace.Wrap(db.ErrOperationInProgress)
		}
	}
	return errtrace.Wrap(KillHeadNoLock(ctx, cli, store, head))
}

// KillHeadNoLock performs the kill cleanup without acquiring the head_status lock.
// Used when the caller has already set head_status (e.g. merge sets it to "merging").
func KillHeadNoLock(ctx context.Context, cli *dockerclient.Client, store *db.Store, head Head) error {
	var killErr error

	if head.ContainerID != "" {
		log.Printf("Killing head: %s in container %s", head.ID, head.ContainerID[:12])
		if err := docker.KillAgent(ctx, cli, head.ContainerID); err != nil {
			killErr = errtrace.Wrap(err)
		}
	}

	if killErr == nil {
		if head.Worktree != nil && head.ProjectPath != "" {
			if err := git.RemoveWorktree(head.ProjectPath, *head.Worktree); err != nil {
				log.Printf("warn: remove worktree %s: %v", *head.Worktree, err)
			}
		}

		if head.Branch != nil && head.ProjectPath != "" {
			if err := git.DeleteBranch(head.ProjectPath, *head.Branch); err != nil {
				log.Printf("warn: delete branch %s: %v", *head.Branch, err)
			}
		}

		statusJson := paths.GetStatusJsonFromProjectRoot(head.ProjectPath, head.ID)
		if _, err := os.Stat(statusJson); err == nil {
			if err := os.Remove(statusJson); err != nil {
				log.Printf("warn: remove status json %s: %v", statusJson, err)
			}
		}
	}

	if store != nil {
		if killErr != nil {
			errMsg := killErr.Error()
			_ = store.ClearHeadStatus(head.ID, &errMsg)
		} else {
			_ = store.SoftDeleteAgent(head.ID)
		}
	}

	return errtrace.Wrap(killErr)
}
