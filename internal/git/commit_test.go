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
	got := map[string]UncommittedFile{}
	for _, f := range files {
		got[f.Path] = f
	}
	want := map[string]string{
		"a.txt":              "modified",
		".hydra/config toml": "untracked",
		"new name.txt":       "renamed",
	}
	for path, status := range want {
		if got[path].Status != status {
			t.Errorf("expected %q => %q, got %q (all: %v)", path, status, got[path].Status, got)
		}
	}
	if len(files) != len(want) {
		t.Errorf("expected %d entries, got %+v", len(want), files)
	}
	if got["new name.txt"].OrigPath != "old name.txt" {
		t.Errorf("expected rename OrigPath %q, got %q", "old name.txt", got["new name.txt"].OrigPath)
	}

	// A pathspec-limited commit takes only the requested files — the rename
	// entry carries both its endpoints — and leaves the rest dirty.
	if err := CommitFiles(dir, "move file", []UncommittedFile{got["new name.txt"]}, "", ""); err != nil {
		t.Fatalf("CommitFiles (rename): %v", err)
	}
	files, err = ListUncommittedFiles(dir)
	if err != nil {
		t.Fatalf("ListUncommittedFiles (after rename commit): %v", err)
	}
	got = map[string]UncommittedFile{}
	for _, f := range files {
		got[f.Path] = f
	}
	if len(files) != 2 || got["a.txt"].Status != "modified" || got[".hydra/config toml"].Status != "untracked" {
		t.Fatalf("expected only a.txt + .hydra/config toml left dirty, got %+v", files)
	}

	// Committing the remaining paths leaves the tree clean.
	if err := CommitFiles(dir, "commit local changes", []UncommittedFile{got["a.txt"], got[".hydra/config toml"]}, "", ""); err != nil {
		t.Fatalf("CommitFiles: %v", err)
	}
	files, err = ListUncommittedFiles(dir)
	if err != nil {
		t.Fatalf("ListUncommittedFiles (after commit): %v", err)
	}
	if len(files) != 0 {
		t.Fatalf("expected clean repo after CommitFiles, got %+v", files)
	}

	// An empty message or file list is rejected before touching the index.
	if err := CommitFiles(dir, "  ", []UncommittedFile{{Path: "a.txt"}}, "", ""); err == nil {
		t.Fatal("expected CommitFiles with blank message to fail")
	}
	if err := CommitFiles(dir, "empty", nil, "", ""); err == nil {
		t.Fatal("expected CommitFiles with no paths to fail")
	}
	// A path with nothing to commit is an error (git exits non-zero).
	if err := CommitFiles(dir, "clean", []UncommittedFile{{Path: "a.txt"}}, "", ""); err == nil {
		t.Fatal("expected CommitFiles on a clean path to fail")
	}
}
