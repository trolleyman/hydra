package paths

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"braces.dev/errtrace"
)

var cwdProjectRoot *string

// NormalizePath returns an absolute, symlink-resolved path with forward slashes.
func NormalizePath(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	eval, err := filepath.EvalSymlinks(abs)
	var final string
	if err != nil {
		// If the path doesn't exist, EvalSymlinks fails. We still want a normalized path.
		final = abs
	} else {
		final = eval
	}

	return filepath.ToSlash(final), nil
}

// ComparePaths compares two paths using platform-appropriate rules.
// On Windows it is case-insensitive; on other platforms it is case-sensitive.
func ComparePaths(p1, p2 string) bool {
	if runtime.GOOS == "windows" {
		return strings.EqualFold(p1, p2)
	}
	return p1 == p2
}

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
	norm, err := NormalizePath(projectRoot)
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	cwdProjectRoot = &norm
	return norm, nil
}

// GetProjectRoot returns the root of the git repository containing dir.
func GetProjectRoot(dir string) (string, error) {
	out, err := exec.Command("git", "-C", dir, "rev-parse", "--show-toplevel").Output()
	if err != nil {
		return "", errtrace.Wrap(fmt.Errorf("git open: not a git repository"))
	}
	return NormalizePath(strings.TrimRight(string(out), "\n"))
}

func GetHydraDirFromProjectRoot(projectRoot string) string {
	return filepath.Join(projectRoot, ".hydra")
}

func GetWorktreesDirFromProjectRoot(projectRoot string) string {
	return filepath.Join(GetHydraDirFromProjectRoot(projectRoot), "worktrees")
}

func GetWorktreeDirFromProjectRoot(projectRoot, id string) string {
	return filepath.Join(GetWorktreesDirFromProjectRoot(projectRoot), id)
}

func GetStateDirFromProjectRoot(projectRoot string) string {
	return filepath.Join(GetHydraDirFromProjectRoot(projectRoot), "state")
}

func GetDBPathFromProjectRoot(projectRoot string) string {
	return filepath.Join(GetStateDirFromProjectRoot(projectRoot), "db.sqlite3")
}

func GetStatusJsonFromProjectRoot(projectRoot, id string) string {
	return filepath.Join(GetHydraDirFromProjectRoot(projectRoot), "status", id+".json")
}

func GetStatusLogFromProjectRoot(projectRoot, id string) string {
	return filepath.Join(GetHydraDirFromProjectRoot(projectRoot), "status", id+"_log.jsonl")
}

func GetBuildLogFromProjectRoot(projectRoot, id string) string {
	return filepath.Join(GetHydraDirFromProjectRoot(projectRoot), "status", id+"_build.log")
}

// WriteFileIfChanged writes content to path only when it differs from the existing file.
// Reports whether the file was (over)written.
func WriteFileIfChanged(path, content string, perm os.FileMode) error {
	existing, err := os.ReadFile(path)
	if err == nil && string(existing) == content {
		return nil // already up to date
	}
	return errtrace.Wrap(os.WriteFile(path, []byte(content), perm))
}

// CreateGitignoreAllInDir adds a .gitignore in the specified directory that ignores all files in that directory
func CreateGitignoreAllInDir(dir string) error {
	if err := os.MkdirAll(dir, 0755); err != nil {
		return errtrace.Wrap(fmt.Errorf("create dir: %w: %s", err, dir))
	}

	gitignorePath := filepath.Join(dir, ".gitignore")
	if _, err := os.Stat(gitignorePath); os.IsNotExist(err) {
		if err := os.WriteFile(gitignorePath, []byte("*\n"), 0644); err != nil {
			return errtrace.Wrap(fmt.Errorf("create .gitignore: %w: %s", err, gitignorePath))
		}
	}
	return nil
}
