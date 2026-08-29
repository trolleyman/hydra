package http

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/trolleyman/hydra/internal/db"
	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/gitq"
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
	dir := paths.GetGitopsDir(projectRoot, id)
	if err := gitq.WriteRequest(dir, gitq.Request{ReqID: "r1", Op: gitq.OpCommit, Message: "host commit", TS: "t"}); err != nil {
		t.Fatal(err)
	}

	(&Server{}).drainGitopsRequests(projectRoot)

	// Result written, and the commit actually landed on the branch.
	res, ok, err := gitq.ReadResult(dir, "r1")
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
	(&Server{}).drainGitopsRequests(projectRoot)
	if reqs, _ := gitq.ListRequests(dir); len(reqs) != 0 {
		t.Errorf("request should be retired after result, still pending: %+v", reqs)
	}
}

func TestDrainFocusedCommitRequestsChecksPermissionAndSnapshot(t *testing.T) {
	projectRoot := t.TempDir()
	const id = "focused-1"
	run := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", projectRoot}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	run("init", "-q")
	run("config", "commit.gpgsign", "false")
	run("checkout", "-q", "-b", "main")
	if err := os.WriteFile(filepath.Join(projectRoot, "seed.txt"), []byte("seed\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", "-A")
	run("commit", "-q", "-m", "seed")
	seedHead := run("rev-parse", "HEAD")

	store, err := db.Open(projectRoot)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.CreateAgent(&db.Agent{ID: id, ProjectPath: projectRoot, AgentType: "claude", FilesystemMode: "edit"}); err != nil {
		t.Fatal(err)
	}
	dir := paths.GetGitopsDir(projectRoot, id)

	// Commit permission is independently opt-in, even for an editable focused
	// chat. A denied request must not move HEAD.
	if err := os.WriteFile(filepath.Join(projectRoot, "feature.txt"), []byte("one\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := gitq.WriteRequest(dir, gitq.Request{ReqID: "denied", Op: gitq.OpCommit, Message: "denied", ExpectedBranch: "main", ExpectedHead: seedHead}); err != nil {
		t.Fatal(err)
	}
	server := &Server{DB: store}
	server.drainGitopsRequests(projectRoot)
	denied, ok, err := gitq.ReadResult(dir, "denied")
	if err != nil || !ok || denied.OK || run("rev-parse", "HEAD") != seedHead {
		t.Fatalf("disabled commit result=%+v ok=%v err=%v", denied, ok, err)
	}

	allow := true
	if err := store.UpdateFocusedPermissions(id, nil, &allow); err != nil {
		t.Fatal(err)
	}
	if err := gitq.WriteRequest(dir, gitq.Request{ReqID: "allowed", Op: gitq.OpCommit, Message: "focused commit", ExpectedBranch: "main", ExpectedHead: seedHead}); err != nil {
		t.Fatal(err)
	}
	server.drainGitopsRequests(projectRoot)
	allowed, ok, err := gitq.ReadResult(dir, "allowed")
	if err != nil || !ok || !allowed.OK {
		t.Fatalf("allowed commit result=%+v ok=%v err=%v", allowed, ok, err)
	}
	committedHead := run("rev-parse", "HEAD")
	if committedHead == seedHead || run("log", "-1", "--pretty=%s") != "focused commit" {
		t.Fatalf("focused commit did not advance HEAD: before=%s after=%s", seedHead, committedHead)
	}

	// A request captures both refs in the sandbox. If another actor advances the
	// checkout before the watcher drains it, the request is rejected.
	if err := os.WriteFile(filepath.Join(projectRoot, "later.txt"), []byte("later\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := gitq.WriteRequest(dir, gitq.Request{ReqID: "stale", Op: gitq.OpCommit, Message: "stale", ExpectedBranch: "main", ExpectedHead: seedHead}); err != nil {
		t.Fatal(err)
	}
	server.drainGitopsRequests(projectRoot)
	stale, ok, err := gitq.ReadResult(dir, "stale")
	if err != nil || !ok || stale.OK || run("rev-parse", "HEAD") != committedHead {
		t.Fatalf("stale commit result=%+v ok=%v err=%v", stale, ok, err)
	}
}
