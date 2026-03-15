package cli

import (
	"bufio"
	"fmt"
	"os"
	"strings"

	"braces.dev/errtrace"
	gogit "github.com/go-git/go-git/v5"
	"github.com/spf13/cobra"
	"github.com/trolleyman/hydra/internal/db"
	"github.com/trolleyman/hydra/internal/docker"
	"github.com/trolleyman/hydra/internal/git"
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

		store, err := db.Open(projectRoot)
		if err != nil {
			return errtrace.Wrap(err)
		}

		ctx := cmd.Context()
		head, err := heads.GetHeadByID(ctx, cli, store, projectRoot, id)
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

		// Get author info from git config
		authorName, authorEmail := "", ""
		if repo, err := gogit.PlainOpen(projectRoot); err == nil {
			if cfg, err := repo.Config(); err == nil {
				authorName = cfg.Author.Name
				authorEmail = cfg.Author.Email
			}
		}

		if err := git.Merge(projectRoot, branchName, authorName, authorEmail); err != nil {
			return errtrace.Wrap(fmt.Errorf("merge failed (resolve conflicts then run 'hydra kill %s'): %w", id, err))
		}

		if err := heads.KillHead(ctx, cli, store, *head); err != nil {
			return errtrace.Wrap(err)
		}

		return nil
	},
}
