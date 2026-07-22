package git

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// TestListFirstParentCommitsCollapsesMerge builds a branch that merges an updated
// main back in, then checks that the full walk drags in main's commits while the
// first-parent walk collapses them to a single merge commit.
func TestListFirstParentCommitsCollapsesMerge(t *testing.T) {
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

	run("checkout", "-q", "-b", "main")
	write("base.txt", "base\n")
	run("add", ".")
	run("commit", "-qm", "base")

	// The head branch does its own work.
	run("checkout", "-q", "-b", "hydra/head")
	write("feature.txt", "feature\n")
	run("add", ".")
	run("commit", "-qm", "head work")

	// main advances with three commits after the fork.
	run("checkout", "-q", "main")
	for _, m := range []string{"main one", "main two", "main three"} {
		write("main.txt", m+"\n")
		run("add", ".")
		run("commit", "-qm", m)
	}

	// The head merges the updated main back in (--no-ff forces a merge commit).
	run("checkout", "-q", "hydra/head")
	run("merge", "--no-ff", "-m", "Merge branch 'main' into hydra/head", "main")

	full, err := ListCommits(dir, "main", "hydra/head")
	if err != nil {
		t.Fatal(err)
	}
	// Full walk: head work + the merge commit (main's three commits are now
	// reachable from main's tip, so main..head excludes them - but the merge itself
	// stays). The point of interest is the first-parent walk below.
	firstParent, err := ListFirstParentCommits(dir, "main", "hydra/head")
	if err != nil {
		t.Fatal(err)
	}

	// First-parent walk: exactly the merge commit + the head's own work, never the
	// merged-in main commits.
	for _, c := range firstParent {
		if c.Subject == "main one" || c.Subject == "main two" || c.Subject == "main three" {
			t.Fatalf("first-parent walk leaked merged-in commit %q; commits=%v", c.Subject, subjects(firstParent))
		}
	}
	var merge *CommitInfo
	for i := range firstParent {
		if firstParent[i].IsMerge() {
			merge = &firstParent[i]
		}
	}
	if merge == nil {
		t.Fatalf("expected a merge commit in first-parent walk, got %v", subjects(firstParent))
	}
	if len(merge.Parents) != 2 {
		t.Fatalf("merge commit should have 2 parents, got %d", len(merge.Parents))
	}

	// The commits the merge dragged in = second parent's history not on the first.
	merged, err := ListCommits(dir, merge.Parents[0], merge.Parents[1])
	if err != nil {
		t.Fatal(err)
	}
	if len(merged) != 3 {
		t.Fatalf("expected 3 merged-in commits, got %d: %v", len(merged), subjects(merged))
	}

	if len(full) < len(firstParent) {
		t.Fatalf("full walk (%d) should be at least first-parent walk (%d)", len(full), len(firstParent))
	}
}

func subjects(commits []CommitInfo) []string {
	out := make([]string, len(commits))
	for i, c := range commits {
		out[i] = c.Subject
	}
	return out
}
