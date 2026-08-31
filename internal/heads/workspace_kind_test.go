package heads

import (
	"testing"

	"github.com/trolleyman/hydra/internal/api"
)

func TestWorkspaceKindInvariant(t *testing.T) {
	worktree := "/repo/.hydra/local/worktrees/head"
	branch := "hydra/head"
	tests := []struct {
		name          string
		head          Head
		workspaceKind api.WorkspaceKind
		workingDir    string
	}{
		{
			name:          "live project directory",
			head:          Head{ProjectPath: "/repo"},
			workspaceKind: api.WorkspaceKindProjectDirectory,
			workingDir:    "/repo",
		},
		{
			name:          "archived project directory",
			head:          Head{ProjectPath: "/repo", Archived: true},
			workspaceKind: api.WorkspaceKindProjectDirectory,
			workingDir:    "/repo",
		},
		{
			name:          "live worktree",
			head:          Head{ProjectPath: "/repo", Branch: &branch, Worktree: &worktree},
			workspaceKind: api.WorkspaceKindWorktree,
			workingDir:    worktree,
		},
		{
			name:          "worktree with missing checkout",
			head:          Head{ProjectPath: "/repo", Branch: &branch},
			workspaceKind: api.WorkspaceKindWorktree,
		},
		{
			name:          "archived worktree",
			head:          Head{ProjectPath: "/repo", Branch: &branch, Archived: true},
			workspaceKind: api.WorkspaceKindWorktree,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.head.WorkspaceKind(); got != tt.workspaceKind {
				t.Fatalf("WorkspaceKind() = %q, want %q", got, tt.workspaceKind)
			}
			if got := tt.head.UsesProjectDirectory(); got != (tt.workspaceKind == api.WorkspaceKindProjectDirectory) {
				t.Fatalf("UsesProjectDirectory() = %v for %q", got, tt.workspaceKind)
			}
			if got := tt.head.WorkingDir(); got != tt.workingDir {
				t.Fatalf("WorkingDir() = %q, want %q", got, tt.workingDir)
			}
		})
	}
}
