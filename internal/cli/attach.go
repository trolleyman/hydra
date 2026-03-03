package cli

import (
	"context"

	"braces.dev/errtrace"
	"github.com/cockroachdb/errors"
	"github.com/spf13/cobra"
	"github.com/trolleyman/hydra/internal/db"
	"github.com/trolleyman/hydra/internal/docker"
	"github.com/trolleyman/hydra/internal/heads"
	"github.com/trolleyman/hydra/internal/paths"
)

func init() {
	rootCmd.AddCommand(attachCmd)
}

var attachCmd = &cobra.Command{
	Use:   "attach <id>",
	Short: "Attach to a running agent with the ID given",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		id := args[0]

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

		head, err := heads.GetHeadByID(context.Background(), cli, store, projectRoot, id)
		if err != nil {
			return errtrace.Wrap(err)
		}
		if head == nil {
			return errtrace.Wrap(errors.Errorf("no head found with ID: %s", id))
		}

		return errtrace.Wrap(docker.AttachAgent(cmd.Context(), cli, head.ContainerID))
	},
}
