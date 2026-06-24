package heads

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/paths"
)

// gitRepoOnMain creates a temp git repo with a single commit on branch "main".
func gitRepoOnMain(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@e",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@e")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	run("init", "-q")
	run("checkout", "-q", "-b", "main")
	if err := os.WriteFile(filepath.Join(dir, "base.txt"), []byte("base\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", ".")
	run("commit", "-qm", "base")
	return dir
}

func TestResolveMergeDir(t *testing.T) {
	// Case A: the target is the project root's current branch → use the root, no cleanup.
	t.Run("current branch uses project root", func(t *testing.T) {
		root := gitRepoOnMain(t)
		dir, cleanup, err := ResolveMergeDir(root, "main")
		if err != nil {
			t.Fatalf("ResolveMergeDir: %v", err)
		}
		defer cleanup()
		if dir != root {
			t.Errorf("expected project root %q, got %q", root, dir)
		}
	})

	// Case B: the target is checked out nowhere → a throwaway worktree is created,
	// and cleanup removes it.
	t.Run("unchecked-out branch uses a temp worktree", func(t *testing.T) {
		root := gitRepoOnMain(t)
		// Create "other" but stay on main, so "other" is checked out nowhere.
		cmd := exec.Command("git", "-C", root, "branch", "other")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git branch other: %v\n%s", err, out)
		}
		dir, cleanup, err := ResolveMergeDir(root, "other")
		if err != nil {
			t.Fatalf("ResolveMergeDir: %v", err)
		}
		if dir == root {
			t.Fatalf("expected a temp worktree, got project root")
		}
		if _, err := os.Stat(dir); err != nil {
			t.Fatalf("temp worktree should exist: %v", err)
		}
		cleanup()
		if _, err := os.Stat(dir); !os.IsNotExist(err) {
			t.Errorf("temp worktree should be removed after cleanup, stat err=%v", err)
		}
	})

	// Case C: the target is an agent branch with an existing worktree → use it.
	t.Run("agent branch uses its worktree", func(t *testing.T) {
		root := gitRepoOnMain(t)
		wt := paths.GetWorktreeDirFromProjectRoot(root, "child")
		if err := git.CreateWorktree(root, wt, "hydra/child", "main"); err != nil {
			t.Fatalf("CreateWorktree: %v", err)
		}
		dir, cleanup, err := ResolveMergeDir(root, "hydra/child")
		if err != nil {
			t.Fatalf("ResolveMergeDir: %v", err)
		}
		defer cleanup()
		if dir != wt {
			t.Errorf("expected parent worktree %q, got %q", wt, dir)
		}
	})
}
