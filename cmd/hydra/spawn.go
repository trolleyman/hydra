package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"text/tabwriter"

	"braces.dev/errtrace"
	"github.com/spf13/cobra"
	"github.com/trolleyman/hydra/internal/docker"
	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/paths"
)

var spawnFlags struct {
	agentType  string
	dockerfile string
	baseBranch string
}

func init() {
	spawnCmd.Flags().StringVar(&spawnFlags.agentType, "agent", string(docker.AgentTypeClaude), "Agent type (claude, gemini)")
	spawnCmd.Flags().StringVar(&spawnFlags.dockerfile, "dockerfile", "", "Custom Dockerfile path (agent type inferred from ENTRYPOINT if possible)")
	spawnCmd.Flags().StringVar(&spawnFlags.baseBranch, "base-branch", "", "Base branch (default: current branch)")
	rootCmd.AddCommand(spawnCmd)
}

var spawnCmd = &cobra.Command{
	Use:   "spawn [--agent <agent>] [--dockerfile <path>] [--base-branch <base-branch>] <id> <prompt>",
	Short: "Spawn a new AI agent for the given prompt",
	Args:  cobra.MinimumNArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		id := args[0]
		// Allow multi-word prompts without requiring quotes
		prompt := strings.Join(args[1:], " ")

		cwd, err := os.Getwd()
		if err != nil {
			return errtrace.Wrap(fmt.Errorf("get working directory: %w", err))
		}

		projectRoot, err := git.FindProjectRoot(cwd)
		if err != nil {
			return errtrace.Wrap(err)
		}

		agentType := docker.AgentType(spawnFlags.agentType)

		// If a custom Dockerfile is provided, try to infer the agent type from it.
		if spawnFlags.dockerfile != "" {
			content, readErr := os.ReadFile(spawnFlags.dockerfile)
			if readErr != nil {
				return errtrace.Wrap(fmt.Errorf("read dockerfile: %w", readErr))
			}
			if inferred, ok := docker.InferAgentType(string(content)); ok {
				agentType = inferred
			}
		}

		switch agentType {
		case docker.AgentTypeClaude, docker.AgentTypeGemini:
			// valid
		default:
			return fmt.Errorf("unknown agent type %q; supported: claude, gemini", agentType)
		}

		baseBranch := spawnFlags.baseBranch
		if baseBranch == "" {
			baseBranch, err = git.GetCurrentBranch(projectRoot)
			if err != nil {
				return errtrace.Wrap(fmt.Errorf("detect current branch: %w", err))
			}
		}

		branchName := "hydra/" + id
		worktreesDir := paths.GetWorktreeDirFromProjectRoot(projectRoot)
		worktreePath := filepath.Join(worktreesDir, id)

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

		containerID, err := docker.SpawnAgent(context.Background(), cli, docker.SpawnOptions{
			Id:             id,
			AgentType:      agentType,
			DockerfilePath: spawnFlags.dockerfile,
			Prompt:         prompt,
			ProjectPath:    projectRoot,
			WorktreePath:   worktreePath,
			BranchName:     branchName,
			BaseBranch:     baseBranch,
			GitAuthorName:  gitAuthorName,
			GitAuthorEmail: gitAuthorEmail,
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
