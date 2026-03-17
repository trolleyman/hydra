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
