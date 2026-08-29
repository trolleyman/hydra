package heads

import "testing"

func TestFocusedHeadInvariant(t *testing.T) {
	worktree := "/repo/.hydra/local/worktrees/head"
	branch := "hydra/head"
	tests := []struct {
		name       string
		head       Head
		focused    bool
		workingDir string
	}{
		{
			name:       "live focused",
			head:       Head{ProjectPath: "/repo"},
			focused:    true,
			workingDir: "/repo",
		},
		{
			name:       "archived focused",
			head:       Head{ProjectPath: "/repo", Archived: true},
			focused:    true,
			workingDir: "/repo",
		},
		{
			name:       "live ordinary",
			head:       Head{ProjectPath: "/repo", Branch: &branch, Worktree: &worktree},
			workingDir: worktree,
		},
		{
			name: "ordinary with missing worktree",
			head: Head{ProjectPath: "/repo", Branch: &branch},
		},
		{
			name: "archived ordinary",
			head: Head{ProjectPath: "/repo", Branch: &branch, Archived: true},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.head.IsFocused(); got != tt.focused {
				t.Fatalf("IsFocused() = %v, want %v", got, tt.focused)
			}
			if got := tt.head.WorkingDir(); got != tt.workingDir {
				t.Fatalf("WorkingDir() = %q, want %q", got, tt.workingDir)
			}
		})
	}
}
