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

	mounts := buildCowMounts(root, worktree, "/home/nobody", "h1", []string{"pipeline/out", "pipeline/build/input", "missing/dir"}, true)
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
	mounts := buildCowMounts(root, worktree, "/home/nobody", "h1", []string{"pipeline/out"}, false)
	if len(mounts) != 1 {
		t.Fatalf("got %d mounts, want 1", len(mounts))
	}
	if mounts[0].Upper != "" || mounts[0].Work != "" {
		t.Errorf("read-only mount must leave Upper/Work empty: %+v", mounts[0])
	}
}

// Home-anchored and absolute entries overlay the path in place (lower == dest ==
// the resolved path), keyed by a per-head layer, and are expanded against HOME
// like the other sandbox path lists.
func TestBuildCowMountsHomeAndAbsolute(t *testing.T) {
	root := t.TempDir()
	worktree := filepath.Join(root, ".hydra", "worktrees", "h1")
	home := filepath.Join(root, "home")
	gradle := filepath.Join(home, ".gradle")
	absDir := filepath.Join(root, "opt", "cache")
	for _, d := range []string{worktree, gradle, absDir} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}

	mounts := buildCowMounts(root, worktree, home, "h1", []string{"~/.gradle", absDir}, true)
	if len(mounts) != 2 {
		t.Fatalf("got %d mounts, want 2: %+v", len(mounts), mounts)
	}
	for i, want := range []string{gradle, absDir} {
		m := mounts[i]
		if m.Lower != want || m.Dest != want {
			t.Errorf("mount %d: Lower=%q Dest=%q, want both %q", i, m.Lower, m.Dest, want)
		}
		if m.Upper == "" || m.Work == "" {
			t.Errorf("mount %d writable but missing Upper/Work: %+v", i, m)
		}
		// The per-head layer must live outside the real home/source, not inside it.
		if filepathHasPrefix(m.Upper, want) {
			t.Errorf("mount %d Upper %q must not live under the source %q", i, m.Upper, want)
		}
	}
}

func TestBuildCowMountsRejectsRelativeEscapes(t *testing.T) {
	root := t.TempDir()
	worktree := filepath.Join(root, "wt")
	if err := os.MkdirAll(worktree, 0o755); err != nil {
		t.Fatal(err)
	}
	// Worktree-relative entries that escape the project root are still rejected.
	// Absolute entries are NOT rejected here (they are home/absolute overlays); a
	// missing source is what drops them, tested elsewhere.
	for _, bad := range []string{"../escape", ".."} {
		if m := buildCowMounts(root, worktree, "/home/nobody", "h1", []string{bad}, true); len(m) != 0 {
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
