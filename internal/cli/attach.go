package cli

import (
	"fmt"

	"braces.dev/errtrace"
	"github.com/spf13/cobra"
	"github.com/trolleyman/hydra/internal/daemon"
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

		ctx := cmd.Context()
		client, err := daemon.Connect(ctx, projectRoot)
		if err != nil {
			return errtrace.Wrap(err)
		}

		conn, err := client.DialTerminal(id, false)
		if err != nil {
			return errtrace.Wrap(err)
		}
		fmt.Printf("Attached to agent %s. Press Ctrl+C to detach (agent keeps running).\n", id)
		return errtrace.Wrap(attachWS(conn))
	},
}
