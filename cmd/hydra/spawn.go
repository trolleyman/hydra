package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/cockroachdb/errors"
	"github.com/spf13/cobra"
	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/docker"
	"github.com/trolleyman/hydra/internal/git"
)

var spawnFlags struct {
	dockerfile string
	baseBranch string
}

func init() {
	spawnCmd.Flags().StringVar(&spawnFlags.dockerfile, "dockerfile", "", "Path to a custom Dockerfile")
	spawnCmd.Flags().StringVar(&spawnFlags.baseBranch, "base-branch", "", "Base branch (default: current branch)")
	rootCmd.AddCommand(spawnCmd)
}

var spawnCmd = &cobra.Command{
	Use:   "spawn <prompt>",
	Short: "Spawn a new AI agent for the given prompt",
	Args:  cobra.MinimumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		// Allow multi-word prompts without requiring quotes
		prompt := strings.Join(args, " ")

		cwd, err := os.Getwd()
		if err != nil {
			return errors.Errorf("get working directory: %w", err)
		}

		projectRoot, err := git.FindProjectRoot(cwd)
		if err != nil {
			return err
		}

		cfg, err := config.Load(projectRoot)
		if err != nil {
			return err
		}

		dockerfilePath, err := config.FindDockerfile(cfg, projectRoot, spawnFlags.dockerfile)
		if err != nil {
			return err
		}

		baseBranch := spawnFlags.baseBranch
		if baseBranch == "" {
			baseBranch, err = git.GetCurrentBranch(projectRoot)
			if err != nil {
				return errors.Wrapf(err, "detect current branch")
			}
		}

		branchName := git.SlugFromPrompt(prompt)
		slug := strings.TrimPrefix(branchName, "agent/")
		worktreePath := filepath.Join(projectRoot, ".hydra", "worktrees", slug)

		fmt.Printf("Creating worktree on branch %q...\n", branchName)
		if err := git.CreateWorktree(projectRoot, worktreePath, branchName, baseBranch); err != nil {
			return err
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

		// Find the user's gitconfig file to mount read-only
		gitConfigPath := ""
		if home, err := os.UserHomeDir(); err == nil {
			for _, p := range []string{
				filepath.Join(home, ".gitconfig"),
				filepath.Join(home, ".config", "git", "config"),
			} {
				if _, err := os.Stat(p); err == nil {
					gitConfigPath = p
					break
				}
			}
		}

		cli, err := docker.NewClient()
		if err != nil {
			return err
		}
		defer cli.Close()

		containerID, err := docker.SpawnAgent(context.Background(), cli, docker.SpawnOptions{
			Prompt:         prompt,
			WorktreePath:   worktreePath,
			BranchName:     branchName,
			BaseBranch:     baseBranch,
			DockerfilePath: dockerfilePath,
			PromptPrefix:   cfg.PromptPrefix,
			GitAuthorName:  gitAuthorName,
			GitAuthorEmail: gitAuthorEmail,
			GitConfigPath:  gitConfigPath,
		})
		if err != nil {
			_ = git.RemoveWorktree(projectRoot, worktreePath)
			return errors.Wrapf(err, "spawn agent")
		}

		fmt.Printf("Agent started on branch %s (container %s)\n", branchName, containerID[:12])
		fmt.Printf("  hydra attach %s   — attach to the session\n", containerID[:12])
		fmt.Printf("  hydra list        — view all running agents\n")
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
