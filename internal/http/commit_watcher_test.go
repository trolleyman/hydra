package http

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/trolleyman/hydra/internal/commitq"
	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/paths"
)

// TestDrainCommitRequests exercises the host side of the host-mediated commit
// path end to end: a request file dropped into a head's commit dir is turned into
// a real commit on the head's own branch, with a result written back.
func TestDrainCommitRequests(t *testing.T) {
	projectRoot := t.TempDir()
	const id = "head-1"
	worktree := paths.GetWorktreeDirFromProjectRoot(projectRoot, id)
	if err := os.MkdirAll(worktree, 0o755); err != nil {
		t.Fatal(err)
	}
	// A git repo on the head's own branch (hydra/<id>), with a change to commit.
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", worktree}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	run("init", "-q")
	run("config", "commit.gpgsign", "false")
	run("checkout", "-q", "-b", git.BranchName(id)) // hydra/head-1
	if err := os.WriteFile(filepath.Join(worktree, "seed.txt"), []byte("s\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", "-A")
	run("commit", "-q", "-m", "seed")
	if err := os.WriteFile(filepath.Join(worktree, "feature.txt"), []byte("hi\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Drop a commit request into the head's channel, as the in-sandbox tool would.
	dir := paths.GetCommitDirFromProjectRoot(projectRoot, id)
	if err := commitq.WriteRequest(dir, commitq.Request{ReqID: "r1", Message: "host commit", TS: "t"}); err != nil {
		t.Fatal(err)
	}

	(&Server{}).drainCommitRequests(projectRoot)

	// Result written, and the commit actually landed on the branch.
	res, ok, err := commitq.ReadResult(dir, "r1")
	if err != nil || !ok {
		t.Fatalf("no result written: ok=%v err=%v", ok, err)
	}
	if !res.OK || !strings.Contains(res.Message, "host commit") {
		t.Fatalf("result = %+v, want OK with subject", res)
	}
	out, _ := exec.Command("git", "-C", worktree, "log", "-1", "--pretty=%s%n%H", "--name-only").CombinedOutput()
	if !strings.Contains(string(out), "host commit") || !strings.Contains(string(out), "feature.txt") {
		t.Errorf("commit not recorded on branch: %s", out)
	}

	// Idempotency: a second drain finds no pending request (result retires it).
	(&Server{}).drainCommitRequests(projectRoot)
	if reqs, _ := commitq.ListRequests(dir); len(reqs) != 0 {
		t.Errorf("request should be retired after result, still pending: %+v", reqs)
	}
}
