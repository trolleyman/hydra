package cli

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"strings"

	"braces.dev/errtrace"
	"github.com/spf13/cobra"
	"github.com/trolleyman/hydra/internal/docker"
	"github.com/trolleyman/hydra/internal/heads"
	"github.com/trolleyman/hydra/internal/paths"
)

var mergeFlags struct {
	preview bool
}

func init() {
	mergeCmd.Flags().BoolVarP(&mergeFlags.preview, "preview", "p", false, "Preview diff before merging")
	rootCmd.AddCommand(mergeCmd)
}

var mergeCmd = &cobra.Command{
	Use:   "merge [-p] <id>",
	Short: "Merge a head's changes into the current branch and kill it",
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

		ctx := cmd.Context()
		head, err := heads.GetHeadByID(ctx, cli, projectRoot, id)
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
			diffCmd := exec.CommandContext(ctx, "git", "-C", projectRoot, "diff", "HEAD..."+branchName)
			diffCmd.Stdin = os.Stdin
			diffCmd.Stdout = os.Stdout
			diffCmd.Stderr = os.Stderr
			if err := diffCmd.Run(); err != nil {
				return errtrace.Wrap(fmt.Errorf("git diff: %w", err))
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

		gitMergeCmd := exec.CommandContext(ctx, "git", "-C", projectRoot, "merge", branchName)
		gitMergeCmd.Stdin = os.Stdin
		gitMergeCmd.Stdout = os.Stdout
		gitMergeCmd.Stderr = os.Stderr
		if err := gitMergeCmd.Run(); err != nil {
			return errtrace.Wrap(fmt.Errorf("merge failed (resolve conflicts then run 'hydra kill %s'): %w", id, err))
		}

		if err := heads.KillHead(ctx, cli, *head); err != nil {
			return errtrace.Wrap(err)
		}

		return nil
	},
}
