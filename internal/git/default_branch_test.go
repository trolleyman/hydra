package git

import (
	"os/exec"
	"testing"
)

func TestDefaultBranchIgnoresIncidentalCurrentBranch(t *testing.T) {
	branches := []string{"hydra/recent", "random-work", "main"}
	if got := DefaultBranch(t.TempDir(), branches, "random-work"); got != "main" {
		t.Fatalf("DefaultBranch = %q, want main", got)
	}
}

func TestDefaultBranchFallsBackToCurrentForUnconventionalLocalRepo(t *testing.T) {
	branches := []string{"develop"}
	if got := DefaultBranch(t.TempDir(), branches, "develop"); got != "develop" {
		t.Fatalf("DefaultBranch = %q, want develop", got)
	}
}

func TestDefaultBranchUsesOriginHeadBeforeConventionalNames(t *testing.T) {
	dir := t.TempDir()
	if out, err := exec.Command("git", "init", dir).CombinedOutput(); err != nil {
		t.Fatalf("git init: %v: %s", err, out)
	}
	if out, err := exec.Command("git", "-C", dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk").CombinedOutput(); err != nil {
		t.Fatalf("set origin HEAD: %v: %s", err, out)
	}
	branches := []string{"main", "trunk"}
	if got := DefaultBranch(dir, branches, "main"); got != "trunk" {
		t.Fatalf("DefaultBranch = %q, want trunk", got)
	}
}
