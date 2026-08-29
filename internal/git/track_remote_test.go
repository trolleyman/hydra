package git

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"testing"
)

func TestEnsureTrackRemote(t *testing.T) {
	dir := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	run("init", "-q")
	run("config", "commit.gpgsign", "false")
	run("checkout", "-q", "-b", "hydra/head-1")
	if err := os.WriteFile(dir+"/f.txt", []byte("x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", "-A")
	run("commit", "-q", "-m", "seed")

	remote, err := EnsureTrackRemote(context.Background(), dir)
	if err != nil {
		t.Fatalf("EnsureTrackRemote: %v", err)
	}
	if remote != TrackRemoteName {
		t.Errorf("remote = %q, want %q", remote, TrackRemoteName)
	}
	// The head branch is now fetchable as a remote-tracking ref.
	out, _ := exec.Command("git", "-C", dir, "rev-parse", "--symbolic-full-name", TrackRemoteName+"/head-1").CombinedOutput()
	if !strings.Contains(string(out), "refs/remotes/"+TrackRemoteName+"/head-1") {
		t.Errorf("tracking ref not created: %s", out)
	}
	if LocalBranchExists(dir, "head-1") {
		t.Error("remote-tracking ref was mistaken for a local branch")
	}
	run("branch", "head-1")
	if !LocalBranchExists(dir, "head-1") {
		t.Error("existing local branch was not detected")
	}
	if LocalBranchExists(dir, "../unsafe") {
		t.Error("invalid branch name was accepted")
	}
	// Idempotent: a second call still succeeds (config overwritten, not duplicated).
	if _, err := EnsureTrackRemote(context.Background(), dir); err != nil {
		t.Errorf("second EnsureTrackRemote failed: %v", err)
	}
	fetches, _ := exec.Command("git", "-C", dir, "config", "--get-all", "remote."+TrackRemoteName+".fetch").CombinedOutput()
	if n := strings.Count(strings.TrimSpace(string(fetches)), "\n"); n != 0 {
		t.Errorf("expected a single fetch refspec, got:\n%s", fetches)
	}
}
