package git

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/common"
)

// FindProjectRoot returns the root of the git repository containing dir.
func FindProjectRoot(dir string) (string, error) {
	out, err := exec.Command("git", "-C", dir, "rev-parse", "--show-toplevel").Output()
	if err != nil {
		return "", errtrace.Wrap(fmt.Errorf("git rev-parse --show-toplevel: %w", err))
	}
	return strings.TrimSpace(string(out)), nil
}

// GetCurrentBranch returns the name of the currently checked-out branch.
func GetCurrentBranch(projectRoot string) (string, error) {
	out, err := exec.Command("git", "-C", projectRoot, "rev-parse", "--abbrev-ref", "HEAD").Output()
	if err != nil {
		return "", errtrace.Wrap(fmt.Errorf("git rev-parse: %w", err))
	}
	return strings.TrimSpace(string(out)), nil
}

// ListHydraBranches returns all branches matching hydra/*.
func ListHydraBranches(projectRoot string) ([]string, error) {
	out, err := exec.Command("git", "-C", projectRoot, "branch", "--list", "hydra/*", "--format=%(refname:short)").Output()
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("git branch --list: %w", err))
	}
	var branches []string
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			branches = append(branches, line)
		}
	}
	return branches, nil
}

// CreateWorktree runs `git worktree add -b <branchName> <path> <baseBranch>`.
func CreateWorktree(projectRoot, worktreePath, branchName, baseBranch string) error {
	worktreesDir := filepath.Dir(worktreePath)
	if err := os.MkdirAll(worktreesDir, 0755); err != nil {
		return errtrace.Wrap(fmt.Errorf("create worktree parent: %w", err))
	}

	gitignorePath := filepath.Join(worktreePath, ".gitignore")
	if _, err := os.Stat(gitignorePath); os.IsNotExist(err) {
		if err := os.WriteFile(gitignorePath, []byte("*\n"), 0644); err != nil {
			return errtrace.Wrap(fmt.Errorf("create .gitignore: %w", err))
		}
	}

	cmd := exec.Command("git", "-C", projectRoot,
		"worktree", "add", "-b", branchName, worktreePath, baseBranch)
	common.PrintExecCmd(cmd)
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
	common.PrintExecCmd(cmd)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return errtrace.Wrap(fmt.Errorf("git worktree remove: %w", err))
	}
	return nil
}

// DeleteBranch runs `git branch -D <branchName>`.
func DeleteBranch(projectRoot, branchName string) error {
	cmd := exec.Command("git", "-C", projectRoot, "branch", "-D", branchName)
	common.PrintExecCmd(cmd)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return errtrace.Wrap(fmt.Errorf("git branch -D: %w", err))
	}
	return nil
}
