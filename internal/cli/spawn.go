package cli

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"text/tabwriter"

	"braces.dev/errtrace"
	"github.com/spf13/cobra"
	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/db"
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

		store, err := db.Open(projectRoot)
		if err != nil {
			return errtrace.Wrap(err)
		}

		// If forced, and head already exists, kill it
		existingHead, err := heads.GetHeadByID(cmd.Context(), cli, store, projectRoot, id)
		if err != nil {
			return errtrace.Wrap(err)
		}
		if existingHead != nil {
			if !spawnFlags.force {
				return errtrace.Errorf("existing head running: %s in container %s: --force to kill", id, existingHead.ContainerID)
			}
			if err := heads.KillHead(cmd.Context(), cli, store, *existingHead); err != nil {
				return errtrace.Wrap(err)
			}
		}

		agentType := docker.AgentType(spawnFlags.agentType)

		// Resolve Dockerfile path: --flag > config.toml > .hydra/config/<type>/Dockerfile
		dockerfilePath := spawnFlags.dockerfile
		if dockerfilePath == "" {
			rel := cfg.GetDockerfileForAgent(projectRoot, string(agentType))
			if rel != "" {
				if filepath.IsAbs(rel) {
					dockerfilePath = rel
				} else {
					dockerfilePath = filepath.Join(projectRoot, rel)
				}
				log.Printf("Using custom Dockerfile for %s: %s", agentType, dockerfilePath)
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
			return errtrace.Wrap(fmt.Errorf("unknown agent type %q; supported: claude, gemini", agentType))
		}

		baseBranch := spawnFlags.baseBranch
		if baseBranch == "" {
			baseBranch, err = git.GetCurrentBranch(projectRoot)
			if err != nil {
				return errtrace.Wrap(fmt.Errorf("detect current branch: %w", err))
			}
		}

		head, err := heads.SpawnHead(cmd.Context(), cli, store, projectRoot, heads.SpawnHeadOptions{
			ID:             id,
			PrePrompt:      prePrompt,
			Prompt:         prompt,
			AgentType:      agentType,
			BaseBranch:     baseBranch,
			DockerfilePath: dockerfilePath,
		})
		if err != nil {
			return errtrace.Wrap(err)
		}

		branchName := "hydra/" + head.ID
		log.Printf("Agent %s started on branch %s\n", head.ID, branchName)
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
