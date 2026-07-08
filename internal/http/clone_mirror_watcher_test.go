package http

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/paths"
)

// TestMirrorCloneHeads exercises the daemon side of clone mode: a commit in a
// clone head's standalone worktree is picked up by the worktrees scan and
// mirrored into the main repo, where diffs/merge read it.
func TestMirrorCloneHeads(t *testing.T) {
	main := t.TempDir()
	run := func(dir string, args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	run(main, "init", "-q", "-b", "main")
	run(main, "config", "commit.gpgsign", "false")
	if err := os.WriteFile(filepath.Join(main, "base.txt"), []byte("b\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run(main, "add", "-A")
	run(main, "commit", "-q", "-m", "base")

	const id = "head-1"
	wt := paths.GetWorktreeDirFromProjectRoot(main, id)
	if err := git.CreateCloneWorktree(main, wt, git.BranchName(id), "main"); err != nil {
		t.Fatalf("CreateCloneWorktree: %v", err)
	}

	// Agent commits natively in its own repo; main doesn't see it yet.
	if err := os.WriteFile(filepath.Join(wt, "f.txt"), []byte("x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run(wt, "add", "-A")
	run(wt, "commit", "-q", "-m", "agent work")

	// The watcher scan mirrors it into main.
	mirrorCloneHeads(main)

	subj, _ := exec.Command("git", "-C", main, "log", "-1", "--pretty=%s", git.BranchName(id)).Output()
	if got := string(subj); got != "agent work\n" {
		t.Fatalf("main did not receive the clone commit: log=%q", got)
	}
}
