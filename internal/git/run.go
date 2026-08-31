package git

import (
	"errors"
	"fmt"
	"os/exec"
	"strings"

	"braces.dev/errtrace"
)

// gitOutput runs git with the given args in dir, returns stdout trimmed of trailing newlines.
// Returns an error if git exits with a non-zero status.
func gitOutput(dir string, args ...string) (string, error) {
	out, err := exec.Command("git", append([]string{"-C", dir}, args...)...).Output()
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return "", errtrace.Wrap(fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, exitErr.Stderr))
		}
		return "", errtrace.Wrap(fmt.Errorf("git %s: %w", strings.Join(args, " "), err))
	}
	return strings.TrimRight(string(out), "\n"), nil
}

// IsAncestor reports whether ancestor is a reachable ancestor of descendant (or
// the same commit) in the repo at projectRoot - i.e. descendant can fast-forward
// from ancestor. Exported wrapper around gitIsAncestor.
func IsAncestor(projectRoot, ancestor, descendant string) (bool, error) {
	return errtrace.Wrap2(gitIsAncestor(projectRoot, ancestor, descendant))
}

// IsDirectAmend reports whether oldHead was replaced directly by newHead via
// `git commit --amend`. The topology alone cannot distinguish an amend from a
// checkout/reset to a sibling commit with the same parent, so require Git's two
// latest HEAD reflog entries to describe that exact transition.
func IsDirectAmend(projectRoot, oldHead, newHead string) bool {
	out, err := gitOutput(projectRoot, "reflog", "show", "-2", "--format=%H%x1f%gs", "HEAD")
	if err != nil {
		return false
	}
	lines := strings.Split(out, "\n")
	if len(lines) < 2 {
		return false
	}
	latest := strings.SplitN(lines[0], "\x1f", 2)
	previous := strings.SplitN(lines[1], "\x1f", 2)
	return len(latest) == 2 && len(previous) == 2 &&
		latest[0] == newHead && previous[0] == oldHead &&
		strings.HasPrefix(latest[1], "commit (amend):")
}

// gitIsAncestor returns true if ancestor is a reachable ancestor of descendant
// (or if they are the same commit). Uses `git merge-base --is-ancestor`.
func gitIsAncestor(dir, ancestor, descendant string) (bool, error) {
	err := exec.Command("git", "-C", dir, "merge-base", "--is-ancestor", ancestor, descendant).Run()
	if err == nil {
		return true, nil
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) && exitErr.ExitCode() == 1 {
		return false, nil
	}
	return false, errtrace.Wrap(err)
}
