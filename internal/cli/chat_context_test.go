package cli

import (
	"testing"

	"github.com/trolleyman/hydra/internal/db"
	"github.com/trolleyman/hydra/internal/heads"
	"github.com/trolleyman/hydra/internal/paths"
)

// A review slot has no db.Agent row, so without the slot fallback the chat event
// manager cannot resolve it at all and silently drops every line the reviewer
// prints - which is what made the Review tab replay the HEAD's conversation.
//
// The two fields that must NOT be inherited are the worktree (the reviewer has
// its own checkout, and the worktree is what keys its Claude transcript) and the
// prompt/plan seeds (the head's task and to-do list are not the reviewer's).
func TestChatContextResolverResolvesTheReviewSlot(t *testing.T) {
	root := t.TempDir()
	store, err := db.Open(root)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	if err := store.CreateAgent(&db.Agent{
		ID:          "fix-the",
		ProjectPath: root,
		AgentType:   "claude",
		Prompt:      "fix the thing",
		Plan:        `[{"content":"step one","status":"pending"}]`,
	}); err != nil {
		t.Fatalf("create agent: %v", err)
	}
	resolve := chatContextResolver(store)

	head, ok := resolve("fix-the")
	if !ok {
		t.Fatal("head's own session did not resolve")
	}
	if head.Prompt == "" || head.Plan == "" {
		t.Errorf("head context lost its seeds: %+v", head)
	}
	if head.Worktree != root {
		t.Errorf("focused head working directory = %q, want project root %q", head.Worktree, root)
	}
	if !head.ProjectDirectory {
		t.Error("focused head context was not marked as project-directory mode")
	}

	if err := store.CreateAgent(&db.Agent{
		ID: "worktree-head", ProjectPath: root, AgentType: "claude", BranchName: "hydra/worktree-head",
	}); err != nil {
		t.Fatalf("create worktree agent: %v", err)
	}
	worktree, ok := resolve("worktree-head")
	if !ok {
		t.Fatal("worktree head did not resolve")
	}
	if worktree.ProjectDirectory {
		t.Error("worktree head context was marked as project-directory mode")
	}
	if want := paths.GetWorktreeDirFromProjectRoot(root, "worktree-head"); worktree.Worktree != want {
		t.Errorf("worktree head working directory = %q, want %q", worktree.Worktree, want)
	}

	review, ok := resolve(heads.ReviewSessionID("fix-the"))
	if !ok {
		t.Fatal("review slot did not resolve; its chat events would be dropped")
	}
	if review.ProjectRoot != root {
		t.Errorf("review project root = %q, want %q", review.ProjectRoot, root)
	}
	if want := paths.GetReviewCheckoutDirFromProjectRoot(root, "fix-the"); review.Worktree != want {
		t.Errorf("review worktree = %q, want its own checkout %q", review.Worktree, want)
	}
	if review.Worktree == head.Worktree {
		t.Error("review slot shares the head's worktree; their transcripts would collide")
	}
	if review.Prompt != "" || review.Plan != "" {
		t.Errorf("review slot inherited the head's prompt/plan: %+v", review)
	}

	// Anything that is not a review slot of a known head stays unresolved rather
	// than falling back to the head - a shell tab has no chat log at all.
	for _, id := range []string{
		heads.ShellSessionID("fix-the", true, "t"),
		heads.ReviewSessionID("no-such-head"),
		"no-such-head",
	} {
		if _, ok := resolve(id); ok {
			t.Errorf("resolve(%q) = ok, want unresolved", id)
		}
	}
}
