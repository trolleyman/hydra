package git

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func gitRun(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

// initMainRepo makes a main repo with one commit on `main`, returns its path.
func initMainRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	gitRun(t, dir, "init", "-q", "-b", "main")
	gitRun(t, dir, "config", "commit.gpgsign", "false")
	if err := os.WriteFile(filepath.Join(dir, "base.txt"), []byte("base\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitRun(t, dir, "add", "-A")
	gitRun(t, dir, "commit", "-q", "-m", "base")
	return dir
}

func TestCloneWorktreeLifecycle(t *testing.T) {
	main := initMainRepo(t)
	wt := filepath.Join(t.TempDir(), "wt")
	const branch = "hydra/x"

	if err := CreateCloneWorktree(main, wt, branch, "main"); err != nil {
		t.Fatalf("CreateCloneWorktree: %v", err)
	}

	// It's a standalone clone (own .git dir), borrowing main's objects.
	if !IsCloneWorktree(wt) {
		t.Fatal("expected a standalone clone (.git dir)")
	}
	if _, err := os.Stat(filepath.Join(wt, ".git", "objects", "info", "alternates")); err != nil {
		t.Errorf("expected an alternates file borrowing main's objects: %v", err)
	}
	// The mirror ref exists in main from creation (before any commit).
	if !BranchExists(main, branch) {
		t.Fatal("branch not mirrored into main at creation")
	}
	// The worktree checked out the base content.
	if _, err := os.Stat(filepath.Join(wt, "base.txt")); err != nil {
		t.Errorf("base content not checked out: %v", err)
	}

	// The agent commits NATIVELY in its own repo.
	if err := os.WriteFile(filepath.Join(wt, "feature.txt"), []byte("hi\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitRun(t, wt, "add", "-A")
	gitRun(t, wt, "commit", "-q", "-m", "agent work")
	headTip, _ := gitOutput(wt, "rev-parse", branch)

	// Before mirroring, main is stale.
	if mainTip, _ := gitOutput(main, "rev-parse", branch); mainTip == headTip {
		t.Fatal("main should be stale before mirror")
	}
	// MirrorCloneBranch brings main's ref + objects up to date.
	if err := MirrorCloneBranch(main, wt, branch); err != nil {
		t.Fatalf("MirrorCloneBranch: %v", err)
	}
	if mainTip, _ := gitOutput(main, "rev-parse", branch); mainTip != headTip {
		t.Fatalf("main tip %q != head tip %q after mirror", mainTip, headTip)
	}
	// Main can now read the agent's commit + its files (objects transferred).
	out, _ := gitOutput(main, "log", "-1", "--pretty=%s", branch)
	if out != "agent work" {
		t.Errorf("main log = %q, want 'agent work'", out)
	}

	// A second mirror is a cheap no-op (tips already match).
	if err := MirrorCloneBranch(main, wt, branch); err != nil {
		t.Errorf("idempotent mirror: %v", err)
	}

	// Teardown removes the clone dir (git worktree remove would reject it).
	if err := RemoveWorktreeTree(main, wt); err != nil {
		t.Fatalf("RemoveWorktreeTree: %v", err)
	}
	if _, err := os.Stat(wt); !os.IsNotExist(err) {
		t.Errorf("clone dir not removed: %v", err)
	}
}

// MirrorCloneBranch must be a no-op for a linked worktree (shared .git).
func TestMirrorCloneBranchNoopForLinkedWorktree(t *testing.T) {
	main := initMainRepo(t)
	wt := filepath.Join(t.TempDir(), "linked")
	if err := CreateWorktree(main, wt, "hydra/y", "main"); err != nil {
		t.Fatalf("CreateWorktree: %v", err)
	}
	if IsCloneWorktree(wt) {
		t.Error("linked worktree misdetected as a clone")
	}
	if err := MirrorCloneBranch(main, wt, "hydra/y"); err != nil {
		t.Errorf("mirror should no-op for a linked worktree, got %v", err)
	}
}
