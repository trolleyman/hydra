package main

import (
	"context"
	"fmt"
	"os"
	"text/tabwriter"

	"braces.dev/errtrace"
	"github.com/spf13/cobra"
	"github.com/trolleyman/hydra/internal/docker"
)

func init() {
	rootCmd.AddCommand(listCmd)
}

var listCmd = &cobra.Command{
	Use:   "list",
	Short: "List all AI agents",
	RunE: func(cmd *cobra.Command, args []string) error {
		cli, err := docker.NewClient()
		if err != nil {
			return errtrace.Wrap(err)
		}
		defer cli.Close()

		agents, err := docker.ListAgents(context.Background(), cli)
		if err != nil {
			return errtrace.Wrap(err)
		}

		if len(agents) == 0 {
			fmt.Println("No agents running.")
			return nil
		}

		w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
		fmt.Fprintln(w, "ID\tIMAGE\tBRANCH\tSTATUS\tPROMPT")
		for _, a := range agents {
			id := a.ContainerID
			if len(id) > 12 {
				id = id[:12]
			}
			prompt := a.Meta.Prompt
			if len(prompt) > 50 {
				prompt = prompt[:50] + "…"
			}
			fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%q\n",
				id, a.ImageName, a.Meta.BranchName, a.Status, prompt)
		}
		return errtrace.Wrap(w.Flush())
	},
}
