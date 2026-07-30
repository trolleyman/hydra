package artifacts

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// seedEntry creates a cache entry for (script, key) with one file, backdated so
// the age-based eviction path will want it.
func seedEntry(t *testing.T, m *Manager, script, key string, age time.Duration) string {
	t.Helper()
	dir := m.entryDir(script, key)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	f := filepath.Join(dir, "home.png")
	if err := os.WriteFile(f, []byte("not really a png"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	old := time.Now().Add(-age)
	for _, p := range []string{f, dir} {
		if err := os.Chtimes(p, old, old); err != nil {
			t.Fatalf("chtimes: %v", err)
		}
	}
	return dir
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// A pin's whole value is being able to go back and look at what it points at, so
// an entry a review comment references must survive the age sweep that would
// otherwise reclaim it.
func TestPruneStaleKeepsPinnedEntries(t *testing.T) {
	m := NewManager(t.TempDir())
	pinned := seedEntry(t, m, "screenshots", "commit/aaaa", 90*24*time.Hour)
	loose := seedEntry(t, m, "screenshots", "commit/bbbb", 90*24*time.Hour)

	if err := m.PruneStale(14*24*time.Hour, 0, []Pin{{Script: "screenshots", Key: "commit/aaaa"}}); err != nil {
		t.Fatalf("prune: %v", err)
	}
	if !exists(pinned) {
		t.Error("the pinned entry was reclaimed - the comment pointing at it now points at nothing")
	}
	if exists(loose) {
		t.Error("an unpinned stale entry survived, so pinning is not what kept the other one")
	}
}

// Exempt from the SIZE cap too. The cap exists to stop the cache growing without
// bound, and pins are themselves bounded - there are only so many comments -
// whereas deleting the evidence for a comment to save disk is the failure this is
// meant to prevent.
func TestPruneStaleKeepsPinnedEntriesUnderTheSizeCap(t *testing.T) {
	m := NewManager(t.TempDir())
	pinned := seedEntry(t, m, "screenshots", "commit/aaaa", time.Hour)
	loose := seedEntry(t, m, "screenshots", "commit/bbbb", 2*time.Hour)

	// maxBytes=1 forces eviction of everything it is allowed to touch.
	if err := m.PruneStale(0, 1, []Pin{{Script: "screenshots", Key: "commit/aaaa"}}); err != nil {
		t.Fatalf("prune: %v", err)
	}
	if !exists(pinned) {
		t.Error("the pinned entry was evicted to fit the size cap")
	}
	if exists(loose) {
		t.Error("the unpinned entry survived a 1-byte cap")
	}
}

// A malformed pin must not silently widen what is kept - in particular it must
// not resolve to the script DIRECTORY and so hold every version of it.
func TestPruneStaleIgnoresMalformedPins(t *testing.T) {
	m := NewManager(t.TempDir())
	loose := seedEntry(t, m, "screenshots", "commit/bbbb", 90*24*time.Hour)

	err := m.PruneStale(14*24*time.Hour, 0, []Pin{
		{Script: "screenshots", Key: ""},
		{Script: "", Key: "commit/bbbb"},
		{Script: "screenshots", Key: "../.."},
		{Script: "screenshots", Key: "commit/../../etc"},
	})
	if err != nil {
		t.Fatalf("prune: %v", err)
	}
	if exists(loose) {
		t.Error("a malformed pin kept an entry it does not name")
	}
}
