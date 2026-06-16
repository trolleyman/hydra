package git

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func gitInit(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
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
	run("init", "-q")
	return dir
}

func TestShowFile(t *testing.T) {
	dir := gitInit(t)
	commit := func(args ...string) {
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@e",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@e")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}

	rel := filepath.Join(".hydra", "config.toml")
	if err := os.MkdirAll(filepath.Join(dir, ".hydra"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, rel), []byte("v1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	commit("add", ".")
	commit("commit", "-q", "-m", "first")

	// Capture the first commit, then change the file in a second commit.
	first, err := ResolveRef(dir, "HEAD")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, rel), []byte("v2\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	commit("commit", "-aqm", "second")

	// ShowFile reads the version at each ref, not the working tree.
	got, err := ShowFile(dir, first, ".hydra/config.toml")
	if err != nil {
		t.Fatalf("ShowFile(first): %v", err)
	}
	if string(got) != "v1\n" {
		t.Errorf("at first commit = %q, want %q", got, "v1\n")
	}
	got, err = ShowFile(dir, "HEAD", ".hydra/config.toml")
	if err != nil {
		t.Fatalf("ShowFile(HEAD): %v", err)
	}
	if string(got) != "v2\n" {
		t.Errorf("at HEAD = %q, want %q", got, "v2\n")
	}

	// A path absent at the ref returns (nil, nil), not an error.
	got, err = ShowFile(dir, first, "does/not/exist.toml")
	if err != nil {
		t.Fatalf("ShowFile(absent): unexpected error %v", err)
	}
	if got != nil {
		t.Errorf("absent path = %q, want nil", got)
	}
}

func TestLsTreeEntryMode(t *testing.T) {
	dir := gitInit(t)
	commit := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@e",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@e")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}

	if err := os.MkdirAll(filepath.Join(dir, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "sub", "file.txt"), []byte("hi\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// A symlink pointing at the regular file.
	if err := os.Symlink("sub/file.txt", filepath.Join(dir, "link")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	commit("add", ".")
	commit("commit", "-qm", "first")

	cases := []struct {
		path string
		want string
	}{
		{"sub/file.txt", "100644"}, // regular file
		{"link", "120000"},         // symlink
		{"sub", "040000"},          // directory
		{"missing", ""},            // absent
	}
	for _, c := range cases {
		got, err := LsTreeEntryMode(dir, "HEAD", c.path)
		if err != nil {
			t.Fatalf("LsTreeEntryMode(%q): %v", c.path, err)
		}
		if got != c.want {
			t.Errorf("LsTreeEntryMode(%q) = %q, want %q", c.path, got, c.want)
		}
	}
}

func TestListBranches(t *testing.T) {
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
	if err := os.WriteFile(filepath.Join(dir, "f.txt"), []byte("x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", ".")
	run("commit", "-qm", "first")
	run("branch", "hydra/task-a")
	run("branch", "release")

	got, err := ListBranches(dir)
	if err != nil {
		t.Fatalf("ListBranches: %v", err)
	}
	// The initial branch name varies (main/master) by git config, so just assert
	// the two we created are present alongside it.
	want := map[string]bool{"hydra/task-a": false, "release": false}
	for _, b := range got {
		if _, ok := want[b]; ok {
			want[b] = true
		}
	}
	for name, seen := range want {
		if !seen {
			t.Errorf("ListBranches missing %q (got %v)", name, got)
		}
	}
	if len(got) < 3 {
		t.Errorf("ListBranches = %v, want at least 3 branches", got)
	}
}
