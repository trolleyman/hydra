package git

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestPRHeadRefspec(t *testing.T) {
	cases := []struct {
		provider, id, wantLocal, wantRefspec string
	}{
		{"github", "123", "refs/hydra/pr/github/123", "refs/pull/123/head:refs/hydra/pr/github/123"},
		{"gitlab", "45", "refs/hydra/pr/gitlab/45", "refs/merge-requests/45/head:refs/hydra/pr/gitlab/45"},
		{"", "7", "refs/hydra/pr/github/7", "refs/pull/7/head:refs/hydra/pr/github/7"},
	}
	for _, c := range cases {
		gotLocal, gotRefspec := PRHeadRefspec(c.provider, c.id)
		if gotLocal != c.wantLocal {
			t.Errorf("PRHeadRefspec(%q,%q) local = %q, want %q", c.provider, c.id, gotLocal, c.wantLocal)
		}
		if gotRefspec != c.wantRefspec {
			t.Errorf("PRHeadRefspec(%q,%q) refspec = %q, want %q", c.provider, c.id, gotRefspec, c.wantRefspec)
		}
	}
}

func TestFetchRefspecRejectsBadInput(t *testing.T) {
	if err := FetchRefspec(context.Background(), t.TempDir(), "origin", ""); err == nil {
		t.Error("empty refspec should be rejected")
	}
	if err := FetchRefspec(context.Background(), t.TempDir(), "origin", "--upload-pack=evil"); err == nil {
		t.Error("dash-leading refspec should be rejected")
	}
	if err := FetchRefspec(context.Background(), t.TempDir(), "-remote", "a:b"); err == nil {
		t.Error("dash-leading remote should be rejected")
	}
}

// TestFetchRefspecPseudoRef exercises the real fetch path against a local "remote"
// repo that publishes a PR-style pseudo-ref, mirroring how a forge exposes
// refs/pull/<n>/head - proving the private local ref lands and a worktree can be
// based on it.
func TestFetchRefspecPseudoRef(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not on PATH")
	}
	dir := t.TempDir()
	remote := filepath.Join(dir, "remote")
	local := filepath.Join(dir, "local")

	// A bare-ish source repo with one commit and a pseudo-ref pointing at it.
	run := func(wd string, args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = wd
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %s: %v: %s", strings.Join(args, " "), err, out)
		}
	}
	if err := os.MkdirAll(remote, 0o755); err != nil {
		t.Fatal(err)
	}
	run(remote, "init", "-q")
	run(remote, "checkout", "-q", "-b", "main")
	if err := os.WriteFile(filepath.Join(remote, "f.txt"), []byte("hi"), 0o644); err != nil {
		t.Fatal(err)
	}
	run(remote, "add", ".")
	run(remote, "commit", "-q", "-m", "c1")
	// Publish the tip under a forge-style pseudo-ref.
	run(remote, "update-ref", "refs/pull/123/head", "HEAD")

	run(dir, "clone", "-q", remote, local)

	_, refspec := PRHeadRefspec("github", "123")
	if err := FetchRefspec(context.Background(), local, "origin", refspec); err != nil {
		t.Fatalf("FetchRefspec: %v", err)
	}
	// The private local ref now resolves to a commit we can base a worktree on.
	sha, err := ResolveRef(local, PRLocalRef("github", "123"))
	if err != nil || sha == "" {
		t.Fatalf("local PR ref did not resolve: sha=%q err=%v", sha, err)
	}
}
