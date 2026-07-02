package cli

import (
	"fmt"
	"strings"

	"braces.dev/errtrace"
	"github.com/spf13/cobra"
	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/daemon"
	"github.com/trolleyman/hydra/internal/paths"
	"github.com/trolleyman/hydra/internal/sandbox"
)

var spawnFlags struct {
	agentType  string
	model      string
	baseBranch string
	force      bool
	detach     bool
}

func init() {
	spawnCmd.Flags().StringVar(&spawnFlags.agentType, "agent", string(sandbox.AgentTypeClaude), "Agent type (claude, gemini, copilot, codex)")
	spawnCmd.Flags().StringVar(&spawnFlags.model, "model", "", "Model for the agent CLI (e.g. opus, sonnet, haiku); default: CLI's own default")
	spawnCmd.Flags().StringVar(&spawnFlags.baseBranch, "base-branch", "", "Base branch (default: current branch)")
	spawnCmd.Flags().BoolVarP(&spawnFlags.force, "force", "f", false, "Force replace an existing head with the same ID")
	spawnCmd.Flags().BoolVarP(&spawnFlags.detach, "detach", "d", false, "Start the agent and exit instead of attaching")
	rootCmd.AddCommand(spawnCmd)
}

var spawnCmd = &cobra.Command{
	Use:   "spawn [--agent <agent>] [--model <model>] [--base-branch <base-branch>] [--force|-f] [--detach|-d] <id> [prompt]",
	Short: "Spawn a new sandboxed AI agent for the given prompt",
	Args:  cobra.MinimumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		id := args[0]
		var prompt string
		if len(args) > 1 {
			prompt = strings.Join(args[1:], " ")
		}

		agentType := sandbox.AgentType(spawnFlags.agentType)
		switch agentType {
		case sandbox.AgentTypeClaude, sandbox.AgentTypeGemini, sandbox.AgentTypeCopilot, sandbox.AgentTypeCodex:
		default:
			return errtrace.Wrap(fmt.Errorf("unknown agent type %q; supported: claude, gemini, copilot, codex", agentType))
		}

		projectRoot, err := paths.GetProjectRootFromCwd()
		if err != nil {
			return errtrace.Wrap(err)
		}

		ctx := cmd.Context()
		client, err := daemon.Connect(ctx, projectRoot)
		if err != nil {
			return errtrace.Wrap(err)
		}

		// Replace an existing head if --force.
		if spawnFlags.force {
			_ = client.KillAgent(ctx, id)
		}

		at := string(agentType)
		body := api.SpawnAgentRequest{Id: id, AgentType: &at}
		if prompt != "" {
			body.Prompt = &prompt
		}
		if spawnFlags.model != "" {
			body.Model = &spawnFlags.model
		}
		if spawnFlags.baseBranch != "" {
			body.BaseBranch = &spawnFlags.baseBranch
		}

		if _, err := client.SpawnAgent(ctx, body); err != nil {
			return errtrace.Wrap(err)
		}

		if spawnFlags.detach {
			fmt.Printf("Started agent %s (hydra/%s). Attach with: hydra attach %s\n", id, id, id)
			return nil
		}

		conn, err := client.DialTerminal(id, false)
		if err != nil {
			return errtrace.Wrap(err)
		}
		fmt.Printf("Attached to agent %s. Press Ctrl+C to detach (agent keeps running).\n", id)
		return errtrace.Wrap(attachWS(conn))
	},
}
