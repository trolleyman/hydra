package main

import (
	"context"
	"fmt"
	"os"
	"text/tabwriter"

	"braces.dev/errtrace"
	"github.com/spf13/cobra"
	"github.com/trolleyman/hydra/internal/docker"
	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/heads"
)

func init() {
	rootCmd.AddCommand(listCmd)
}

var listCmd = &cobra.Command{
	Use:   "list",
	Short: "List all Hydra agents",
	RunE: func(cmd *cobra.Command, args []string) error {
		cwd, err := os.Getwd()
		if err != nil {
			return errtrace.Wrap(fmt.Errorf("get working directory: %w", err))
		}
		projectRoot, err := git.FindProjectRoot(cwd)
		if err != nil {
			return errtrace.Wrap(err)
		}

		cli, err := docker.NewClient()
		if err != nil {
			return errtrace.Wrap(err)
		}
		defer cli.Close()

		hs, err := heads.ListHeads(context.Background(), cli, projectRoot)
		if err != nil {
			return errtrace.Wrap(err)
		}

		if len(hs) == 0 {
			fmt.Println("No agents found.")
			return nil
		}

		w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
		fmt.Fprintln(w, "ID\tAGENT\tBRANCH\tWORKTREE\tCONTAINER\tSTATUS\tPROMPT")
		for _, h := range hs {
			branch := h.BranchName
			if !h.HasBranch {
				branch = "(no branch)"
			}

			worktree := "yes"
			if !h.HasWorktree {
				worktree = "no"
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

			prompt := h.Prompt
			if len(prompt) > 40 {
				prompt = prompt[:40] + "…"
			}

			fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t%s\t%q\n",
				h.ID, h.AgentType, branch, worktree, container, status, prompt)
		}
		return errtrace.Wrap(w.Flush())
	},
}
