package sandbox

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A home-anchored entry overlays the path in place (lower == dest == the resolved
// path) with a writable upper/work pair placed under the supplied layer base, and
// a missing source is skipped.
func TestResolveCowMountsHomeWritable(t *testing.T) {
	root := t.TempDir()
	home := filepath.Join(root, "home")
	gradle := filepath.Join(home, ".gradle")
	layerBase := filepath.Join(root, "layers")
	for _, d := range []string{gradle} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}

	mounts := ResolveCowMounts(root, root, home, layerBase, []string{"~/.gradle", "~/.missing"}, true)
	if len(mounts) != 1 {
		t.Fatalf("got %d mounts, want 1 (missing source skipped): %+v", len(mounts), mounts)
	}
	m := mounts[0]
	if m.Lower != gradle || m.Dest != gradle {
		t.Errorf("home overlay Lower=%q Dest=%q, want both %q", m.Lower, m.Dest, gradle)
	}
	if m.Upper == "" || m.Work == "" {
		t.Errorf("writable mount missing Upper/Work: %+v", m)
	}
	// The layers live under the supplied base, never inside the real home dir.
	if !strings.HasPrefix(m.Upper, layerBase) {
		t.Errorf("Upper %q must live under layer base %q", m.Upper, layerBase)
	}
	for _, p := range []string{m.Upper, m.Work} {
		if _, err := os.Stat(p); err != nil {
			t.Errorf("expected %q to exist: %v", p, err)
		}
	}
}

// A read-only resolution leaves Upper/Work empty so the sandbox exposes the source
// read-only instead of copying up.
func TestResolveCowMountsReadOnly(t *testing.T) {
	root := t.TempDir()
	worktree := filepath.Join(root, "wt")
	if err := os.MkdirAll(filepath.Join(root, "pipeline/out"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(worktree, 0o755); err != nil {
		t.Fatal(err)
	}
	mounts := ResolveCowMounts(root, worktree, "/home/nobody", filepath.Join(root, "layers"), []string{"pipeline/out"}, false)
	if len(mounts) != 1 {
		t.Fatalf("got %d mounts, want 1", len(mounts))
	}
	if mounts[0].Upper != "" || mounts[0].Work != "" {
		t.Errorf("read-only mount must leave Upper/Work empty: %+v", mounts[0])
	}
	if mounts[0].Lower != filepath.Join(root, "pipeline/out") || mounts[0].Dest != filepath.Join(worktree, "pipeline/out") {
		t.Errorf("relative mount mirrored wrong: %+v", mounts[0])
	}
}

// Worktree-relative entries that escape the project root are rejected; absolute
// entries are treated as home/absolute overlays (not rejected here).
func TestResolveCowMountsRejectsRelativeEscapes(t *testing.T) {
	root := t.TempDir()
	worktree := filepath.Join(root, "wt")
	if err := os.MkdirAll(worktree, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"../escape", ".."} {
		if m := ResolveCowMounts(root, worktree, "/home/nobody", filepath.Join(root, "layers"), []string{bad}, true); len(m) != 0 {
			t.Errorf("path %q should be rejected, got %+v", bad, m)
		}
	}
}
