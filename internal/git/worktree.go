package git

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"braces.dev/errtrace"
	"github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/plumbing"
	"github.com/trolleyman/hydra/internal/common"
	"github.com/trolleyman/hydra/internal/paths"
)

// ValidateRef checks that a git ref name cannot be mistaken for a command-line
// flag, which would allow option injection into git even when using exec.Command
// with separate arguments.
func ValidateRef(ref string) error {
	if ref == "" {
		return errtrace.Wrap(fmt.Errorf("empty ref name"))
	}
	if strings.HasPrefix(ref, "-") {
		return errtrace.Wrap(fmt.Errorf("invalid ref name %q: must not start with '-'", ref))
	}
	return nil
}

// GetCurrentBranch returns the name of the currently checked-out branch.
func GetCurrentBranch(projectRoot string) (string, error) {
	repo, err := git.PlainOpen(projectRoot)
	if err != nil {
		return "", errtrace.Wrap(err)
	}

	head, err := repo.Head()
	if err != nil {
		return "", errtrace.Wrap(err)
	}

	if head.Name().IsBranch() {
		return head.Name().Short(), nil
	}

	return head.Hash().String(), nil
}

// ListHydraBranches returns all branches matching hydra/*.
func ListHydraBranches(projectRoot string) ([]string, error) {
	repo, err := git.PlainOpen(projectRoot)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}

	iter, err := repo.Branches()
	if err != nil {
		return nil, errtrace.Wrap(err)
	}

	var branches []string
	err = iter.ForEach(func(ref *plumbing.Reference) error {
		name := ref.Name().Short()
		if strings.HasPrefix(name, "hydra/") {
			branches = append(branches, name)
		}
		return nil
	})
	if err != nil {
		return nil, errtrace.Wrap(err)
	}

	return branches, nil
}

// CreateWorktree runs `git worktree add -b <branchName> <path> <baseBranch>`.
func CreateWorktree(projectRoot, worktreePath, branchName, baseBranch string) error {
	if err := ValidateRef(branchName); err != nil {
		return errtrace.Wrap(fmt.Errorf("branch name: %w", err))
	}
	if err := ValidateRef(baseBranch); err != nil {
		return errtrace.Wrap(fmt.Errorf("base branch: %w", err))
	}
	worktreesDir := filepath.Dir(worktreePath)
	if err := paths.CreateGitignoreAllInDir(worktreesDir); err != nil {
		return errtrace.Wrap(err)
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

// DeleteBranch deletes a git branch.
func DeleteBranch(projectRoot, branchName string) error {
	if err := ValidateRef(branchName); err != nil {
		return errtrace.Wrap(fmt.Errorf("branch name: %w", err))
	}

	repo, err := git.PlainOpen(projectRoot)
	if err != nil {
		return errtrace.Wrap(err)
	}

	err = repo.Storer.RemoveReference(plumbing.NewBranchReferenceName(branchName))
	if err != nil {
		return errtrace.Wrap(fmt.Errorf("git branch -D: %w", err))
	}
	return nil
}
