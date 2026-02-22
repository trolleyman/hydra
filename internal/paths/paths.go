package paths

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"

	"braces.dev/errtrace"
)

var cwdProjectRoot *string

// GetProjectRootFromCwd gets the git directory from the current directory
func GetProjectRootFromCwd() (string, error) {
	if cwdProjectRoot != nil {
		return *cwdProjectRoot, nil
	}
	cwd, err := os.Getwd()
	if err != nil {
		return "", errtrace.Wrap(fmt.Errorf("get working directory: %w", err))
	}
	projectRoot, err := GetProjectRoot(cwd)
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	cwdProjectRoot = &projectRoot
	return projectRoot, nil
}

// GetProjectRoot gets the git directory from a directory
func GetProjectRoot(dir string) (string, error) {
	output, err := exec.Command("git", "-C", dir, "rev-parse", "--git-dir").Output()
	if err != nil {
		return "", errtrace.Wrap(fmt.Errorf("git rev-parse -C %q --git-dir: %w", dir, err))
	}
	return filepath.Join(dir, string(output)), nil
}

func GetHydraDirFromProjectRoot(projectRoot string) string {
	return filepath.Join(projectRoot, ".hydra")
}

func GetWorktreeDirFromProjectRoot(projectRoot string) string {
	return filepath.Join(GetHydraDirFromProjectRoot(projectRoot), "worktrees")
}
