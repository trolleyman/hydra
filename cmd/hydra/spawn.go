package main

import (
	"context"
	"crypto/rand"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"text/tabwriter"

	"braces.dev/errtrace"
	"github.com/spf13/cobra"
	"github.com/trolleyman/hydra/internal/docker"
	"github.com/trolleyman/hydra/internal/git"
)

var spawnFlags struct {
	id         string
	agentType  string
	baseBranch string
}

func init() {
	spawnCmd.Flags().StringVar(&spawnFlags.id, "id", "", "Agent ID (default: random 8-char hex)")
	spawnCmd.Flags().StringVar(&spawnFlags.agentType, "agent", string(docker.AgentTypeClaude), "Agent type (claude, gemini)")
	spawnCmd.Flags().StringVar(&spawnFlags.baseBranch, "base-branch", "", "Base branch (default: current branch)")
	rootCmd.AddCommand(spawnCmd)
}

var spawnCmd = &cobra.Command{
	Use:   "spawn [--id <id>] [--agent <agent>] [--base-branch <base-branch>] <prompt>",
	Short: "Spawn a new AI agent for the given prompt",
	Args:  cobra.MinimumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		// Allow multi-word prompts without requiring quotes
		prompt := strings.Join(args, " ")

		cwd, err := os.Getwd()
		if err != nil {
			return errtrace.Wrap(fmt.Errorf("get working directory: %w", err))
		}

		projectRoot, err := git.FindProjectRoot(cwd)
		if err != nil {
			return errtrace.Wrap(err)
		}

		// Resolve agent ID
		id := spawnFlags.id
		if id == "" {
			id, err = randomID()
			if err != nil {
				return errtrace.Wrap(fmt.Errorf("generate agent ID: %w", err))
			}
		}

		agentType := docker.AgentType(spawnFlags.agentType)
		switch agentType {
		case docker.AgentTypeClaude, docker.AgentTypeGemini:
			// valid
		default:
			return fmt.Errorf("unknown agent type %q; supported: claude, gemini", spawnFlags.agentType)
		}

		baseBranch := spawnFlags.baseBranch
		if baseBranch == "" {
			baseBranch, err = git.GetCurrentBranch(projectRoot)
			if err != nil {
				return errtrace.Wrap(fmt.Errorf("detect current branch: %w", err))
			}
		}

		branchName := "hydra/" + id
		worktreePath := filepath.Join(projectRoot, ".hydra", "worktrees", id)

		fmt.Printf("Creating worktree on branch %q...\n", branchName)
		if err := git.CreateWorktree(projectRoot, worktreePath, branchName, baseBranch); err != nil {
			return errtrace.Wrap(err)
		}

		// Resolve git identity: env vars take priority, then git config
		gitAuthorName := os.Getenv("GIT_AUTHOR_NAME")
		if gitAuthorName == "" {
			gitAuthorName = readGitConfig(projectRoot, "user.name")
		}
		gitAuthorEmail := os.Getenv("GIT_AUTHOR_EMAIL")
		if gitAuthorEmail == "" {
			gitAuthorEmail = readGitConfig(projectRoot, "user.email")
		}

		cli, err := docker.NewClient()
		if err != nil {
			return errtrace.Wrap(err)
		}
		defer cli.Close()

		// Resolve the current user's identity for container user creation.
		currentUser, err := user.Current()
		if err != nil {
			return errtrace.Wrap(fmt.Errorf("get current user: %w", err))
		}
		uid, _ := strconv.Atoi(currentUser.Uid)
		gid, _ := strconv.Atoi(currentUser.Gid)
		groupName := currentUser.Username
		if grp, err := user.LookupGroupId(currentUser.Gid); err == nil {
			groupName = grp.Name
		}

		containerID, err := docker.SpawnAgent(context.Background(), cli, docker.SpawnOptions{
			Id:             id,
			AgentType:      agentType,
			Prompt:         prompt,
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
			return errtrace.Wrap(fmt.Errorf("spawn agent: %w", err))
		}

		fmt.Printf("Agent %s started on branch %s (container %s)\n", id, branchName, containerID[:12])
		w := tabwriter.NewWriter(os.Stdout, 0, 0, 1, ' ', 0)
		fmt.Fprintf(w, "  hydra attach %s\t- attach to the session\n", id)
		fmt.Fprintf(w, "  hydra list\t- view all running agents\n")
		w.Flush()
		return nil
	},
}

// readGitConfig reads a single git config value via the git binary.
func readGitConfig(projectRoot, key string) string {
	out, err := exec.Command("git", "-C", projectRoot, "config", key).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// randomID generates a random 8-character hex string.
func randomID() (string, error) {
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return fmt.Sprintf("%x", b), nil
}
