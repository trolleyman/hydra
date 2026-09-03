package git

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestGetRemoteStatusAndPush(t *testing.T) {
	// A bare repo to act as "origin".
	remote := t.TempDir()
	bare := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", remote}, args...)...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	bare("init", "-q", "--bare", "--initial-branch=main")

	dir := gitInit(t)
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
	write := func(name, content string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	// No remote yet: nothing to push.
	run("checkout", "-q", "-b", "main")
	write("a.txt", "a\n")
	run("add", ".")
	run("commit", "-qm", "first")

	st, err := GetRemoteStatus(dir)
	if err != nil {
		t.Fatalf("GetRemoteStatus (no remote): %v", err)
	}
	if st.HasRemote || st.CanPush() {
		t.Errorf("with no remote, expected HasRemote=false CanPush=false, got %+v", st)
	}
	if st.Branch != "main" {
		t.Errorf("expected branch main, got %q", st.Branch)
	}

	// Add the remote. The branch isn't there yet, so all commits are ahead.
	run("remote", "add", "origin", remote)
	st, err = GetRemoteStatus(dir)
	if err != nil {
		t.Fatalf("GetRemoteStatus (remote, unpushed): %v", err)
	}
	if !st.HasRemote || st.Remote != "origin" {
		t.Errorf("expected HasRemote=true remote=origin, got %+v", st)
	}
	if st.Ahead != 1 || !st.CanPush() {
		t.Errorf("expected Ahead=1 CanPush=true before first push, got %+v", st)
	}

	// Push: now in sync.
	if _, err := Push(dir); err != nil {
		t.Fatalf("Push: %v", err)
	}
	st, err = GetRemoteStatus(dir)
	if err != nil {
		t.Fatalf("GetRemoteStatus (after push): %v", err)
	}
	if st.Ahead != 0 || st.CanPush() {
		t.Errorf("expected Ahead=0 CanPush=false after push, got %+v", st)
	}

	// A new local commit is ahead again.
	write("b.txt", "b\n")
	run("add", ".")
	run("commit", "-qm", "second")
	st, err = GetRemoteStatus(dir)
	if err != nil {
		t.Fatalf("GetRemoteStatus (new commit): %v", err)
	}
	if st.Ahead != 1 || !st.CanPush() {
		t.Errorf("expected Ahead=1 CanPush=true after new commit, got %+v", st)
	}

	if _, err := Push(dir); err != nil {
		t.Fatalf("Push (second): %v", err)
	}
	st, err = GetRemoteStatus(dir)
	if err != nil {
		t.Fatalf("GetRemoteStatus (after second push): %v", err)
	}
	if st.Ahead != 0 || st.CanPush() {
		t.Errorf("expected Ahead=0 after second push, got %+v", st)
	}
	if st.Behind != 0 {
		t.Errorf("expected Behind=0 while in sync, got %+v", st)
	}

	// Advance the remote from a second clone, then Fetch: the original repo should
	// now report it's behind (without that commit landing locally).
	clone := t.TempDir()
	if out, err := exec.Command("git", "clone", "-q", remote, clone).CombinedOutput(); err != nil {
		t.Fatalf("git clone: %v\n%s", err, out)
	}
	cloneRun := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", clone}, args...)...)
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@e",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@e")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	if err := os.WriteFile(filepath.Join(clone, "c.txt"), []byte("c\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	cloneRun("add", ".")
	cloneRun("commit", "-qm", "remote work")
	cloneRun("push", "-q", "origin", "main")

	// Before fetching, the original repo still thinks it's in sync.
	st, err = GetRemoteStatus(dir)
	if err != nil {
		t.Fatalf("GetRemoteStatus (pre-fetch): %v", err)
	}
	if st.Behind != 0 {
		t.Errorf("expected Behind=0 before fetch (stale refs), got %+v", st)
	}

	if err := Fetch(context.Background(), dir, "origin"); err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	st, err = GetRemoteStatus(dir)
	if err != nil {
		t.Fatalf("GetRemoteStatus (post-fetch): %v", err)
	}
	if st.Behind != 1 {
		t.Errorf("expected Behind=1 after fetch, got %+v", st)
	}
	if st.Ahead != 0 || st.CanPush() {
		t.Errorf("expected Ahead=0 CanPush=false (behind only), got %+v", st)
	}

	// Pull fast-forwards onto the fetched remote commit, leaving us in sync.
	if err := Pull(context.Background(), dir, "t", "t@e"); err != nil {
		t.Fatalf("Pull (fast-forward): %v", err)
	}
	st, err = GetRemoteStatus(dir)
	if err != nil {
		t.Fatalf("GetRemoteStatus (after pull): %v", err)
	}
	if st.Ahead != 0 || st.Behind != 0 {
		t.Errorf("expected Ahead=0 Behind=0 after pull, got %+v", st)
	}
	if _, err := os.Stat(filepath.Join(dir, "c.txt")); err != nil {
		t.Errorf("expected pulled file c.txt to exist: %v", err)
	}
}

// TestPullMergesDivergedBranches covers the non-fast-forward path: both sides
// have unique, non-conflicting commits, so Pull creates a merge commit and we
// end up ahead (the merge) without losing the remote's work.
func TestPullMergesDivergedBranches(t *testing.T) {
	remote := t.TempDir()
	if out, err := exec.Command("git", "-C", remote, "init", "-q", "--bare", "--initial-branch=main").CombinedOutput(); err != nil {
		t.Fatalf("git init --bare: %v\n%s", err, out)
	}

	dir := gitInit(t)
	run := func(d string, args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", d}, args...)...)
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@e",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@e")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	write := func(d, name, content string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(d, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	run(dir, "checkout", "-q", "-b", "main")
	write(dir, "a.txt", "a\n")
	run(dir, "add", ".")
	run(dir, "commit", "-qm", "base")
	run(dir, "remote", "add", "origin", remote)
	if _, err := Push(dir); err != nil {
		t.Fatalf("Push: %v", err)
	}

	// Remote gains a commit on a different file (no conflict).
	clone := t.TempDir()
	if out, err := exec.Command("git", "clone", "-q", remote, clone).CombinedOutput(); err != nil {
		t.Fatalf("git clone: %v\n%s", err, out)
	}
	write(clone, "remote.txt", "r\n")
	run(clone, "add", ".")
	run(clone, "commit", "-qm", "remote work")
	run(clone, "push", "-q", "origin", "main")

	// Local gains its own commit, so the branches diverge.
	write(dir, "local.txt", "l\n")
	run(dir, "add", ".")
	run(dir, "commit", "-qm", "local work")

	if err := Pull(context.Background(), dir, "t", "t@e"); err != nil {
		t.Fatalf("Pull (merge): %v", err)
	}
	st, err := GetRemoteStatus(dir)
	if err != nil {
		t.Fatalf("GetRemoteStatus: %v", err)
	}
	// Behind cleared; ahead is the local commit + the merge commit, still unpushed.
	if st.Behind != 0 {
		t.Errorf("expected Behind=0 after merge pull, got %+v", st)
	}
	if st.Ahead == 0 || !st.CanPush() {
		t.Errorf("expected Ahead>0 CanPush=true after merge pull, got %+v", st)
	}
	if _, err := os.Stat(filepath.Join(dir, "remote.txt")); err != nil {
		t.Errorf("expected merged remote.txt to exist: %v", err)
	}
}
