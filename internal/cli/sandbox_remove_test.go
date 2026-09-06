package cli

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRemoveSandboxPathsRemovesWorktreeAndTempDescendants(t *testing.T) {
	root := t.TempDir()
	worktree := filepath.Join(root, "worktree")
	tempDir := filepath.Join(root, "tmp")
	workScratch := filepath.Join(worktree, ".scratch", "nested")
	tempScratch := filepath.Join(tempDir, "test-run")
	for _, dir := range []string{workScratch, tempScratch} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "file"), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	if err := removeSandboxPaths([]string{filepath.Dir(workScratch), tempScratch}, worktree, tempDir); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{filepath.Dir(workScratch), tempScratch} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Errorf("removed path %q still exists: %v", path, err)
		}
	}
	for _, path := range []string{worktree, tempDir} {
		if _, err := os.Stat(path); err != nil {
			t.Errorf("writable root %q was removed: %v", path, err)
		}
	}
}

func TestRemoveSandboxPathsRejectsUnsafeTargetsBeforeDeleting(t *testing.T) {
	root := t.TempDir()
	worktree := filepath.Join(root, "worktree")
	tempDir := filepath.Join(root, "tmp")
	outside := filepath.Join(root, "outside")
	scratch := filepath.Join(worktree, "scratch")
	for _, dir := range []string{worktree, tempDir, outside, scratch} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}

	tests := []struct {
		name   string
		target string
	}{
		{"relative", "scratch"},
		{"worktree root", worktree},
		{"temporary root", tempDir + string(filepath.Separator)},
		{"outside", outside},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := removeSandboxPaths([]string{tt.target}, worktree, tempDir); err == nil {
				t.Fatalf("removeSandboxPaths(%q) succeeded", tt.target)
			}
		})
	}

	if err := removeSandboxPaths([]string{scratch, outside}, worktree, tempDir); err == nil {
		t.Fatal("mixed safe and unsafe request succeeded")
	}
	if _, err := os.Stat(scratch); err != nil {
		t.Fatalf("safe target was removed before later target failed validation: %v", err)
	}
}

func TestRemoveSandboxPathsDoesNotFollowEscapingSymlink(t *testing.T) {
	root := t.TempDir()
	worktree := filepath.Join(root, "worktree")
	tempDir := filepath.Join(root, "tmp")
	outside := filepath.Join(root, "outside")
	for _, dir := range []string{worktree, tempDir, outside} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	outsideFile := filepath.Join(outside, "keep")
	if err := os.WriteFile(outsideFile, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(worktree, "escape")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}

	if err := removeSandboxPaths([]string{filepath.Join(link, "keep")}, worktree, tempDir); err == nil {
		t.Fatal("removal through an escaping symlink succeeded")
	}
	if _, err := os.Stat(outsideFile); err != nil {
		t.Fatalf("outside file was removed through symlink: %v", err)
	}
}
