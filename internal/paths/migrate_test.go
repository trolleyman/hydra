package paths

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/trolleyman/hydra/internal/statepath"
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

func TestEnsureHydraLocalIgnored_WritesAtLocalRoot(t *testing.T) {
	root := t.TempDir()
	sub := GetStateDirFromProjectRoot(root) // .hydra/local/state

	if err := EnsureHydraLocalIgnored(sub); err != nil {
		t.Fatalf("ensure: %v", err)
	}

	// The subdir is created...
	if info, err := os.Stat(sub); err != nil || !info.IsDir() {
		t.Fatalf("subdir not created: %v", err)
	}
	// ...but the "*" .gitignore lives at the .hydra/local root, not in the subdir.
	local := GetHydraLocalDirFromProjectRoot(root)
	if got, err := os.ReadFile(filepath.Join(local, ".gitignore")); err != nil || strings.TrimSpace(string(got)) != "*" {
		t.Fatalf("local/.gitignore = %q err=%v, want %q", got, err, "*")
	}
	if _, err := os.Stat(filepath.Join(sub, ".gitignore")); !os.IsNotExist(err) {
		t.Fatalf("subdir should not carry its own .gitignore, got err=%v", err)
	}
}

func TestMigrateHydraLayout_RemovesRedundantSubdirGitignores(t *testing.T) {
	root := t.TempDir()
	local := GetHydraLocalDirFromProjectRoot(root)

	// Simulate an older layout where each subdir dropped its own "*" .gitignore.
	writeFile(t, filepath.Join(local, "state", ".gitignore"), "*\n")
	writeFile(t, filepath.Join(local, "cache", ".gitignore"), "*\n")
	// A subdir with a real ignore file (not just "*") must be left untouched.
	writeFile(t, filepath.Join(local, "keep", ".gitignore"), "!important\n*\n")

	if err := MigrateHydraLayout(root); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	// The single root ignore exists...
	if got, err := os.ReadFile(filepath.Join(local, ".gitignore")); err != nil || strings.TrimSpace(string(got)) != "*" {
		t.Fatalf("local/.gitignore = %q err=%v, want %q", got, err, "*")
	}
	// ...and the redundant per-subdir "*" ignores are gone.
	for _, name := range []string{"state", "cache"} {
		if _, err := os.Stat(filepath.Join(local, name, ".gitignore")); !os.IsNotExist(err) {
			t.Fatalf("%s/.gitignore should have been removed, got err=%v", name, err)
		}
	}
	// The non-trivial ignore is preserved.
	if _, err := os.Stat(filepath.Join(local, "keep", ".gitignore")); err != nil {
		t.Fatalf("keep/.gitignore should be preserved: %v", err)
	}
}

func TestClaudeProjectsSlug(t *testing.T) {
	// Mirrors Claude Code's ~/.claude/projects/<slug> encoding: every
	// non-alphanumeric character becomes '-', with no collapsing of runs (so the
	// '/.' before a dotdir yields '--'). Verified against a real projects dir.
	cases := map[string]string{
		"/home/callum/code/hydra/.hydra/local/worktrees/x": "-home-callum-code-hydra--hydra-local-worktrees-x",
		"/home/u/code/hydra": "-home-u-code-hydra",
		"abc123":             "abc123",
		"":                   "",
	}
	for in, want := range cases {
		if got := ClaudeProjectsSlug(in); got != want {
			t.Errorf("ClaudeProjectsSlug(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestMigrateClaudeSessionDirsIn(t *testing.T) {
	root := t.TempDir()
	projectsDir := filepath.Join(root, "projects")
	oldWorktreesDir := filepath.Join(GetHydraDirFromProjectRoot(root), "worktrees")
	newWorktreesDir := filepath.Join(GetHydraLocalDirFromProjectRoot(root), "worktrees")

	// h1: has Claude history at the old slug - must move to the new slug.
	// h2: present worktree but no Claude history - must be skipped, no error.
	writeFile(t, filepath.Join(newWorktreesDir, "h1", ".keep"), "")
	writeFile(t, filepath.Join(newWorktreesDir, "h2", ".keep"), "")
	oldSlug := ClaudeProjectsSlug(filepath.Join(oldWorktreesDir, "h1"))
	newSlug := ClaudeProjectsSlug(filepath.Join(newWorktreesDir, "h1"))
	writeFile(t, filepath.Join(projectsDir, oldSlug, "session.jsonl"), "CONVO")

	if err := migrateClaudeSessionDirsIn(projectsDir, oldWorktreesDir, newWorktreesDir); err != nil {
		t.Fatalf("migrate session dirs: %v", err)
	}

	if got, err := os.ReadFile(filepath.Join(projectsDir, newSlug, "session.jsonl")); err != nil || string(got) != "CONVO" {
		t.Fatalf("session not migrated to new slug: %q err=%v", got, err)
	}
	if _, err := os.Stat(filepath.Join(projectsDir, oldSlug)); !os.IsNotExist(err) {
		t.Fatalf("old slug dir should be gone: %v", err)
	}

	// Idempotent: a second run finds nothing at the old slug and is a no-op.
	if err := migrateClaudeSessionDirsIn(projectsDir, oldWorktreesDir, newWorktreesDir); err != nil {
		t.Fatalf("second migrate: %v", err)
	}
}

func TestMigrateClaudeSessionDirsIn_ConflictLeavesOldInPlace(t *testing.T) {
	root := t.TempDir()
	projectsDir := filepath.Join(root, "projects")
	oldWorktreesDir := filepath.Join(GetHydraDirFromProjectRoot(root), "worktrees")
	newWorktreesDir := filepath.Join(GetHydraLocalDirFromProjectRoot(root), "worktrees")

	writeFile(t, filepath.Join(newWorktreesDir, "h1", ".keep"), "")
	oldSlug := ClaudeProjectsSlug(filepath.Join(oldWorktreesDir, "h1"))
	newSlug := ClaudeProjectsSlug(filepath.Join(newWorktreesDir, "h1"))
	// History already exists at the new slug (e.g. a post-move session). The old
	// one must be left untouched rather than clobbered.
	writeFile(t, filepath.Join(projectsDir, oldSlug, "s.jsonl"), "OLD")
	writeFile(t, filepath.Join(projectsDir, newSlug, "s.jsonl"), "NEW")

	if err := migrateClaudeSessionDirsIn(projectsDir, oldWorktreesDir, newWorktreesDir); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	if got, _ := os.ReadFile(filepath.Join(projectsDir, newSlug, "s.jsonl")); string(got) != "NEW" {
		t.Fatalf("new session should be preserved, got %q", got)
	}
	if got, _ := os.ReadFile(filepath.Join(projectsDir, oldSlug, "s.jsonl")); string(got) != "OLD" {
		t.Fatalf("old session should be left in place, got %q", got)
	}
}

func TestProjectStateDirUsesRegisteredProjectID(t *testing.T) {
	root := t.TempDir()
	stateRoot := t.TempDir()
	t.Setenv("HYDRA_STATE_DIR", stateRoot)
	if got := GetProjectStateDirFromProjectRoot(root); got != GetHydraLocalDirFromProjectRoot(root) {
		t.Fatalf("unregistered project root = %q, want %q", got, GetHydraLocalDirFromProjectRoot(root))
	}

	statepath.RegisterProject("stable-id", root)
	want := filepath.Join(stateRoot, "projects", "stable-id")
	if got := GetProjectStateDirFromProjectRoot(root); got != want {
		t.Fatalf("registered project root = %q, want %q", got, want)
	}
}
