package heads

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log"
	"os"
	"os/user"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"braces.dev/errtrace"
	dockerclient "github.com/docker/docker/client"
	gogit "github.com/go-git/go-git/v5"
	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/common"
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
			// Only include agents matching current project (platform-appropriate comparison)
			if paths.ComparePaths(a.Meta.ProjectPath, projectRoot) {
				dockerByID[a.Meta.Id] = a
			}
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
	ID                   string           // empty = auto-generated
	PrePrompt            string           // pre-prompt
	Prompt               string           // prompt
	AgentType            docker.AgentType // empty = "claude"
	BaseBranch           string           // empty = current HEAD branch
	DockerfilePath       string           // optional custom Dockerfile path
	DockerfileContents   string           // optional custom Dockerfile contents
	DockerignoreContents string           // optional custom .dockerignore contents
	SharedMounts         []string         // optional container paths to share
	Ephemeral            bool             // if true, container is auto-removed
}

// SpawnHead creates a new git worktree, branch, and Docker container for an agent.
// Returns the newly created Head.
func SpawnHead(ctx context.Context, cli *dockerclient.Client, store *db.Store, projectRoot string, opts SpawnHeadOptions) (*Head, error) {
	norm, err := paths.NormalizePath(projectRoot)
	if err == nil {
		projectRoot = norm
	}

	log.Printf("heads: spawning agent %q (type=%v, project=%q, ephemeral=%v)", opts.ID, opts.AgentType, projectRoot, opts.Ephemeral)

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
	worktreePath := paths.GetWorktreeDirFromProjectRoot(projectRoot, opts.ID)
	if opts.Ephemeral {
		branchName = baseBranch
		worktreePath = projectRoot
	}

	// Substitute branch placeholders in the pre-prompt now that we know the branch names.
	opts.PrePrompt = strings.NewReplacer(
		"<branch>", branchName,
		"<base-branch>", baseBranch,
	).Replace(opts.PrePrompt)

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
		if !opts.Ephemeral {
			_ = git.RemoveWorktree(projectRoot, worktreePath)
			_ = git.DeleteBranch(projectRoot, branchName)
		}
		if store != nil {
			_ = store.SoftDeleteAgent(opts.ID)
		}
		RemoveAgentStatusFiles(projectRoot, opts.ID)
		return nil, errtrace.Wrap(fmt.Errorf("get current user: %w", err))
	}
	uid, gid, username, groupName := common.ContainerUserInfo(currentUser)

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

	// Launch background spawn. Use a detached context so the spawn is not
	// cancelled when the HTTP request context ends, but cap it so a stalled
	// Docker build cannot run forever.
	go func() {
		bgCtx, cancel := context.WithTimeout(context.Background(), 2*time.Hour)
		defer cancel()

		if store != nil {
			if err := store.UpdateContainerInfo(opts.ID, "", "building"); err != nil {
				log.Printf("warn: update container status to building for %s: %v", opts.ID, err)
			}
		}

		buildLogPath := paths.GetBuildLogFromProjectRoot(projectRoot, opts.ID)
		if err := os.MkdirAll(filepath.Dir(buildLogPath), 0755); err != nil {
			log.Printf("warn: failed to create build log directory: %v", err)
		}
		buildLogFile, err := os.Create(buildLogPath)
		if err != nil {
			log.Printf("warn: failed to create build log file %s: %v", buildLogPath, err)
		} else {
			defer buildLogFile.Close()
		}

		containerID, err := docker.SpawnAgent(bgCtx, cli, docker.SpawnOptions{
			Id:                   opts.ID,
			AgentType:            opts.AgentType,
			DockerfilePath:       opts.DockerfilePath,
			DockerfileContents:   opts.DockerfileContents,
			DockerignoreContents: opts.DockerignoreContents,
			SharedMounts:         opts.SharedMounts,
			PrePrompt:            opts.PrePrompt,
			Prompt:               opts.Prompt,
			ProjectPath:          projectRoot,
			WorktreePath:         worktreePath,
			BranchName:           branchName,
			BaseBranch:           baseBranch,
			GitAuthorName:        gitAuthorName,
			GitAuthorEmail:       gitAuthorEmail,
			UID:                  uid,
			GID:                  gid,
			Username:             username,
			GroupName:            groupName,
			Ephemeral:            opts.Ephemeral,
			BuildLog:             buildLogFile,
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
			if buildLogFile != nil {
				fmt.Fprintf(buildLogFile, "\nerror: %v\n", err)
			}
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
			} else {
				log.Printf("heads: updated container info for %s: %s (starting)", opts.ID, containerID[:12])
			}
		}
	}()

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
	repo, err := gogit.PlainOpen(projectRoot)
	if err != nil {
		return ""
	}
	cfg, err := repo.Config()
	if err != nil {
		return ""
	}
	parts := strings.Split(key, ".")
	if len(parts) != 2 {
		return ""
	}
	section := cfg.Raw.Section(parts[0])
	if section == nil {
		return ""
	}
	return section.Option(parts[1])
}

// KillHead removes a Hydra head in safe order: container -> worktree -> branch.
// When store is non-nil, uses atomic CAS to prevent concurrent kill operations and soft-deletes the record.
func KillHead(ctx context.Context, cli *dockerclient.Client, store *db.Store, head Head) error {
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
	return errtrace.Wrap(KillHeadNoLock(ctx, cli, store, head))
}

// KillHeadNoLock performs the kill cleanup without acquiring the head_status lock.
// Used when the caller has already set head_status (e.g. merge sets it to "merging").
func KillHeadNoLock(ctx context.Context, cli *dockerclient.Client, store *db.Store, head Head) error {
	var killErr error

	containerRef := head.ContainerID
	if containerRef == "" {
		containerRef = "hydra-agent-" + head.ID
	}
	log.Printf("heads: killing container %q for agent %s", containerRef, head.ID)
	if err := docker.KillAgent(ctx, cli, containerRef); err != nil {
		log.Printf("warn: heads: kill container failed for %s: %v", head.ID, err)
		killErr = errtrace.Wrap(err)
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
