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
	"strconv"
	"strings"

	"braces.dev/errtrace"
	dockerclient "github.com/docker/docker/client"
	"github.com/trolleyman/hydra/internal/docker"
	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/paths"
)

// Head represents a Hydra agent unit: an ID with optional branch, worktree, and container.
type Head struct {
	ID              string
	BranchName      string // "hydra/<id>"
	HasBranch       bool
	WorktreePath    string
	HasWorktree     bool
	ProjectPath     string
	ContainerID     string
	ContainerStatus string
	AgentType       docker.AgentType
	PrePrompt       string
	Prompt          string
	BaseBranch      string
	// ClaudeStatus is read from .hydra-status.json in the worktree (nil if absent).
	ClaudeStatus *ClaudeStatus
}

// ListHeads returns all Hydra heads found via git branches and/or Docker containers.
// Git branches matching hydra/* are the primary source; containers without a corresponding
// branch are also included.
func ListHeads(ctx context.Context, cli *dockerclient.Client, projectRoot string) ([]Head, error) {
	byID := map[string]*Head{}

	// 1. Enumerate git branches matching hydra/*
	branches, err := git.ListHydraBranches(projectRoot)
	if err != nil {
		log.Printf("warn: list hydra branches: %v", err)
		branches = nil
	}
	for _, branch := range branches {
		id := strings.TrimPrefix(branch, "hydra/")
		worktreePath := paths.GetWorktreeDirFromProjectRoot(projectRoot, id)
		// fmt.Printf("%s: worktreeDir: %s, projectRoot: %s\n", id, worktreePath, projectRoot)
		_, statErr := os.Stat(worktreePath)
		head := &Head{
			ID:           id,
			BranchName:   branch,
			HasBranch:    true,
			WorktreePath: worktreePath,
			HasWorktree:  statErr == nil,
			ProjectPath:  projectRoot,
			ClaudeStatus: readClaudeStatus(worktreePath),
		}
		byID[id] = head
	}

	// 2. Enumerate Docker containers with the Hydra label
	agents, err := docker.ListAgents(ctx, cli)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	for _, a := range agents {
		id := a.Meta.Id
		if head, ok := byID[id]; ok {
			// Merge container info into existing head
			head.ContainerID = a.ContainerID
			head.ContainerStatus = a.Status
			head.AgentType = a.Meta.AgentType
			head.PrePrompt = a.Meta.PrePrompt
			head.Prompt = a.Meta.Prompt
			head.BaseBranch = a.Meta.BaseBranch
			if head.ProjectPath == "" {
				head.ProjectPath = a.Meta.ProjectPath
			}
		} else {
			// Container without a matching branch (orphaned)
			worktreePath := paths.GetWorktreeDirFromProjectRoot(a.Meta.ProjectPath, id)
			// fmt.Printf("%s: worktreeDir: %s, projectPath: %s\n", id, worktreePath, a.Meta.ProjectPath)
			_, statErr := os.Stat(worktreePath)
			byID[id] = &Head{
				ID:              id,
				BranchName:      "hydra/" + id,
				HasBranch:       false,
				WorktreePath:    worktreePath,
				HasWorktree:     statErr == nil,
				ProjectPath:     a.Meta.ProjectPath,
				ContainerID:     a.ContainerID,
				ContainerStatus: a.Status,
				AgentType:       a.Meta.AgentType,
				PrePrompt:       a.Meta.PrePrompt,
				Prompt:          a.Meta.Prompt,
				BaseBranch:      a.Meta.BaseBranch,
				ClaudeStatus:    readClaudeStatus(worktreePath),
			}
		}
	}

	// Collect into a slice; branch-backed heads first, then orphaned containers
	var result []Head
	for _, h := range byID {
		if h.HasBranch {
			result = append(result, *h)
		}
	}
	for _, h := range byID {
		if !h.HasBranch {
			result = append(result, *h)
		}
	}
	return result, nil
}

// GetHeadByID returns the head with the given ID.
func GetHeadByID(ctx context.Context, cli *dockerclient.Client, projectRoot, id string) (*Head, error) {
	hs, err := ListHeads(ctx, cli, projectRoot)
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
	ID         string           // empty = auto-generated
	PrePrompt  string           // pre-prompt
	Prompt     string           // prompt
	AgentType  docker.AgentType // empty = "claude"
	BaseBranch string           // empty = current HEAD branch
}

// SpawnHead creates a new git worktree, branch, and Docker container for an agent.
// Returns the newly created Head.
func SpawnHead(ctx context.Context, cli *dockerclient.Client, projectRoot string, opts SpawnHeadOptions) (*Head, error) {
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
	if err := git.CreateWorktree(projectRoot, worktreePath, branchName, baseBranch); err != nil {
		return nil, errtrace.Wrap(err)
	}

	currentUser, err := user.Current()
	if err != nil {
		_ = git.RemoveWorktree(projectRoot, worktreePath)
		_ = git.DeleteBranch(projectRoot, branchName)
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

	containerID, err := docker.SpawnAgent(ctx, cli, docker.SpawnOptions{
		Id:             opts.ID,
		AgentType:      opts.AgentType,
		PrePrompt:      opts.PrePrompt,
		Prompt:         opts.Prompt,
		ProjectPath:    projectRoot,
		WorktreePath:   worktreePath,
		BranchName:     branchName,
		BaseBranch:     baseBranch,
		GitAuthorName:  gitAuthorName,
		GitAuthorEmail: gitAuthorEmail,
		UID:            uid,
		GID:            gid,
		Username:       currentUser.Username,
		GroupName:      groupName,
	})
	if err != nil {
		_ = git.RemoveWorktree(projectRoot, worktreePath)
		_ = git.DeleteBranch(projectRoot, branchName)
		return nil, errtrace.Wrap(fmt.Errorf("spawn agent: %w", err))
	}

	return &Head{
		ID:              opts.ID,
		BranchName:      branchName,
		HasBranch:       true,
		WorktreePath:    worktreePath,
		HasWorktree:     true,
		ProjectPath:     projectRoot,
		ContainerID:     containerID,
		ContainerStatus: "created",
		AgentType:       opts.AgentType,
		PrePrompt:       opts.PrePrompt,
		Prompt:          opts.Prompt,
		BaseBranch:      baseBranch,
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
func KillHead(ctx context.Context, cli *dockerclient.Client, head Head) error {
	if head.ContainerID != "" {
		log.Printf("Killing head: %s in container %s", head.ID, head.ContainerID[:12])
		if err := docker.KillAgent(ctx, cli, head.ContainerID); err != nil {
			return errtrace.Wrap(err)
		}
	}

	if head.HasWorktree && head.ProjectPath != "" {
		if err := git.RemoveWorktree(head.ProjectPath, head.WorktreePath); err != nil {
			log.Printf("warn: remove worktree %s: %v", head.WorktreePath, err)
		}
	}

	if head.HasBranch && head.ProjectPath != "" {
		if err := git.DeleteBranch(head.ProjectPath, head.BranchName); err != nil {
			log.Printf("warn: delete branch %s: %v", head.BranchName, err)
		}
	}

	return nil
}
