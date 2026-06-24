package git

import (
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
	bare("init", "-q", "--bare")

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
}
