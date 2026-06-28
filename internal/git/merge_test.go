package git

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestMergedHydraBranches(t *testing.T) {
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

	// Base commit on the default branch.
	run("checkout", "-q", "-b", "main")
	write("base.txt", "base\n")
	run("add", ".")
	run("commit", "-qm", "base")

	// A hydra branch that diverges from main (forces a --no-ff merge commit, which
	// carries the "Merge branch 'hydra/<id>'" subject MergedHydraBranches keys on).
	run("checkout", "-q", "-b", "hydra/merged-one")
	write("feature.txt", "feature\n")
	run("add", ".")
	run("commit", "-qm", "feature work")

	run("checkout", "-q", "main")
	write("base.txt", "base changed\n") // diverge so the merge can't fast-forward
	run("add", ".")
	run("commit", "-qm", "advance main")
	if err := Merge(dir, "hydra/merged-one", "t", "t@e"); err != nil {
		t.Fatalf("merge: %v", err)
	}

	// A killed hydra branch: committed but never merged, then deleted.
	run("checkout", "-q", "-b", "hydra/killed-one")
	write("scratch.txt", "scratch\n")
	run("add", ".")
	run("commit", "-qm", "scratch work")
	run("checkout", "-q", "main")
	run("branch", "-qD", "hydra/killed-one")

	merged, err := MergedHydraBranches(dir)
	if err != nil {
		t.Fatalf("MergedHydraBranches: %v", err)
	}
	if _, ok := merged["hydra/merged-one"]; !ok {
		t.Errorf("expected hydra/merged-one to be detected as merged, got %v", merged)
	}
	if _, ok := merged["hydra/killed-one"]; ok {
		t.Errorf("killed branch must not be reported as merged, got %v", merged)
	}
}

// TestAddWorktreeForBranch covers merging into a base branch that is not checked
// out in the main repo: AddWorktreeForBranch checks the branch out in a throwaway
// worktree, and a merge there advances that branch (the temp-worktree fallback
// used by heads.ResolveMergeDir / MergeAgent for stacked agents).
func TestAddWorktreeForBranch(t *testing.T) {
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

	// main with a base commit; a feature branch that diverges from it.
	run("checkout", "-q", "-b", "main")
	write("base.txt", "base\n")
	run("add", ".")
	run("commit", "-qm", "base")

	run("checkout", "-q", "-b", "feature")
	write("feature.txt", "feature\n")
	run("add", ".")
	run("commit", "-qm", "feature work")

	// Diverge main so the merge can't fast-forward, then switch back to feature so
	// main is NOT the checked-out branch in the main repo.
	run("checkout", "-q", "main")
	write("base.txt", "base changed\n")
	run("add", ".")
	run("commit", "-qm", "advance main")
	run("checkout", "-q", "feature")

	mainBefore := revParse(t, dir, "main")

	wt := filepath.Join(t.TempDir(), "merge-wt")
	if err := AddWorktreeForBranch(dir, wt, "main"); err != nil {
		t.Fatalf("AddWorktreeForBranch: %v", err)
	}
	if err := Merge(wt, "feature", "t", "t@e"); err != nil {
		t.Fatalf("merge in worktree: %v", err)
	}
	if err := RemoveWorktree(dir, wt); err != nil {
		t.Fatalf("RemoveWorktree: %v", err)
	}

	// main must have advanced (a merge commit), and now contain feature's work.
	if got := revParse(t, dir, "main"); got == mainBefore {
		t.Errorf("main did not advance after merge: still %s", got)
	}
	if !gitContains(t, dir, "main", "feature") {
		t.Errorf("main does not contain feature after merge into its worktree")
	}
}

// TestMergeAbortsOnDirtyTree verifies that Merge refuses to run when the
// destination working tree has an uncommitted change to a tracked file that the
// merge would overwrite, returns a *DirtyMergeError naming that file, and leaves
// the change intact. The fast-forward path would otherwise discard it.
func TestMergeAbortsOnDirtyTree(t *testing.T) {
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
	read := func(name string) string {
		t.Helper()
		b, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}

	// main with a base commit, and a feature branch ahead of it so a merge into
	// main can fast-forward (the destructive `reset --hard` path).
	run("checkout", "-q", "-b", "main")
	write("base.txt", "base\n")
	run("add", ".")
	run("commit", "-qm", "base")

	run("checkout", "-q", "-b", "feature")
	write("base.txt", "from feature\n")
	run("add", ".")
	run("commit", "-qm", "feature work")

	run("checkout", "-q", "main")

	// Dirty the working tree on main with an uncommitted edit to a tracked file.
	write("base.txt", "uncommitted work\n")

	err := Merge(dir, "feature", "t", "t@e")
	if err == nil {
		t.Fatal("expected Merge to abort on a dirty working tree, got nil")
	}
	var dirty *DirtyMergeError
	if !errors.As(err, &dirty) {
		t.Fatalf("expected *DirtyMergeError, got %T: %v", err, err)
	}
	if len(dirty.Files) != 1 || dirty.Files[0] != "base.txt" {
		t.Errorf("expected DirtyMergeError naming base.txt, got %v", dirty.Files)
	}

	// The uncommitted change must survive untouched (not clobbered by the merge),
	// and main must not have advanced.
	if got := read("base.txt"); got != "uncommitted work\n" {
		t.Errorf("uncommitted change was overwritten: got %q", got)
	}
	if !gitContains(t, dir, "main", "main") || gitContains(t, dir, "main", "feature") {
		t.Errorf("main advanced despite the abort")
	}

	// Once the tree is clean, the same merge succeeds.
	run("checkout", "-q", "--", "base.txt")
	if err := Merge(dir, "feature", "t", "t@e"); err != nil {
		t.Fatalf("merge on clean tree: %v", err)
	}
	if !gitContains(t, dir, "main", "feature") {
		t.Errorf("main did not contain feature after merging a clean tree")
	}
}

// TestMergeKeepsUnrelatedDirtyFiles verifies that uncommitted changes to a file
// the merge does NOT touch neither block the merge nor get discarded. This is the
// core of the fix: only overlap with the incoming changes should stop a merge.
func TestMergeKeepsUnrelatedDirtyFiles(t *testing.T) {
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
	read := func(name string) string {
		t.Helper()
		b, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}

	// main has two tracked files; feature only changes feature.txt, so a merge
	// into main fast-forwards and touches feature.txt but never unrelated.txt.
	run("checkout", "-q", "-b", "main")
	write("unrelated.txt", "original\n")
	write("feature.txt", "base\n")
	run("add", ".")
	run("commit", "-qm", "base")

	run("checkout", "-q", "-b", "feature")
	write("feature.txt", "from feature\n")
	run("add", ".")
	run("commit", "-qm", "feature work")

	run("checkout", "-q", "main")

	// Dirty an unrelated tracked file the merge won't touch.
	write("unrelated.txt", "uncommitted edit\n")

	if err := Merge(dir, "feature", "t", "t@e"); err != nil {
		t.Fatalf("merge should succeed with unrelated dirty file, got: %v", err)
	}

	// The merge landed, and the unrelated uncommitted edit survived (a `reset
	// --hard` fast-forward would have discarded it).
	if !gitContains(t, dir, "main", "feature") {
		t.Errorf("main did not advance to include feature")
	}
	if got := read("feature.txt"); got != "from feature\n" {
		t.Errorf("feature.txt not updated by merge: got %q", got)
	}
	if got := read("unrelated.txt"); got != "uncommitted edit\n" {
		t.Errorf("unrelated uncommitted edit was lost: got %q", got)
	}
}

func revParse(t *testing.T, dir, ref string) string {
	t.Helper()
	out, err := gitOutput(dir, "rev-parse", ref)
	if err != nil {
		t.Fatalf("rev-parse %s: %v", ref, err)
	}
	return out
}

// gitContains reports whether ref is an ancestor of branch (i.e. branch contains
// ref's commit).
func gitContains(t *testing.T, dir, branch, ref string) bool {
	t.Helper()
	ok, err := gitIsAncestor(dir, ref, branch)
	if err != nil {
		t.Fatalf("is-ancestor %s %s: %v", ref, branch, err)
	}
	return ok
}
