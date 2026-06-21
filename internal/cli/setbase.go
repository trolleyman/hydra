package cli

import (
	"fmt"

	"braces.dev/errtrace"
	"github.com/spf13/cobra"
	"github.com/trolleyman/hydra/internal/daemon"
	"github.com/trolleyman/hydra/internal/db"
	"github.com/trolleyman/hydra/internal/heads"
	"github.com/trolleyman/hydra/internal/paths"
)

func init() {
	rootCmd.AddCommand(setBaseCmd)
}

var setBaseCmd = &cobra.Command{
	Use:   "set-base <id> <branch>",
	Short: "Change a head's base branch (metadata only; does not rebase commits)",
	Long: `Change which branch a head is considered to be based on.

This is a metadata-only change: it updates what 'update-from-base' merges in and
what the diff view compares against, but it does NOT move the head's existing
commits onto the new base. If you also want the commits rebased, do that yourself
with git from the head's worktree, e.g.:

    git rebase --onto <new-base> <old-base>`,
	Args: cobra.ExactArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		id := args[0]
		baseBranch := args[1]

		projectRoot, err := paths.GetProjectRootFromCwd()
		if err != nil {
			return errtrace.Wrap(err)
		}

		store, err := db.Open(projectRoot)
		if err != nil {
			return errtrace.Wrap(err)
		}

		ctx := cmd.Context()
		head, err := heads.GetHeadByID(ctx, nil, store, projectRoot, id)
		if err != nil {
			return errtrace.Wrap(err)
		}
		if head == nil {
			return errtrace.Errorf("no head found with ID: %s", id)
		}

		client, err := daemon.Connect(ctx, projectRoot)
		if err != nil {
			return errtrace.Wrap(err)
		}
		updated, err := client.SetAgentBaseBranch(ctx, id, baseBranch)
		if err != nil {
			return errtrace.Wrap(fmt.Errorf("set base failed: %w", err))
		}

		fmt.Printf("Set base branch of %s to %s\n", id, updated.BaseBranch)
		return nil
	},
}
