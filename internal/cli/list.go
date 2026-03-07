package cli

import (
	"context"
	"fmt"
	"os"
	"text/tabwriter"

	"braces.dev/errtrace"
	"github.com/spf13/cobra"
	"github.com/trolleyman/hydra/internal/db"
	"github.com/trolleyman/hydra/internal/docker"
	"github.com/trolleyman/hydra/internal/heads"
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

		cli, err := docker.NewClient()
		if err != nil {
			return errtrace.Wrap(err)
		}
		defer cli.Close()

		store, err := db.Open(projectRoot)
		if err != nil {
			return errtrace.Wrap(err)
		}

		hs, err := heads.ListHeads(context.Background(), cli, store, projectRoot)
		if err != nil {
			return errtrace.Wrap(err)
		}

		// Filter out ephemeral agents unless --all is specified.
		if !showAll {
			var filtered []heads.Head
			for _, h := range hs {
				if !h.Ephemeral {
					filtered = append(filtered, h)
				}
			}
			hs = filtered
		}

		if len(hs) == 0 {
			if showAll {
				fmt.Println("No agents found.")
			} else {
				fmt.Println("No persistent agents found. Use --all to see ephemeral agents.")
			}
			return nil
		}

		w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
		fmt.Fprintln(w, "ID\tAGENT\tEPHEMERAL\tBRANCH\tWORKTREE\tCONTAINER\tSTATUS\tAGENT STATUS\tPROMPT")
		for _, h := range hs {
			eph := "no"
			if h.Ephemeral {
				eph = "yes"
			}
			branch := "(no branch)"
			if h.Branch != nil {
				branch = *h.Branch
			}

			worktree := "no"
			if h.Worktree != nil {
				worktree = "yes"
			}

			container := ""
			if h.ContainerID != "" {
				container = h.ContainerID[:12]
			} else {
				container = "(no container)"
			}

			status := h.ContainerStatus
			if status == "" {
				status = "-"
			}

			agentStatus := "-"
			if h.AgentStatus != nil {
				agentStatus = string(h.AgentStatus.Status)
			}

			prompt := h.Prompt
			if len(prompt) > 40 {
				prompt = prompt[:37] + "..."
			}

			fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%q\n",
				h.ID, h.AgentType, eph, branch, worktree, container, status, agentStatus, prompt)
		}
		return errtrace.Wrap(w.Flush())
	},
}
