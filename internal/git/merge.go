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
func Merge(projectRoot, srcRef string, authorName, authorEmail string) error {
	// Already merged: srcRef is an ancestor of HEAD.
	alreadyMerged, err := gitIsAncestor(projectRoot, srcRef, "HEAD")
	if err != nil {
		return errtrace.Wrap(err)
	}
	if alreadyMerged {
		return nil
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
