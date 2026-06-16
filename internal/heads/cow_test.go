package heads

import (
	"os"
	"path/filepath"
	"testing"
)

func TestBuildCowMountsWritable(t *testing.T) {
	root := t.TempDir()
	worktree := filepath.Join(root, ".hydra", "worktrees", "h1")
	// Source dirs under the project root.
	for _, d := range []string{"pipeline/out", "pipeline/build/input"} {
		if err := os.MkdirAll(filepath.Join(root, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(worktree, 0o755); err != nil {
		t.Fatal(err)
	}

	mounts := buildCowMounts(root, worktree, "h1", []string{"pipeline/out", "pipeline/build/input", "missing/dir"}, true)
	if len(mounts) != 2 {
		t.Fatalf("got %d mounts, want 2 (missing source skipped): %+v", len(mounts), mounts)
	}

	m := mounts[0]
	if m.Lower != filepath.Join(root, "pipeline/out") {
		t.Errorf("Lower = %q", m.Lower)
	}
	if m.Dest != filepath.Join(worktree, "pipeline/out") {
		t.Errorf("Dest = %q", m.Dest)
	}
	if m.Upper == "" || m.Work == "" {
		t.Errorf("writable mount missing Upper/Work: %+v", m)
	}
	// Upper/Work/Dest must all exist on disk after the call.
	for _, p := range []string{m.Upper, m.Work, m.Dest} {
		if _, err := os.Stat(p); err != nil {
			t.Errorf("expected %q to exist: %v", p, err)
		}
	}
	// COW layers live outside the worktree (so they stay out of git status).
	if filepathHasPrefix(m.Upper, worktree) {
		t.Errorf("Upper %q must not live inside the worktree %q", m.Upper, worktree)
	}
}

func TestBuildCowMountsReadOnly(t *testing.T) {
	root := t.TempDir()
	worktree := filepath.Join(root, ".hydra", "worktrees", "h1")
	if err := os.MkdirAll(filepath.Join(root, "pipeline/out"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(worktree, 0o755); err != nil {
		t.Fatal(err)
	}
	mounts := buildCowMounts(root, worktree, "h1", []string{"pipeline/out"}, false)
	if len(mounts) != 1 {
		t.Fatalf("got %d mounts, want 1", len(mounts))
	}
	if mounts[0].Upper != "" || mounts[0].Work != "" {
		t.Errorf("read-only mount must leave Upper/Work empty: %+v", mounts[0])
	}
}

func TestBuildCowMountsRejectsEscapes(t *testing.T) {
	root := t.TempDir()
	worktree := filepath.Join(root, "wt")
	if err := os.MkdirAll(worktree, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"/etc", "../escape", "..", ".."} {
		if m := buildCowMounts(root, worktree, "h1", []string{bad}, true); len(m) != 0 {
			t.Errorf("path %q should be rejected, got %+v", bad, m)
		}
	}
}

func filepathHasPrefix(p, prefix string) bool {
	rel, err := filepath.Rel(prefix, p)
	if err != nil {
		return false
	}
	return rel != ".." && !filepath.IsAbs(rel) && rel != "" && !startsWithDotDot(rel)
}

func startsWithDotDot(rel string) bool {
	return len(rel) >= 2 && rel[0] == '.' && rel[1] == '.'
}
