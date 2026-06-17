package git

import (
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
