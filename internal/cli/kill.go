package cli

import (
	"braces.dev/errtrace"
	"github.com/spf13/cobra"
	"github.com/trolleyman/hydra/internal/docker"
	"github.com/trolleyman/hydra/internal/heads"
	"github.com/trolleyman/hydra/internal/paths"
)

func init() {
	rootCmd.AddCommand(killCmd)
}

var killCmd = &cobra.Command{
	Use:   "kill <id>",
	Short: "Kill the head with the selected ID",
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

		head, err := heads.GetHeadByID(cmd.Context(), cli, projectRoot, id)
		if err != nil {
			return errtrace.Wrap(err)
		}

		if head == nil {
			return errtrace.Errorf("no head found with ID: %s", id)
		}

		// log.Printf("head found with ID: %s: %v: %s", id, head.HasWorktree, head.WorktreePath)
		err = heads.KillHead(cmd.Context(), cli, *head)
		if err != nil {
			return errtrace.Wrap(err)
		}

		return nil
	},
}
