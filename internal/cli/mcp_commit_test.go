package cli

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/trolleyman/hydra/internal/mcpserver"
)

// initCommitRepo makes a temp git repo checked out on `branch` with one initial
// commit, and returns its path. Identity + gpgsign are pinned so commits succeed
// in CI without host git config.
func initCommitRepo(t *testing.T, branch string) string {
	t.Helper()
	dir := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	run("init", "-q")
	run("config", "commit.gpgsign", "false")
	run("checkout", "-q", "-b", branch)
	if err := os.WriteFile(filepath.Join(dir, "seed.txt"), []byte("seed\n"), 0644); err != nil {
		t.Fatal(err)
	}
	run("add", "-A")
	run("commit", "-q", "-m", "seed")
	return dir
}

func writeFile(t *testing.T, dir, name, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
}

func TestGitCommitOnOwnBranch(t *testing.T) {
	dir := initCommitRepo(t, "hydra/test")
	writeFile(t, dir, "new.txt", "hi\n")

	r := gitCommit(dir, "hydra/test", mcpserver.CommitRequest{Message: "add new"})
	if !r.OK {
		t.Fatalf("expected OK, got %q", r.Message)
	}
	if !strings.Contains(r.Message, "hydra/test") || !strings.Contains(r.Message, "add new") {
		t.Errorf("summary missing branch/subject: %q", r.Message)
	}
	// The new file is committed (staged by the default add -A).
	out, _ := exec.Command("git", "-C", dir, "log", "-1", "--name-only", "--pretty=%s").CombinedOutput()
	if !strings.Contains(string(out), "new.txt") {
		t.Errorf("new.txt not in last commit: %s", out)
	}
}

func TestGitCommitRefusesWrongBranch(t *testing.T) {
	dir := initCommitRepo(t, "main")
	writeFile(t, dir, "new.txt", "hi\n")

	// Worktree on main but the head's branch is hydra/test - refuse.
	r := gitCommit(dir, "hydra/test", mcpserver.CommitRequest{Message: "x"})
	if r.OK || !strings.Contains(r.Message, "Refusing to commit") {
		t.Errorf("expected refusal, got OK=%v msg=%q", r.OK, r.Message)
	}
	// Nothing was committed.
	out, _ := exec.Command("git", "-C", dir, "log", "--oneline").CombinedOutput()
	if strings.Count(strings.TrimSpace(string(out)), "\n") != 0 {
		t.Errorf("expected a single seed commit, got:\n%s", out)
	}
}

func TestGitCommitBranchFallback(t *testing.T) {
	// When HYDRA_BRANCH is unknown (empty), only a hydra/* checkout may commit.
	own := initCommitRepo(t, "hydra/abc")
	writeFile(t, own, "a.txt", "x\n")
	if r := gitCommit(own, "", mcpserver.CommitRequest{Message: "ok"}); !r.OK {
		t.Errorf("hydra/* fallback should commit, got %q", r.Message)
	}

	shared := initCommitRepo(t, "main")
	writeFile(t, shared, "a.txt", "x\n")
	if r := gitCommit(shared, "", mcpserver.CommitRequest{Message: "ok"}); r.OK || !strings.Contains(r.Message, "hydra/*") {
		t.Errorf("non-hydra branch should be refused, got OK=%v msg=%q", r.OK, r.Message)
	}
}

func TestGitCommitRefusesDetachedHead(t *testing.T) {
	dir := initCommitRepo(t, "hydra/test")
	// Detach HEAD onto the current commit.
	if out, err := exec.Command("git", "-C", dir, "checkout", "-q", "--detach").CombinedOutput(); err != nil {
		t.Fatalf("detach: %v\n%s", err, out)
	}
	writeFile(t, dir, "new.txt", "hi\n")
	r := gitCommit(dir, "hydra/test", mcpserver.CommitRequest{Message: "x"})
	if r.OK || !strings.Contains(r.Message, "detached") {
		t.Errorf("expected detached-HEAD refusal, got OK=%v msg=%q", r.OK, r.Message)
	}
}

func TestGitCommitStagesOnlyGivenPaths(t *testing.T) {
	dir := initCommitRepo(t, "hydra/test")
	writeFile(t, dir, "keep.txt", "a\n")
	writeFile(t, dir, "skip.txt", "b\n")

	r := gitCommit(dir, "hydra/test", mcpserver.CommitRequest{Message: "partial", Paths: []string{"keep.txt"}})
	if !r.OK {
		t.Fatalf("expected OK, got %q", r.Message)
	}
	out, _ := exec.Command("git", "-C", dir, "log", "-1", "--name-only", "--pretty=format:").CombinedOutput()
	files := string(out)
	if !strings.Contains(files, "keep.txt") || strings.Contains(files, "skip.txt") {
		t.Errorf("expected only keep.txt committed, got:\n%s", files)
	}
	// skip.txt remains an untracked working-tree change.
	st, _ := exec.Command("git", "-C", dir, "status", "--porcelain").CombinedOutput()
	if !strings.Contains(string(st), "skip.txt") {
		t.Errorf("skip.txt should still be uncommitted: %q", st)
	}
}

func TestGitCommitNoWorktree(t *testing.T) {
	r := gitCommit("", "hydra/test", mcpserver.CommitRequest{Message: "x"})
	if r.OK || !strings.Contains(r.Message, "worktree") {
		t.Errorf("empty worktree should error, got OK=%v msg=%q", r.OK, r.Message)
	}
}
