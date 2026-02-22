package git

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"braces.dev/errtrace"
)

// GetCurrentBranch returns the name of the currently checked-out branch.
func GetCurrentBranch(projectRoot string) (string, error) {
	out, err := exec.Command("git", "-C", projectRoot, "rev-parse", "--abbrev-ref", "HEAD").Output()
	if err != nil {
		return "", errtrace.Wrap(fmt.Errorf("git rev-parse: %w", err))
	}
	return strings.TrimSpace(string(out)), nil
}

// CreateWorktree runs `git worktree add -b <branchName> <path> <baseBranch>`.
func CreateWorktree(projectRoot, worktreePath, branchName, baseBranch string) error {
	if err := os.MkdirAll(filepath.Dir(worktreePath), 0755); err != nil {
		return errtrace.Wrap(fmt.Errorf("create worktree parent: %w", err))
	}
	cmd := exec.Command("git", "-C", projectRoot,
		"worktree", "add", "-b", branchName, worktreePath, baseBranch)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return errtrace.Wrap(fmt.Errorf("git worktree add: %w", err))
	}
	return nil
}

// RemoveWorktree runs `git worktree remove --force <path>`.
func RemoveWorktree(projectRoot, worktreePath string) error {
	cmd := exec.Command("git", "-C", projectRoot,
		"worktree", "remove", "--force", worktreePath)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return errtrace.Wrap(fmt.Errorf("git worktree remove: %w", err))
	}
	return nil
}
