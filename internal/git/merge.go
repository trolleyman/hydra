package git

import (
	"fmt"
	"os"
	"os/exec"
	"strings"

	"braces.dev/errtrace"
)

// Merge performs a git merge of srcRef into the current HEAD.
// Uses fast-forward when possible, otherwise performs a --no-ff merge commit.
// Returns an error if there are conflicting files.
//
// Merge refuses to run when the destination working tree has uncommitted changes
// to tracked files: the fast-forward path resets the tree with `reset --hard`,
// which would silently discard those changes, and a --no-ff merge into a dirty
// tree leaves an inconsistent state. Aborting up front keeps working changes safe.
func Merge(projectRoot, srcRef string, authorName, authorEmail string) error {
	// Already merged: srcRef is an ancestor of HEAD. Nothing is modified, so this
	// is safe even with a dirty working tree.
	alreadyMerged, err := gitIsAncestor(projectRoot, srcRef, "HEAD")
	if err != nil {
		return errtrace.Wrap(err)
	}
	if alreadyMerged {
		return nil
	}

	// Bail out before touching the tree if it has uncommitted tracked changes, so
	// the merge never overwrites or clobbers in-progress work. Untracked files are
	// left out: neither `reset --hard` nor `merge` removes them.
	dirty, err := HasUncommittedChanges(projectRoot)
	if err != nil {
		return errtrace.Wrap(err)
	}
	if dirty {
		return errtrace.Wrap(fmt.Errorf("refusing to merge: %s has uncommitted changes that would be overwritten; commit or stash them first", projectRoot))
	}

	// Fast-forward: HEAD is an ancestor of srcRef.
	canFF, err := gitIsAncestor(projectRoot, "HEAD", srcRef)
	if err != nil {
		return errtrace.Wrap(err)
	}
	if canFF {
		_, err = gitOutput(projectRoot, "reset", "--hard", srcRef)
		return errtrace.Wrap(err)
	}

	// Check for conflicting files before attempting the merge.
	conflicts, err := GetConflictingFiles(projectRoot, "HEAD", srcRef)
	if err != nil {
		return errtrace.Wrap(err)
	}
	if len(conflicts) > 0 {
		return errtrace.Wrap(fmt.Errorf("merge conflict in files: %v", conflicts))
	}

	if authorName == "" {
		authorName = "Hydra Agent"
	}
	if authorEmail == "" {
		authorEmail = "hydra@trolleyman.org"
	}

	msg := fmt.Sprintf("Merge branch '%s'", srcRef)
	cmd := exec.Command("git", "-C", projectRoot, "merge", "--no-ff", "-m", msg, srcRef)
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME="+authorName,
		"GIT_AUTHOR_EMAIL="+authorEmail,
		"GIT_COMMITTER_NAME="+authorName,
		"GIT_COMMITTER_EMAIL="+authorEmail,
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return errtrace.Wrap(fmt.Errorf("git merge: %w: %s", err, strings.TrimSpace(string(out))))
	}
	return nil
}

// MergedHydraBranches returns the set of hydra/* branch names that appear in a
// merge-commit subject ("Merge branch 'hydra/<id>'") anywhere in the repo's
// reachable history. It is used to retroactively tell merged heads apart from
// killed ones: both have their branch deleted, but only a merge leaves a merge
// commit behind. Matches the message format produced by Merge above (and the
// git default), tolerating a trailing "into <branch>".
//
// Fast-forward merges leave no merge commit, so they are NOT detected — callers
// must treat a branch's absence as "not known to be merged", never as proof it
// was killed.
func MergedHydraBranches(projectRoot string) (map[string]struct{}, error) {
	out, err := gitOutput(projectRoot, "log", "--all", "--merges", "--format=%s")
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	const prefix = "Merge branch '"
	merged := map[string]struct{}{}
	for _, line := range strings.Split(out, "\n") {
		i := strings.Index(line, prefix)
		if i < 0 {
			continue
		}
		rest := line[i+len(prefix):]
		j := strings.IndexByte(rest, '\'')
		if j < 0 {
			continue
		}
		if name := rest[:j]; strings.HasPrefix(name, "hydra/") {
			merged[name] = struct{}{}
		}
	}
	return merged, nil
}
