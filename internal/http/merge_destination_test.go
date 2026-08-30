package http

import (
	"slices"
	"testing"

	"github.com/trolleyman/hydra/internal/db"
)

func TestMergeDestinationChatIDs(t *testing.T) {
	agents := []db.Agent{
		{ID: "target-worktree", BranchName: "hydra/target", ChatMode: true},
		{ID: "project-directory", ChatMode: true},
		{ID: "source", BranchName: "hydra/source", ChatMode: true},
		{ID: "terminal-target", BranchName: "hydra/target"},
	}

	got := mergeDestinationChatIDs(agents, "hydra/target", "hydra/target")
	if want := []string{"target-worktree", "project-directory"}; !slices.Equal(got, want) {
		t.Fatalf("destination chats = %v, want %v", got, want)
	}

	got = mergeDestinationChatIDs(agents, "hydra/target", "main")
	if want := []string{"target-worktree"}; !slices.Equal(got, want) {
		t.Fatalf("destination chats off project branch = %v, want %v", got, want)
	}
}
