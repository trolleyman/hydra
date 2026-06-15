package cli

import (
	"fmt"
	"os"
	"text/tabwriter"

	"braces.dev/errtrace"
	"github.com/spf13/cobra"
	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/daemon"
	"github.com/trolleyman/hydra/internal/paths"
)

func init() {
	listCmd.Flags().BoolP("all", "a", false, "List all agents, including ephemeral ones")
	rootCmd.AddCommand(listCmd)
}

var listCmd = &cobra.Command{
	Use:   "list",
	Short: "List all Hydra agents",
	RunE: func(cmd *cobra.Command, args []string) error {
		showAll, _ := cmd.Flags().GetBool("all")

		projectRoot, err := paths.GetProjectRootFromCwd()
		if err != nil {
			return errtrace.Wrap(err)
		}

		ctx := cmd.Context()
		client, err := daemon.Connect(ctx, projectRoot)
		if err != nil {
			return errtrace.Wrap(err)
		}

		agents, err := client.ListAgents(ctx)
		if err != nil {
			return errtrace.Wrap(err)
		}

		if !showAll {
			var filtered []api.AgentResponse
			for _, a := range agents {
				if a.Ephemeral == nil || !*a.Ephemeral {
					filtered = append(filtered, a)
				}
			}
			agents = filtered
		}

		if len(agents) == 0 {
			if showAll {
				fmt.Println("No agents found.")
			} else {
				fmt.Println("No persistent agents found. Use --all to see ephemeral agents.")
			}
			return nil
		}

		w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
		fmt.Fprintln(w, "ID\tAGENT\tEPHEMERAL\tBRANCH\tWORKTREE\tPID\tSTATUS\tAGENT STATUS\tPROMPT")
		for _, a := range agents {
			eph := "no"
			if a.Ephemeral != nil && *a.Ephemeral {
				eph = "yes"
			}
			branch := "(no branch)"
			if a.BranchName != nil {
				branch = *a.BranchName
			}
			worktree := "no"
			if a.WorktreePath != nil {
				worktree = "yes"
			}
			pid := a.ContainerId
			if pid == "" {
				pid = "-"
			}
			status := a.ContainerStatus
			if status == "" {
				status = "-"
			}
			agentStatus := "-"
			if a.AgentStatus != nil {
				agentStatus = string(a.AgentStatus.Status)
			}
			prompt := a.Prompt
			if len(prompt) > 40 {
				prompt = prompt[:37] + "..."
			}
			fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%q\n",
				a.Id, a.AgentType, eph, branch, worktree, pid, status, agentStatus, prompt)
		}
		return errtrace.Wrap(w.Flush())
	},
}
