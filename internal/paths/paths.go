package paths

import (
	"fmt"
	"log"
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

// GetHydraLocalDirFromProjectRoot returns .hydra/local, the single parent holding
// every generated, never-committed thing (worktrees, the SQLite DB, caches, COW
// layers, ...). Only .hydra/config.toml lives at the .hydra top level. Each
// subdirectory self-ignores via a "*" .gitignore, so the whole tree stays out of
// the project's git status. See MigrateHydraLayout for the one-time move of
// projects created under the old flat layout.
func GetHydraLocalDirFromProjectRoot(projectRoot string) string {
	return filepath.Join(GetHydraDirFromProjectRoot(projectRoot), "local")
}

func GetWorktreesDirFromProjectRoot(projectRoot string) string {
	return filepath.Join(GetHydraLocalDirFromProjectRoot(projectRoot), "worktrees")
}

func GetWorktreeDirFromProjectRoot(projectRoot, id string) string {
	return filepath.Join(GetWorktreesDirFromProjectRoot(projectRoot), id)
}

func GetStateDirFromProjectRoot(projectRoot string) string {
	return filepath.Join(GetHydraLocalDirFromProjectRoot(projectRoot), "state")
}

// GetArtifactsDirFromProjectRoot returns the (gitignored) directory holding
// generated diff artifacts (screenshots etc.) and their ephemeral checkouts.
func GetArtifactsDirFromProjectRoot(projectRoot string) string {
	return filepath.Join(GetHydraLocalDirFromProjectRoot(projectRoot), "artifacts")
}

// GetUploadsDirFromProjectRoot returns the (gitignored) directory holding files
// pasted/attached to prompts. It sits under .hydra/local so it's readable
// read-only inside agent sandboxes at the same absolute path.
func GetUploadsDirFromProjectRoot(projectRoot string) string {
	return filepath.Join(GetHydraLocalDirFromProjectRoot(projectRoot), "uploads")
}

// GetCacheDirFromProjectRoot returns the (gitignored) directory holding generated
// caches (e.g. the captured Gemini default system prompt, keyed by CLI version).
func GetCacheDirFromProjectRoot(projectRoot string) string {
	return filepath.Join(GetHydraLocalDirFromProjectRoot(projectRoot), "cache")
}

func GetDBPathFromProjectRoot(projectRoot string) string {
	return filepath.Join(GetStateDirFromProjectRoot(projectRoot), "db.sqlite3")
}

func GetStatusDirFromProjectRoot(projectRoot string) string {
	return filepath.Join(GetHydraLocalDirFromProjectRoot(projectRoot), "status")
}

func GetStatusJsonFromProjectRoot(projectRoot, id string) string {
	return filepath.Join(GetStatusDirFromProjectRoot(projectRoot), id+".json")
}

func GetStatusLogFromProjectRoot(projectRoot, id string) string {
	return filepath.Join(GetStatusDirFromProjectRoot(projectRoot), id+"_log.jsonl")
}

func GetBuildLogFromProjectRoot(projectRoot, id string) string {
	return filepath.Join(GetStatusDirFromProjectRoot(projectRoot), id+"_build.log")
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

// hydraLocalSubdirs are the generated .hydra subdirectories that used to sit at
// the .hydra top level and now live under .hydra/local. MigrateHydraLayout moves
// any it finds at the old location.
var hydraLocalSubdirs = []string{"worktrees", "state", "artifacts", "uploads", "status", "cache", "cow"}

// MigrateHydraLayout moves a project created under the old flat layout
// (.hydra/<dir>) into the consolidated one (.hydra/local/<dir>). It is idempotent
// and best-effort per directory: a directory already present at the new location
// is left untouched. Worktrees record absolute git metadata links, so after
// moving them we run `git worktree repair` to re-point the registrations.
//
// Called from db.Open (covers the boot project + CLI commands) and per-project at
// daemon boot / on AddProject, so every project is migrated before its worktrees
// or DB are used.
func MigrateHydraLayout(projectRoot string) error {
	hydra := GetHydraDirFromProjectRoot(projectRoot)
	local := GetHydraLocalDirFromProjectRoot(projectRoot)

	movedWorktrees := false
	for _, name := range hydraLocalSubdirs {
		oldPath := filepath.Join(hydra, name)
		newPath := filepath.Join(local, name)
		info, err := os.Stat(oldPath)
		if err != nil || !info.IsDir() {
			continue // nothing at the old location
		}
		if _, err := os.Stat(newPath); err == nil {
			// Already migrated (or a partial state) — don't clobber the new copy.
			log.Printf("warn: hydra layout: both %s and %s exist; leaving the old one in place", oldPath, newPath)
			continue
		}
		if err := os.MkdirAll(local, 0o755); err != nil {
			return errtrace.Wrap(fmt.Errorf("create %s: %w", local, err))
		}
		if err := os.Rename(oldPath, newPath); err != nil {
			return errtrace.Wrap(fmt.Errorf("move %s -> %s: %w", oldPath, newPath, err))
		}
		log.Printf("hydra layout: migrated .hydra/%s -> .hydra/local/%s in %s", name, name, projectRoot)
		if name == "worktrees" {
			movedWorktrees = true
		}
	}

	if movedWorktrees {
		if err := repairMovedWorktrees(projectRoot, filepath.Join(local, "worktrees")); err != nil {
			// Non-fatal: the worktrees still work; only their git metadata links are
			// stale until repaired. Surface it so it can be fixed manually if needed.
			log.Printf("warn: hydra layout: git worktree repair in %s: %v", projectRoot, err)
		}
	}

	// Belt-and-suspenders: ensure .hydra/local itself self-ignores once it exists,
	// so the parent never surfaces even if a future subdir forgets its .gitignore.
	if _, err := os.Stat(local); err == nil {
		if err := CreateGitignoreAllInDir(local); err != nil {
			return errtrace.Wrap(err)
		}
	}
	return nil
}

// repairMovedWorktrees re-points the git worktree registrations after their
// directories were moved under .hydra/local. `git worktree repair <path>...`,
// run from the main worktree, rewrites the stale absolute gitdir links.
func repairMovedWorktrees(projectRoot, worktreesDir string) error {
	entries, err := os.ReadDir(worktreesDir)
	if err != nil {
		return errtrace.Wrap(err)
	}
	args := []string{"-C", projectRoot, "worktree", "repair"}
	for _, e := range entries {
		if e.IsDir() {
			args = append(args, filepath.Join(worktreesDir, e.Name()))
		}
	}
	if len(args) == 4 { // no worktree dirs to repair
		return nil
	}
	if out, err := exec.Command("git", args...).CombinedOutput(); err != nil {
		return errtrace.Wrap(fmt.Errorf("git worktree repair: %w: %s", err, strings.TrimSpace(string(out))))
	}
	return nil
}
