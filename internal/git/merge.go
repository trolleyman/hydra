package git

import (
	"fmt"
	"time"

	"braces.dev/errtrace"
	gogit "github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/object"
	"github.com/go-git/go-git/v5/utils/merkletrie"
)

// Merge performs a git merge of srcRef into the current HEAD.
func Merge(projectRoot, srcRef string, authorName, authorEmail string) error {
	repo, err := gogit.PlainOpen(projectRoot)
	if err != nil {
		return errtrace.Wrap(err)
	}

	headRef, err := repo.Head()
	if err != nil {
		return errtrace.Wrap(err)
	}

	srcH, err := repo.ResolveRevision(plumbing.Revision(srcRef))
	if err != nil {
		return errtrace.Wrap(err)
	}

	srcCommit, err := repo.CommitObject(*srcH)
	if err != nil {
		return errtrace.Wrap(err)
	}

	headCommit, err := repo.CommitObject(headRef.Hash())
	if err != nil {
		return errtrace.Wrap(err)
	}

	// Check for fast-forward
	isAncestor, err := headCommit.IsAncestor(srcCommit)
	if err == nil && isAncestor {
		w, err := repo.Worktree()
		if err != nil {
			return errtrace.Wrap(err)
		}
		err = w.Reset(&gogit.ResetOptions{
			Mode:   gogit.HardReset,
			Commit: srcCommit.Hash,
		})
		if err != nil {
			return errtrace.Wrap(err)
		}
		return nil
	}

	// Not a fast-forward, check for conflicts
	conflicts, err := GetConflictingFiles(projectRoot, headRef.Hash().String(), srcCommit.Hash.String())
	if err != nil {
		return errtrace.Wrap(err)
	}
	if len(conflicts) > 0 {
		return errtrace.Wrap(fmt.Errorf("merge conflict in files: %v", conflicts))
	}

	// Simple merge: no files overlap in changes
	mb, err := headCommit.MergeBase(srcCommit)
	if err != nil || len(mb) == 0 {
		return errtrace.Wrap(fmt.Errorf("no merge base found"))
	}
	baseCommit := mb[0]

	baseTree, _ := baseCommit.Tree()
	srcTree, _ := srcCommit.Tree()

	// Find changes from base to src
	changes, err := baseTree.Diff(srcTree)
	if err != nil {
		return errtrace.Wrap(err)
	}

	// Apply changes to head worktree
	w, err := repo.Worktree()
	if err != nil {
		return errtrace.Wrap(err)
	}

	for _, change := range changes {
		action, _ := change.Action()
		switch action {
		case merkletrie.Insert, merkletrie.Modify:
			name := change.To.Name
			file, err := srcTree.File(name)
			if err != nil {
				return errtrace.Wrap(err)
			}
			content, err := file.Contents()
			if err != nil {
				return errtrace.Wrap(err)
			}

			f, err := w.Filesystem.Create(name)
			if err != nil {
				return errtrace.Wrap(err)
			}
			f.Write([]byte(content))
			f.Close()
			w.Add(name)

		case merkletrie.Delete:
			name := change.From.Name
			w.Remove(name)
		}
	}

	// Create merge commit
	if authorName == "" {
		authorName = "Hydra Agent"
	}
	if authorEmail == "" {
		authorEmail = "hydra@hydra.ai"
	}

	msg := fmt.Sprintf("Merge branch '%s'", srcRef)
	commitHash, err := w.Commit(msg, &gogit.CommitOptions{
		Author: &object.Signature{
			Name:  authorName,
			Email: authorEmail,
			When:  time.Now(),
		},
		Parents: []plumbing.Hash{headCommit.Hash, srcCommit.Hash},
	})
	if err != nil {
		return errtrace.Wrap(err)
	}

	fmt.Printf("Created merge commit %s\n", commitHash)
	return nil
}
