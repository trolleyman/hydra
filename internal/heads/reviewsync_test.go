package heads

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/paths"
	"github.com/trolleyman/hydra/internal/session"
)

// syncRepo builds a repo on `main` with one commit, and returns its root.
func syncRepo(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", root}, args...)...)
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@e",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@e",
		)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %s: %v: %s", strings.Join(args, " "), err, out)
		}
	}
	run("init", "-b", "main")
	if err := os.WriteFile(filepath.Join(root, "a.txt"), []byte("one\n"), 0644); err != nil {
		t.Fatal(err)
	}
	run("add", "-A")
	run("commit", "-m", "first")
	return root
}

func syncCommit(t *testing.T, root, branch, file, body, msg string) {
	t.Helper()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", root}, args...)...)
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@e",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@e",
		)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %s: %v: %s", strings.Join(args, " "), err, out)
		}
	}
	if git.BranchExists(root, branch) {
		run("checkout", branch)
	} else {
		run("checkout", "-b", branch)
	}
	if err := os.WriteFile(filepath.Join(root, file), []byte(body), 0644); err != nil {
		t.Fatal(err)
	}
	run("add", "-A")
	run("commit", "-m", msg)
}

// A reviewer with no live session gets its checkout moved forward silently: the
// tree must follow the head's commits, and there is nobody to tell.
func TestSyncReviewCheckoutMovesADetachedCheckout(t *testing.T) {
	root := syncRepo(t)
	branch := "hydra/head-1"
	syncCommit(t, root, branch, "b.txt", "two\n", "second")

	if _, err := EnsureReviewCheckout(root, "head-1", branch); err != nil {
		t.Fatalf("create review checkout: %v", err)
	}
	dir := paths.GetReviewCheckoutDirFromProjectRoot(root, "head-1")
	before, err := git.ResolveRef(dir, "HEAD")
	if err != nil {
		t.Fatalf("resolve checkout HEAD: %v", err)
	}

	// The head commits twice more while the reviewer sits on the old tip.
	syncCommit(t, root, branch, "c.txt", "three\n", "third")
	syncCommit(t, root, branch, "d.txt", "four\n", "fourth")

	SyncReviewCheckout(session.NewRegistry(), root, "head-1", branch)

	after, err := git.ResolveRef(dir, "HEAD")
	if err != nil {
		t.Fatalf("resolve checkout HEAD after sync: %v", err)
	}
	tip, err := git.ResolveRef(root, branch)
	if err != nil {
		t.Fatal(err)
	}
	if after == before {
		t.Fatal("review checkout did not move; the reviewer is still reading the old commit")
	}
	if after != tip {
		t.Fatalf("review checkout at %s, want the branch tip %s", after, tip)
	}
	// The working tree must actually carry the new files, not just the ref.
	if _, err := os.Stat(filepath.Join(dir, "d.txt")); err != nil {
		t.Errorf("checkout moved but its files did not: %v", err)
	}
}

// A head nobody has reviewed must not get a checkout conjured for it - that is
// the whole point of the slot being lazy.
func TestSyncReviewCheckoutIgnoresHeadsWithNoReviewer(t *testing.T) {
	root := syncRepo(t)
	branch := "hydra/head-2"
	syncCommit(t, root, branch, "b.txt", "two\n", "second")

	SyncReviewCheckout(session.NewRegistry(), root, "head-2", branch)

	dir := paths.GetReviewCheckoutDirFromProjectRoot(root, "head-2")
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("sync created a review checkout for a head with no reviewer (%v)", err)
	}
}

// The tree must never move under a running turn: the reviewer reads files across
// several tool calls, and swapping the tree mid-turn has it reading half of one
// commit and half of another.
func TestSyncReviewCheckoutSkipsAMidTurnReviewer(t *testing.T) {
	root := syncRepo(t)
	branch := "hydra/head-3"
	syncCommit(t, root, branch, "b.txt", "two\n", "second")
	if _, err := EnsureReviewCheckout(root, "head-3", branch); err != nil {
		t.Fatalf("create review checkout: %v", err)
	}
	dir := paths.GetReviewCheckoutDirFromProjectRoot(root, "head-3")
	before, _ := git.ResolveRef(dir, "HEAD")
	syncCommit(t, root, branch, "c.txt", "three\n", "third")

	slotID := ReviewSessionID("head-3")
	if err := WriteAgentStatus(root, slotID, &api.AgentStatusInfo{
		Status: api.Running, Timestamp: time.Now().Format(time.RFC3339Nano),
	}); err != nil {
		t.Fatalf("write review status: %v", err)
	}

	// A status of "running" only pins the tree while the SESSION is live: a stale
	// running left behind by a dead reviewer must not freeze the checkout forever.
	SyncReviewCheckout(session.NewRegistry(), root, "head-3", branch)
	if after, _ := git.ResolveRef(dir, "HEAD"); after == before {
		t.Error("a stale 'running' status from a dead session pinned the checkout")
	}
	if !reviewIsMidTurn(root, slotID) {
		t.Error("reviewIsMidTurn does not read the slot's own status file")
	}
}

// The reviewer must be told that its tree moves under it in its SYSTEM PROMPT -
// that line is what replaced the per-commit catch-up message, and dropping it
// would leave a reviewer quietly trusting reads from an older commit.
func TestReviewSystemPromptWarnsAboutTheMovingCheckout(t *testing.T) {
	for _, want := range []string{"moved forward", "re-read"} {
		if !strings.Contains(reviewSystemPrompt, want) {
			t.Errorf("review system prompt does not mention %q:\n%s", want, reviewSystemPrompt)
		}
	}
}
