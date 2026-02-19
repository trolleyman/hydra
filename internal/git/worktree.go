package git

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/cockroachdb/errors"
)

func FindProjectRootFromCwd() (string, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return "", errors.Wrapf(err, "get working directory")
	}
	return FindProjectRoot(cwd)
}

// FindProjectRoot walks up from dir until it finds a .git directory.
func FindProjectRoot(dir string) (string, error) {
	current := dir
	for {
		if _, err := os.Stat(filepath.Join(current, ".git")); err == nil {
			return current, nil
		}
		parent := filepath.Dir(current)
		if parent == current {
			return "", errors.Errorf("not inside a git repository")
		}
		current = parent
	}
}

// SlugFromPrompt converts a prompt string into a git-branch-safe slug.
// The result is prefixed with "agent/".
func SlugFromPrompt(prompt string) string {
	slug := strings.ToLower(prompt)
	re := regexp.MustCompile(`[^a-z0-9]+`)
	slug = re.ReplaceAllString(slug, "-")
	slug = strings.Trim(slug, "-")
	if len(slug) > 50 {
		slug = slug[:50]
		slug = strings.TrimRight(slug, "-")
	}
	return "agent/" + slug
}

// GetCurrentBranch returns the name of the currently checked-out branch.
func GetCurrentBranch(projectRoot string) (string, error) {
	out, err := exec.Command("git", "-C", projectRoot, "rev-parse", "--abbrev-ref", "HEAD").Output()
	if err != nil {
		return "", errors.Wrapf(err, "git rev-parse")
	}
	return strings.TrimSpace(string(out)), nil
}

// CreateWorktree runs `git worktree add -b <branchName> <path> <baseBranch>`.
func CreateWorktree(projectRoot, worktreePath, branchName, baseBranch string) error {
	if err := os.MkdirAll(filepath.Dir(worktreePath), 0755); err != nil {
		return errors.Wrapf(err, "create worktree parent")
	}
	cmd := exec.Command("git", "-C", projectRoot,
		"worktree", "add", "-b", branchName, worktreePath, baseBranch)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return errors.Wrapf(err, "git worktree add")
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
		return errors.Wrapf(err, "git worktree remove")
	}
	return nil
}

// InferProjectRoot derives the project root from a worktree path created by Hydra.
// Convention: <projectRoot>/.hydra/worktrees/<slug>
func InferProjectRoot(worktreePath string) string {
	return filepath.Dir(filepath.Dir(filepath.Dir(worktreePath)))
}
