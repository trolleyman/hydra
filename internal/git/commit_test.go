package git

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestListUncommittedFilesAndCommitAll(t *testing.T) {
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
		if err := os.MkdirAll(filepath.Dir(filepath.Join(dir, name)), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	// A clean repo has nothing uncommitted.
	write("a.txt", "a\n")
	write("old name.txt", "r\n")
	run("add", ".")
	run("commit", "-qm", "first")
	files, err := ListUncommittedFiles(dir)
	if err != nil {
		t.Fatalf("ListUncommittedFiles (clean): %v", err)
	}
	if len(files) != 0 {
		t.Fatalf("expected clean repo, got %+v", files)
	}

	// One modification, one untracked file (with a space in its name), and a
	// staged rename — the rename's two NUL-separated paths must parse as one entry.
	write("a.txt", "changed\n")
	write(".hydra/config toml", "cfg\n")
	run("mv", "old name.txt", "new name.txt")
	files, err = ListUncommittedFiles(dir)
	if err != nil {
		t.Fatalf("ListUncommittedFiles (dirty): %v", err)
	}
	got := map[string]string{}
	for _, f := range files {
		got[f.Path] = f.Status
	}
	want := map[string]string{
		"a.txt":              "modified",
		".hydra/config toml": "untracked",
		"new name.txt":       "renamed",
	}
	for path, status := range want {
		if got[path] != status {
			t.Errorf("expected %q => %q, got %q (all: %v)", path, status, got[path], got)
		}
	}
	if len(files) != len(want) {
		t.Errorf("expected %d entries, got %+v", len(want), files)
	}

	// CommitAll sweeps everything into one commit and leaves the tree clean.
	if err := CommitAll(dir, "commit local changes", "", ""); err != nil {
		t.Fatalf("CommitAll: %v", err)
	}
	files, err = ListUncommittedFiles(dir)
	if err != nil {
		t.Fatalf("ListUncommittedFiles (after commit): %v", err)
	}
	if len(files) != 0 {
		t.Fatalf("expected clean repo after CommitAll, got %+v", files)
	}

	// An empty message is rejected before touching the index.
	if err := CommitAll(dir, "  ", "", ""); err == nil {
		t.Fatal("expected CommitAll with blank message to fail")
	}
	// Nothing to commit is an error (git exits non-zero).
	if err := CommitAll(dir, "empty", "", ""); err == nil {
		t.Fatal("expected CommitAll with a clean tree to fail")
	}
}
