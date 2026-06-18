package paths

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// writeFile creates parent dirs and writes a file, failing the test on error.
func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestMigrateHydraLayout_MovesFlatDirs(t *testing.T) {
	root := t.TempDir()
	hydra := GetHydraDirFromProjectRoot(root)

	// Old flat layout with a couple of generated dirs and the DB.
	writeFile(t, filepath.Join(hydra, "state", "db.sqlite3"), "DBDATA")
	writeFile(t, filepath.Join(hydra, "cache", "gemini.md"), "PROMPT")
	writeFile(t, filepath.Join(hydra, "cow", "h1", "upper", "f"), "COW")
	// config.toml stays at the top level and must not move.
	writeFile(t, filepath.Join(hydra, "config.toml"), "CONFIG")

	if err := MigrateHydraLayout(root); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	// DB and generated dirs moved under .hydra/local.
	if got, err := os.ReadFile(GetDBPathFromProjectRoot(root)); err != nil || string(got) != "DBDATA" {
		t.Fatalf("db not migrated: %q err=%v", got, err)
	}
	if got, err := os.ReadFile(filepath.Join(GetCacheDirFromProjectRoot(root), "gemini.md")); err != nil || string(got) != "PROMPT" {
		t.Fatalf("cache not migrated: %q err=%v", got, err)
	}
	if _, err := os.Stat(filepath.Join(GetHydraLocalDirFromProjectRoot(root), "cow", "h1", "upper", "f")); err != nil {
		t.Fatalf("cow not migrated: %v", err)
	}

	// Old locations are gone.
	if _, err := os.Stat(filepath.Join(hydra, "state")); !os.IsNotExist(err) {
		t.Fatalf("old state dir still present: %v", err)
	}

	// config.toml untouched at the top level.
	if got, err := os.ReadFile(filepath.Join(hydra, "config.toml")); err != nil || string(got) != "CONFIG" {
		t.Fatalf("config.toml should not move: %q err=%v", got, err)
	}

	// .hydra/local self-ignores so it never surfaces in git status.
	if got, err := os.ReadFile(filepath.Join(GetHydraLocalDirFromProjectRoot(root), ".gitignore")); err != nil || strings.TrimSpace(string(got)) != "*" {
		t.Fatalf("local/.gitignore = %q err=%v, want %q", got, err, "*")
	}

	// Idempotent: a second run is a no-op and doesn't error.
	if err := MigrateHydraLayout(root); err != nil {
		t.Fatalf("second migrate: %v", err)
	}
	if got, err := os.ReadFile(GetDBPathFromProjectRoot(root)); err != nil || string(got) != "DBDATA" {
		t.Fatalf("db disturbed by second migrate: %q err=%v", got, err)
	}
}

func TestMigrateHydraLayout_ConflictLeavesOldInPlace(t *testing.T) {
	root := t.TempDir()
	hydra := GetHydraDirFromProjectRoot(root)

	// Both old and new cache exist (e.g. a half-finished prior migration). The new
	// copy must win and the old one must be left untouched rather than clobbered.
	writeFile(t, filepath.Join(hydra, "cache", "x"), "OLD")
	writeFile(t, filepath.Join(GetCacheDirFromProjectRoot(root), "x"), "NEW")

	if err := MigrateHydraLayout(root); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	if got, _ := os.ReadFile(filepath.Join(GetCacheDirFromProjectRoot(root), "x")); string(got) != "NEW" {
		t.Fatalf("new cache should be preserved, got %q", got)
	}
	if got, _ := os.ReadFile(filepath.Join(hydra, "cache", "x")); string(got) != "OLD" {
		t.Fatalf("old cache should be left in place, got %q", got)
	}
}

func TestMigrateHydraLayout_RepairsWorktrees(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}
	root := t.TempDir()

	run := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", root}, args...)...)
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
		return string(out)
	}

	run("init", "-q")
	writeFile(t, filepath.Join(root, "README"), "hi")
	run("add", "-A")
	run("commit", "-q", "-m", "init")

	// Register a worktree under the OLD flat location, as Hydra used to.
	oldWt := filepath.Join(GetHydraDirFromProjectRoot(root), "worktrees", "h1")
	run("worktree", "add", "-q", "-b", "hydra/h1", oldWt)

	if err := MigrateHydraLayout(root); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	newWt := GetWorktreeDirFromProjectRoot(root, "h1")
	if _, err := os.Stat(filepath.Join(newWt, "README")); err != nil {
		t.Fatalf("worktree not moved to new location: %v", err)
	}

	// After repair, git knows the worktree at its new path and the worktree itself
	// is functional (its git metadata links resolve).
	if list := run("worktree", "list"); !strings.Contains(list, newWt) {
		t.Fatalf("worktree list does not reference new path %s:\n%s", newWt, list)
	}
	wtCmd := exec.Command("git", "-C", newWt, "status", "--porcelain")
	if out, err := wtCmd.CombinedOutput(); err != nil {
		t.Fatalf("git status in migrated worktree failed (links not repaired): %v: %s", err, out)
	}
}
