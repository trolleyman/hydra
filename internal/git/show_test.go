package git

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
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

func TestCheckoutBranchPreservesDirtyTreeProtection(t *testing.T) {
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

	file := filepath.Join(dir, "shared.txt")
	if err := os.WriteFile(file, []byte("main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", "shared.txt")
	run("commit", "-qm", "main")
	initial, err := GetCurrentBranch(dir)
	if err != nil {
		t.Fatal(err)
	}
	run("checkout", "-qb", "other")
	if err := os.WriteFile(file, []byte("other\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("commit", "-am", "other", "-q")
	run("checkout", "-q", initial)

	if err := CheckoutBranch(dir, "other"); err != nil {
		t.Fatalf("CheckoutBranch(clean): %v", err)
	}
	if current, err := GetCurrentBranch(dir); err != nil || current != "other" {
		t.Fatalf("current branch = %q, %v; want other", current, err)
	}

	if err := os.WriteFile(file, []byte("local work\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := CheckoutBranch(dir, initial); err == nil {
		t.Fatal("CheckoutBranch overwrote conflicting local work")
	}
	if got, err := os.ReadFile(file); err != nil || string(got) != "local work\n" {
		t.Fatalf("dirty file = %q, %v; want local work", got, err)
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

func TestHeadBlobSHAs(t *testing.T) {
	dir := gitInit(t)
	git := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@e",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@e")
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}

	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("alpha\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "b.txt"), []byte("beta\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	git("add", ".")
	git("commit", "-qm", "first")

	wantA := git("rev-parse", "HEAD:a.txt")
	wantB := git("rev-parse", "HEAD:b.txt")

	// From the head tree: shas match git's own object ids, and a missing path is
	// simply absent.
	got := HeadBlobSHAs(dir, "HEAD", []string{"a.txt", "b.txt", "missing.txt"})
	if got["a.txt"] != wantA {
		t.Errorf("a.txt = %q, want %q", got["a.txt"], wantA)
	}
	if got["b.txt"] != wantB {
		t.Errorf("b.txt = %q, want %q", got["b.txt"], wantB)
	}
	if _, ok := got["missing.txt"]; ok {
		t.Errorf("missing.txt should be absent, got %q", got["missing.txt"])
	}

	// Working-tree side (ref == ""): an edited-but-uncommitted file hashes to a
	// different sha than its committed blob.
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("alpha edited\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	wt := HeadBlobSHAs(dir, "", []string{"a.txt", "b.txt"})
	if wt["a.txt"] == "" || wt["a.txt"] == wantA {
		t.Errorf("working-tree a.txt = %q, want a fresh hash-object sha != %q", wt["a.txt"], wantA)
	}
	if wt["b.txt"] != wantB {
		t.Errorf("working-tree b.txt (unchanged) = %q, want %q", wt["b.txt"], wantB)
	}
}
