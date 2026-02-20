package main

import (
	"context"
	"strings"

	"braces.dev/errtrace"
	"github.com/cockroachdb/errors"
	"github.com/spf13/cobra"
	"github.com/trolleyman/hydra/internal/docker"
)

func init() {
	rootCmd.AddCommand(attachCmd)
}

var attachCmd = &cobra.Command{
	Use:   "attach <id>",
	Short: "Attach to a running agent session",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		prefix := args[0]

		cli, err := docker.NewClient()
		if err != nil {
			return errtrace.Wrap(err)
		}
		defer cli.Close()

		agents, err := docker.ListAgents(context.Background(), cli)
		if err != nil {
			return errtrace.Wrap(err)
		}

		var matches []docker.Agent
		for _, a := range agents {
			if strings.HasPrefix(a.ContainerID, prefix) {
				matches = append(matches, a)
			}
		}

		switch len(matches) {
		case 0:
			return errtrace.Wrap(errors.Errorf("no agent found matching %q", prefix))
		case 1:
			return errtrace.Wrap(docker.AttachAgent(matches[0].ContainerID))
		default:
			return errtrace.Wrap(errors.Errorf("ambiguous ID %q matches %d agents; use a longer prefix", prefix, len(matches)))
		}
	},
}
