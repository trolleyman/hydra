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

// mergeRepo extends opRepo with a `feature` branch carrying one commit, so a
// merge into hydra/test has something to bring in.
func mergeRepo(t *testing.T, file, content string) (string, func(...string) string) {
	t.Helper()
	dir, run := opRepo(t)
	run("checkout", "-q", "-b", "feature")
	write(t, dir, file, content)
	run("add", "-A")
	run("commit", "-q", "-m", "feature work")
	run("checkout", "-q", "hydra/test")
	return dir, run
}

func TestGuardedMergeFastForward(t *testing.T) {
	dir, run := mergeRepo(t, "f.txt", "feature\n")

	ok, msg := GuardedMerge(dir, "hydra/test", "feature", "", false)
	if !ok {
		t.Fatalf("merge failed: %s", msg)
	}
	if _, err := os.Stat(filepath.Join(dir, "f.txt")); err != nil {
		t.Errorf("the merged file is missing: %v", err)
	}
	// Fast-forward: HEAD is feature's commit, not a new merge commit.
	if parents := run("rev-list", "--parents", "-n", "1", "HEAD"); len(strings.Fields(parents)) != 2 {
		t.Errorf("expected a fast-forward (single parent), got %q", parents)
	}
	if branch := run("symbolic-ref", "--short", "HEAD"); branch != "hydra/test" {
		t.Errorf("merge moved off the head's branch: now on %q", branch)
	}
}

func TestGuardedMergeNoFFMakesAMergeCommit(t *testing.T) {
	dir, run := mergeRepo(t, "f.txt", "feature\n")

	if ok, msg := GuardedMerge(dir, "hydra/test", "feature", "bring feature in", true); !ok {
		t.Fatalf("merge failed: %s", msg)
	}
	if parents := run("rev-list", "--parents", "-n", "1", "HEAD"); len(strings.Fields(parents)) != 3 {
		t.Errorf("expected a two-parent merge commit, got %q", parents)
	}
	if subject := run("log", "-1", "--pretty=%s"); subject != "bring feature in" {
		t.Errorf("subject = %q, want the message we passed", subject)
	}
}

func TestGuardedMergeDefaultSubject(t *testing.T) {
	dir, run := mergeRepo(t, "f.txt", "feature\n")
	if ok, msg := GuardedMerge(dir, "hydra/test", "feature", "", true); !ok {
		t.Fatalf("merge failed: %s", msg)
	}
	if subject := run("log", "-1", "--pretty=%s"); subject != "Merge branch 'feature'" {
		t.Errorf("subject = %q, want the git-style default", subject)
	}
}

// A conflict is left in progress (not aborted) so the agent can resolve it -
// the whole point of having a merge tool rather than reusing cherry-pick.
func TestGuardedMergeLeavesConflictInProgress(t *testing.T) {
	dir, run := opRepo(t)
	run("checkout", "-q", "-b", "feature")
	write(t, dir, "c.txt", "theirs\n")
	run("add", "-A")
	run("commit", "-q", "-m", "theirs")
	run("checkout", "-q", "hydra/test")
	write(t, dir, "c.txt", "ours\n")
	run("add", "-A")
	run("commit", "-q", "-m", "ours")

	ok, msg := GuardedMerge(dir, "hydra/test", "feature", "", false)
	if ok {
		t.Fatalf("expected the conflicting merge to report failure, got %q", msg)
	}
	for _, want := range []string{"c.txt", "LEFT IN PROGRESS", "git_merge_continue", "git_merge_abort"} {
		if !strings.Contains(msg, want) {
			t.Errorf("conflict message should mention %q, got %q", want, msg)
		}
	}
	if !mergeInProgress(dir) {
		t.Fatal("the merge should still be in progress for the agent to resolve")
	}

	// Still conflicted: continuing must refuse rather than commit the markers.
	if ok, msg := GuardedMergeContinue(dir, "hydra/test"); ok || !strings.Contains(msg, "conflict markers") {
		t.Errorf("continue with markers left in should be refused, got ok=%v msg=%q", ok, msg)
	}

	write(t, dir, "c.txt", "resolved\n")
	ok, msg = GuardedMergeContinue(dir, "hydra/test")
	if !ok {
		t.Fatalf("continue after resolving failed: %s", msg)
	}
	if mergeInProgress(dir) {
		t.Error("the merge should be concluded")
	}
	if parents := run("rev-list", "--parents", "-n", "1", "HEAD"); len(strings.Fields(parents)) != 3 {
		t.Errorf("expected a two-parent merge commit, got %q", parents)
	}
	if body := run("show", "HEAD:c.txt"); body != "resolved" {
		t.Errorf("merged c.txt = %q, want the resolution", body)
	}
}

func TestGuardedMergeAbortRestoresBranch(t *testing.T) {
	dir, run := opRepo(t)
	run("checkout", "-q", "-b", "feature")
	write(t, dir, "c.txt", "theirs\n")
	run("add", "-A")
	run("commit", "-q", "-m", "theirs")
	run("checkout", "-q", "hydra/test")
	write(t, dir, "c.txt", "ours\n")
	run("add", "-A")
	run("commit", "-q", "-m", "ours")
	before := run("rev-parse", "HEAD")

	if ok, _ := GuardedMerge(dir, "hydra/test", "feature", "", false); ok {
		t.Fatal("expected a conflict")
	}
	if ok, msg := GuardedMergeAbort(dir, "hydra/test"); !ok {
		t.Fatalf("abort failed: %s", msg)
	}
	if mergeInProgress(dir) {
		t.Error("the merge should be gone after abort")
	}
	if head := run("rev-parse", "HEAD"); head != before {
		t.Errorf("HEAD = %s, want %s restored", head, before)
	}
	if body := run("show", "HEAD:c.txt"); body != "ours" {
		t.Errorf("c.txt = %q, want our side back", body)
	}
}

// The own-branch guard is what makes the direction safe: on any branch that
// isn't the head's, the merge is refused outright.
func TestGuardedMergeRefusesWrongBranch(t *testing.T) {
	dir, run := mergeRepo(t, "f.txt", "feature\n")
	run("checkout", "-q", "-b", "main")
	if ok, msg := GuardedMerge(dir, "hydra/test", "feature", "", false); ok || !strings.Contains(msg, "Refusing") {
		t.Errorf("merge on the wrong branch should be refused, got ok=%v msg=%q", ok, msg)
	}
}

func TestGuardedMergeRejectsBadRefs(t *testing.T) {
	dir, _ := mergeRepo(t, "f.txt", "feature\n")
	for name, ref := range map[string]string{
		"empty":     "",
		"no such":   "does-not-exist",
		"flag-like": "--hard",
		"itself":    "hydra/test",
	} {
		if ok, msg := GuardedMerge(dir, "hydra/test", ref, "", false); ok {
			t.Errorf("%s ref %q should be refused, got %q", name, ref, msg)
		}
	}
}

// Merging an already-merged ref is a no-op, and reported as success so a caller
// keeping itself up to date doesn't read "nothing to do" as a failure.
func TestGuardedMergeAlreadyMerged(t *testing.T) {
	dir, _ := mergeRepo(t, "f.txt", "feature\n")
	if ok, msg := GuardedMerge(dir, "hydra/test", "feature", "", false); !ok {
		t.Fatalf("first merge failed: %s", msg)
	}
	ok, msg := GuardedMerge(dir, "hydra/test", "feature", "", false)
	if !ok || !strings.Contains(msg, "already merged") {
		t.Errorf("re-merging should be a successful no-op, got ok=%v msg=%q", ok, msg)
	}
}

func TestGuardedMergeContinueAndAbortWithoutMerge(t *testing.T) {
	dir, _ := opRepo(t)
	if ok, msg := GuardedMergeContinue(dir, "hydra/test"); ok || !strings.Contains(msg, "No merge") {
		t.Errorf("continue without a merge should be refused, got ok=%v msg=%q", ok, msg)
	}
	if ok, msg := GuardedMergeAbort(dir, "hydra/test"); ok || !strings.Contains(msg, "No merge") {
		t.Errorf("abort without a merge should be refused, got ok=%v msg=%q", ok, msg)
	}
}

// The gitq dispatch reaches the merge ops, so a host-side (readonly-isolation)
// request behaves the same as an in-sandbox call.
func TestRunGuardedOpDispatchesMerge(t *testing.T) {
	dir, run := mergeRepo(t, "f.txt", "feature\n")
	ok, msg := RunGuardedOp(dir, "hydra/test", gitq.Request{Op: gitq.OpMerge, Ref: "feature", NoFF: true})
	if !ok {
		t.Fatalf("RunGuardedOp merge failed: %s", msg)
	}
	if parents := run("rev-list", "--parents", "-n", "1", "HEAD"); len(strings.Fields(parents)) != 3 {
		t.Errorf("expected a merge commit, got %q", parents)
	}
}
