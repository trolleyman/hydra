package git

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/trolleyman/hydra/internal/gitq"
)

// opRepo makes a temp repo on hydra/test with an initial commit, returning its
// path and a run() helper for driving git in it with a fixed identity.
func opRepo(t *testing.T) (string, func(...string) string) {
	t.Helper()
	dir := t.TempDir()
	run := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	run("init", "-q")
	run("config", "commit.gpgsign", "false")
	run("checkout", "-q", "-b", "hydra/test")
	if err := os.WriteFile(filepath.Join(dir, "seed.txt"), []byte("seed\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", "-A")
	run("commit", "-q", "-m", "seed")
	return dir, run
}

func write(t *testing.T, dir, name, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestGuardedResetSoftUncommit(t *testing.T) {
	dir, run := opRepo(t)
	write(t, dir, "a.txt", "a\n")
	run("add", "-A")
	run("commit", "-q", "-m", "add a")
	before := run("rev-parse", "HEAD~1")

	ok, msg := GuardedReset(dir, "hydra/test", "soft", "HEAD~1", nil, false)
	if !ok {
		t.Fatalf("soft reset failed: %s", msg)
	}
	if head := run("rev-parse", "HEAD"); head != before {
		t.Errorf("HEAD = %s, want %s (moved back one)", head, before)
	}
	// The undone change is still staged (soft keeps the index).
	if staged := run("diff", "--cached", "--name-only"); !strings.Contains(staged, "a.txt") {
		t.Errorf("a.txt should remain staged after soft reset, staged=%q", staged)
	}
}

func TestGuardedResetHardNeedsConfirm(t *testing.T) {
	dir, _ := opRepo(t)
	if ok, msg := GuardedReset(dir, "hydra/test", "hard", "HEAD", nil, false); ok || !strings.Contains(msg, "confirm") {
		t.Errorf("hard reset without confirm should be refused, got ok=%v msg=%q", ok, msg)
	}
}

func TestGuardedResetRefusesWrongBranch(t *testing.T) {
	dir, run := opRepo(t)
	run("checkout", "-q", "-b", "main")
	if ok, msg := GuardedReset(dir, "hydra/test", "soft", "HEAD~1", nil, false); ok || !strings.Contains(msg, "Refusing") {
		t.Errorf("reset on the wrong branch should be refused, got ok=%v msg=%q", ok, msg)
	}
}

func TestGuardedRevert(t *testing.T) {
	dir, run := opRepo(t)
	write(t, dir, "a.txt", "a\n")
	run("add", "-A")
	run("commit", "-q", "-m", "add a")
	target := run("rev-parse", "HEAD")

	ok, msg := GuardedRevert(dir, "hydra/test", target)
	if !ok {
		t.Fatalf("revert failed: %s", msg)
	}
	// a.txt is gone again (the add was reverted), as a new commit.
	if _, err := os.Stat(filepath.Join(dir, "a.txt")); !os.IsNotExist(err) {
		t.Errorf("a.txt should be removed by the revert")
	}
	if n := len(strings.Split(run("log", "--oneline"), "\n")); n != 3 {
		t.Errorf("expected 3 commits (seed, add, revert), got %d", n)
	}
}

func TestGuardedAddLineRange(t *testing.T) {
	dir, run := opRepo(t)
	write(t, dir, "f.txt", "1\n2\n3\n4\n5\n")
	run("add", "-A")
	run("commit", "-q", "-m", "f")
	// Change line 2 and line 4.
	write(t, dir, "f.txt", "1\nX\n3\nY\n5\n")

	// Stage only line 2's change.
	ok, msg := GuardedAdd(dir, "hydra/test", oneRange("f.txt", 2, 2))
	if !ok {
		t.Fatalf("line-range add failed: %s", msg)
	}
	stagedDiff := run("diff", "--cached")
	if !strings.Contains(stagedDiff, "+X") {
		t.Errorf("line 2 change (X) should be staged:\n%s", stagedDiff)
	}
	if strings.Contains(stagedDiff, "+Y") {
		t.Errorf("line 4 change (Y) should NOT be staged:\n%s", stagedDiff)
	}
	// Line 4's change remains unstaged in the worktree.
	if unstaged := run("diff"); !strings.Contains(unstaged, "+Y") {
		t.Errorf("line 4 change (Y) should still be unstaged:\n%s", unstaged)
	}
}

func TestGuardedRebaseSquash(t *testing.T) {
	dir, run := opRepo(t)
	base := run("rev-parse", "HEAD") // seed
	write(t, dir, "a.txt", "a\n")
	run("add", "-A")
	run("commit", "-q", "-m", "commit A")
	shaA := run("rev-parse", "HEAD")
	write(t, dir, "b.txt", "b\n")
	run("add", "-A")
	run("commit", "-q", "-m", "commit B")
	shaB := run("rev-parse", "HEAD")

	// Squash B into A, keeping A's message: pick A, fixup B.
	ok, msg := GuardedRebase(dir, "hydra/test", base, []gitq.RebaseStep{
		{Commit: shaA, Action: "pick"},
		{Commit: shaB, Action: "fixup"},
	})
	if !ok {
		t.Fatalf("rebase squash failed: %s", msg)
	}
	// One commit now sits above the seed, and both files are present.
	log := run("log", "--oneline")
	if n := len(strings.Split(log, "\n")); n != 2 {
		t.Fatalf("expected 2 commits (seed + squashed), got %d:\n%s", n, log)
	}
	if _, err := os.Stat(filepath.Join(dir, "a.txt")); err != nil {
		t.Errorf("a.txt missing after squash")
	}
	if _, err := os.Stat(filepath.Join(dir, "b.txt")); err != nil {
		t.Errorf("b.txt missing after squash")
	}
}

// oneRange builds a one-file AddSpec slice with a single line range, for tests.
func oneRange(path string, lo, hi int) []gitq.AddSpec {
	return []gitq.AddSpec{{Path: path, Ranges: [][2]int{{lo, hi}}}}
}
