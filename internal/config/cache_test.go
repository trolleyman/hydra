package config

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestLoadFileCacheReflectsChangesAndIsolatesCallers checks the mtime cache added to
// LoadFile: an unchanged file is memoised, an edited file is re-read, and every
// caller gets an independent deep copy it can mutate without affecting the cache.
func TestLoadFileCacheReflectsChangesAndIsolatesCallers(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")

	write := func(body string) {
		if err := os.WriteFile(path, []byte(body), 0644); err != nil {
			t.Fatalf("write: %v", err)
		}
	}

	write("[policy]\nmcp_allowed = [\"github\"]\n")
	first, err := LoadFile(path)
	if err != nil || first == nil {
		t.Fatalf("first load: %v (cfg=%v)", err, first)
	}
	if p := first.Defaults.Policy; p == nil || len(p.MCPAllowed) != 1 || p.MCPAllowed[0] != "github" {
		t.Fatalf("first load wrong: %+v", first.Defaults.Policy)
	}

	// Second load is served from cache but must be an independent copy: mutating it
	// must not corrupt what a later load sees.
	second, err := LoadFile(path)
	if err != nil || second == nil {
		t.Fatalf("second load: %v", err)
	}
	if second == first {
		t.Fatal("cache returned the same pointer to two callers")
	}
	second.Defaults.Policy.MCPAllowed[0] = "MUTATED"
	second.Defaults.Policy.MCPAllowed = append(second.Defaults.Policy.MCPAllowed, "extra")

	third, err := LoadFile(path)
	if err != nil || third == nil {
		t.Fatalf("third load: %v", err)
	}
	if len(third.Defaults.Policy.MCPAllowed) != 1 || third.Defaults.Policy.MCPAllowed[0] != "github" {
		t.Fatalf("caller mutation leaked into cache: %+v", third.Defaults.Policy.MCPAllowed)
	}

	// An on-disk edit (different mtime/size) must be picked up, not the stale cache.
	// Sleep a hair so the mtime is guaranteed to differ even on coarse clocks.
	time.Sleep(10 * time.Millisecond)
	write("[policy]\nmcp_allowed = [\"github\", \"playwright\"]\n")
	fourth, err := LoadFile(path)
	if err != nil || fourth == nil {
		t.Fatalf("fourth load: %v", err)
	}
	if len(fourth.Defaults.Policy.MCPAllowed) != 2 {
		t.Fatalf("edited file not re-read: %+v", fourth.Defaults.Policy.MCPAllowed)
	}
}
