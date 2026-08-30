package cli

import (
	"bufio"
	"fmt"
	"os"
	"strings"

	"braces.dev/errtrace"
	"github.com/spf13/cobra"
	"github.com/trolleyman/hydra/internal/daemon"
	"github.com/trolleyman/hydra/internal/db"
	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/heads"
	"github.com/trolleyman/hydra/internal/paths"
	"github.com/trolleyman/hydra/internal/projects"
)

var mergeFlags struct {
	preview bool
	keep    bool
}

func init() {
	mergeCmd.Flags().BoolVarP(&mergeFlags.preview, "preview", "p", false, "Preview diff before merging")
	mergeCmd.Flags().BoolVarP(&mergeFlags.keep, "keep", "k", false, "Merge but keep the head running (session, worktree and branch survive)")
	rootCmd.AddCommand(mergeCmd)
}

var mergeCmd = &cobra.Command{
	Use:   "merge [-p] [-k] <id>",
	Short: "Merge a head's changes into the current branch and kill it (unless --keep)",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		id := args[0]

		projectRoot, err := paths.GetProjectRootFromCwd()
		if err != nil {
			return errtrace.Wrap(err)
		}

		store, err := db.OpenGlobal(projectRoot)
		if err != nil {
			return errtrace.Wrap(err)
		}
		if _, err := projects.NewManager(store); err != nil {
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

		if head.Branch == nil {
			return errtrace.Errorf("head %s has no git branch to merge", id)
		}
		branchName := *head.Branch

		if mergeFlags.preview {
			diffFiles, err := git.GetDiff(projectRoot, "HEAD", branchName, false, true, "", 3)
			if err != nil {
				return errtrace.Wrap(fmt.Errorf("git diff: %w", err))
			}

			for _, f := range diffFiles {
				if f.Binary {
					fmt.Printf("Binary file %s changed\n", f.Path)
					continue
				}
				for _, h := range f.Hunks {
					fmt.Println(h.Header)
					for _, l := range h.Lines {
						prefix := " "
						switch l.Type {
						case git.DiffLineAddition:
							prefix = "+"
						case git.DiffLineDeletion:
							prefix = "-"
						}
						fmt.Printf("%s%s\n", prefix, l.Content)
					}
				}
			}

			fmt.Fprint(os.Stderr, "\nProceed with merge? [y/N]: ")
			reader := bufio.NewReader(os.Stdin)
			answer, readErr := reader.ReadString('\n')
			if readErr != nil {
				fmt.Fprintln(os.Stderr, "\nMerge cancelled.")
				return nil
			}
			if strings.ToLower(strings.TrimSpace(answer)) != "y" {
				fmt.Fprintln(os.Stderr, "Merge cancelled.")
				return nil
			}
		}

		// Perform the merge and tear-down through the daemon, which owns the live
		// session and archives the head with end_state "merged" (doing the merge
		// here and then calling KillAgent would mislabel it "killed"). --keep
		// merges without the tear-down: the head stays alive and keeps working.
		client, err := daemon.Connect(ctx, projectRoot)
		if err != nil {
			return errtrace.Wrap(err)
		}
		if err := client.MergeAgent(ctx, id, !mergeFlags.keep); err != nil {
			return errtrace.Wrap(fmt.Errorf("merge failed (resolve conflicts then run 'hydra kill %s'): %w", id, err))
		}
		if mergeFlags.keep {
			fmt.Printf("Merged %s into its base branch; head kept running.\n", id)
		}

		return nil
	},
}
