package cli

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"text/tabwriter"

	"braces.dev/errtrace"
	"github.com/spf13/cobra"
	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/docker"
	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/heads"
	"github.com/trolleyman/hydra/internal/paths"
)

var spawnFlags struct {
	agentType  string
	dockerfile string
	baseBranch string
	force      bool
}

func init() {
	spawnCmd.Flags().StringVar(&spawnFlags.agentType, "agent", string(docker.AgentTypeClaude), "Agent type (claude, gemini)")
	spawnCmd.Flags().StringVar(&spawnFlags.dockerfile, "dockerfile", "", "Custom Dockerfile path (agent type inferred from ENTRYPOINT if possible)")
	spawnCmd.Flags().StringVar(&spawnFlags.baseBranch, "base-branch", "", "Base branch (default: current branch)")
	spawnCmd.Flags().BoolVarP(&spawnFlags.force, "force", "f", false, "Force delete existing worktree and branch if they exist")
	rootCmd.AddCommand(spawnCmd)
}

var spawnCmd = &cobra.Command{
	Use:   "spawn [--agent <agent>] [--dockerfile <path>] [--base-branch <base-branch>] [--force|-f] <id> <prompt>",
	Short: "Spawn a new AI agent for the given prompt",
	Args:  cobra.MinimumNArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		id := args[0]
		// Allow multi-word prompts without requiring quotes
		prompt := strings.Join(args[1:], " ")

		projectRoot, err := paths.GetProjectRootFromCwd()
		if err != nil {
			return errtrace.Wrap(err)
		}

		cfg, err := config.Load(projectRoot)
		if err != nil {
			return errtrace.Wrap(err)
		}
		prePrompt := config.DefaultPrePrompt
		if cfg.PrePrompt != nil {
			prePrompt = *cfg.PrePrompt
		}

		cli, err := docker.NewClient()
		if err != nil {
			return errtrace.Wrap(err)
		}
		defer cli.Close()

		// If forced, and head already exists, kill it
		existingHead, err := heads.GetHeadByID(cmd.Context(), cli, projectRoot, id)
		if err != nil {
			return errtrace.Wrap(err)
		}
		if existingHead != nil {
			if !spawnFlags.force {
				return errtrace.Errorf("existing head running: %s in container %s: --force to kill", id, existingHead.ContainerID)
			}
			if err := heads.KillHead(cmd.Context(), cli, *existingHead); err != nil {
				return errtrace.Wrap(err)
			}
		}

		agentType := docker.AgentType(spawnFlags.agentType)

		// If no --dockerfile flag, check project config for a per-agent Dockerfile.
		dockerfilePath := spawnFlags.dockerfile
		if dockerfilePath == "" {
			if agentCfg, ok := cfg.Agents[string(agentType)]; ok && agentCfg.Dockerfile != nil {
				rel := *agentCfg.Dockerfile
				if filepath.IsAbs(rel) {
					dockerfilePath = rel
				} else {
					dockerfilePath = filepath.Join(projectRoot, rel)
				}
				log.Printf("Using config Dockerfile for %s: %s", agentType, dockerfilePath)
			}
		}
		if dockerfilePath != "" {
			if _, readErr := os.ReadFile(dockerfilePath); readErr != nil {
				return errtrace.Wrap(fmt.Errorf("read dockerfile: %w", readErr))
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
		worktreePath := paths.GetWorktreeDirFromProjectRoot(projectRoot, id)
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
			DockerfilePath: dockerfilePath,
			PrePrompt:      prePrompt,
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

		log.Printf("Agent %s started on branch %s (container %s)\n", id, branchName, containerID[:12])
		w := tabwriter.NewWriter(log.Writer(), 0, 0, 1, ' ', 0)
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
