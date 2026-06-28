package git

import (
	"fmt"
	"os"
	"os/exec"
	"strings"

	"braces.dev/errtrace"
)

// DirtyMergeError is returned by Merge when the destination working tree has
// uncommitted changes to tracked files that the merge would overwrite. It names
// the offending files so callers can surface them. Only files the merge actually
// touches are reported: uncommitted changes to unrelated files do not block the
// merge and are preserved.
type DirtyMergeError struct {
	Files []string
}

func (e *DirtyMergeError) Error() string {
	return fmt.Sprintf("uncommitted local changes to %s would be overwritten by the merge; commit or stash them first", strings.Join(e.Files, ", "))
}

// Merge performs a git merge of srcRef into the current HEAD.
// Uses fast-forward when possible, otherwise performs a --no-ff merge commit.
// Returns an error if there are conflicting files.
//
// Merge refuses to run only when the destination working tree has uncommitted
// changes to tracked files that the merge would overwrite — i.e. files the merge
// brings in. Uncommitted changes to files the merge does not touch are preserved
// (the fast-forward path uses `merge --ff-only` rather than `reset --hard`, which
// would discard them). A merge that would clobber such files returns a
// *DirtyMergeError naming them, so the cause is distinct from a real content
// conflict between the two branches.
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

	// Refuse only when an uncommitted tracked change overlaps a file the merge
	// would write into the tree, so in-progress work the merge would clobber is
	// never silently lost — but unrelated edits don't needlessly block the merge.
	// Untracked files are left out: neither `merge --ff-only` nor `merge` removes
	// them.
	dirtyFiles, err := uncommittedTrackedFiles(projectRoot)
	if err != nil {
		return errtrace.Wrap(err)
	}
	if len(dirtyFiles) > 0 {
		// Files the merge brings into the destination tree: everything changed
		// between the merge base and srcRef. For a fast-forward the merge base is
		// HEAD, so this is HEAD..srcRef. Files changed only on the HEAD side keep
		// HEAD's version and so are not overwritten.
		incoming, err := mergeIncomingFiles(projectRoot, "HEAD", srcRef)
		if err != nil {
			return errtrace.Wrap(err)
		}
		if clobbered := intersectPaths(dirtyFiles, incoming); len(clobbered) > 0 {
			return errtrace.Wrap(&DirtyMergeError{Files: clobbered})
		}
	}

	// Fast-forward: HEAD is an ancestor of srcRef.
	canFF, err := gitIsAncestor(projectRoot, "HEAD", srcRef)
	if err != nil {
		return errtrace.Wrap(err)
	}
	if canFF {
		// `merge --ff-only` advances HEAD and the working tree like `reset --hard`
		// would, but keeps uncommitted changes to files the merge doesn't touch
		// (reset would discard them). The overlap check above already guaranteed no
		// dirty file is among the updated ones, so this cannot clobber work.
		_, err = gitOutput(projectRoot, "merge", "--ff-only", srcRef)
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

// uncommittedTrackedFiles returns the paths of tracked files with staged or
// unstaged changes in dir. Untracked files are excluded: a merge neither reads
// nor removes them. core.quotePath=false keeps non-ASCII paths verbatim so they
// match the diff output used to detect overlap.
func uncommittedTrackedFiles(dir string) ([]string, error) {
	out, err := gitOutput(dir, "-c", "core.quotePath=false", "status", "--porcelain=v1")
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	var files []string
	for line := range strings.SplitSeq(out, "\n") {
		if len(line) < 4 {
			continue
		}
		if line[0] == '?' && line[1] == '?' {
			continue // untracked
		}
		// Porcelain v1: "XY <path>"; a rename is "XY <old> -> <new>" — the new path
		// is what exists in the tree and what the merge would touch.
		path := line[3:]
		if i := strings.Index(path, " -> "); i >= 0 {
			path = path[i+len(" -> "):]
		}
		files = append(files, path)
	}
	return files, nil
}

// mergeIncomingFiles returns the files changed between the merge base of baseRef
// and srcRef and srcRef itself — i.e. the changes the merge would bring into the
// destination tree. The "..." range resolves to that merge base.
func mergeIncomingFiles(dir, baseRef, srcRef string) ([]string, error) {
	out, err := gitOutput(dir, "-c", "core.quotePath=false", "diff", "--name-only", baseRef+"..."+srcRef)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	var files []string
	for line := range strings.SplitSeq(out, "\n") {
		if line != "" {
			files = append(files, line)
		}
	}
	return files, nil
}

// intersectPaths returns the entries of a that also appear in b, preserving a's
// order and without duplicates.
func intersectPaths(a, b []string) []string {
	set := make(map[string]struct{}, len(b))
	for _, p := range b {
		set[p] = struct{}{}
	}
	var out []string
	seen := map[string]struct{}{}
	for _, p := range a {
		if _, ok := set[p]; !ok {
			continue
		}
		if _, dup := seen[p]; dup {
			continue
		}
		seen[p] = struct{}{}
		out = append(out, p)
	}
	return out
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
