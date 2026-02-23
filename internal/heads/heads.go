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

	"braces.dev/errtrace"
	dockerclient "github.com/docker/docker/client"
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
	// ClaudeStatus is read from <projectDir>/.hydra/status/<id>.json (nil if absent).
	ClaudeStatus *ClaudeStatus
	CreatedAt    int64 // Unix timestamp from container creation; 0 if no container
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
		var worktree *string
		if statErr == nil {
			worktree = &worktreePath
		}
		branchCopy := branch
		head := &Head{
			ID:           id,
			Branch:       &branchCopy,
			Worktree:     worktree,
			ProjectPath:  projectRoot,
			ClaudeStatus: readClaudeStatus(projectRoot, id),
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
			head.CreatedAt = a.Created
			if head.ProjectPath == "" {
				head.ProjectPath = a.Meta.ProjectPath
			}
		} else {
			// Container without a matching branch (orphaned)
			worktreePath := paths.GetWorktreeDirFromProjectRoot(a.Meta.ProjectPath, id)
			// fmt.Printf("%s: worktreeDir: %s, projectPath: %s\n", id, worktreePath, a.Meta.ProjectPath)
			_, statErr := os.Stat(worktreePath)
			var worktree *string
			if statErr == nil {
				worktree = &worktreePath
			}
			byID[id] = &Head{
				ID:              id,
				Branch:          nil, // no git branch for orphaned containers
				Worktree:        worktree,
				ProjectPath:     a.Meta.ProjectPath,
				ContainerID:     a.ContainerID,
				ContainerStatus: a.Status,
				AgentType:       a.Meta.AgentType,
				PrePrompt:       a.Meta.PrePrompt,
				Prompt:          a.Meta.Prompt,
				BaseBranch:      a.Meta.BaseBranch,
				ClaudeStatus:    readClaudeStatus(a.Meta.ProjectPath, id),
				CreatedAt:       a.Created,
			}
		}
	}

	// Collect all heads into a slice.
	result := make([]Head, 0, len(byID))
	for _, h := range byID {
		result = append(result, *h)
	}

	// Sort deterministically: newest first (oldest last), with ID as tiebreaker.
	sort.Slice(result, func(i, j int) bool {
		if result[i].CreatedAt != result[j].CreatedAt {
			return result[i].CreatedAt > result[j].CreatedAt
		}
		return result[i].ID < result[j].ID
	})

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
		Branch:          &branchName,
		Worktree:        &worktreePath,
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

	return nil
}
