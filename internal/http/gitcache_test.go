package http

import (
	"strconv"
	"testing"
)

// TestImmutableCacheByteBudget verifies that the cache evicts by total bytes, not
// just entry count: a stream of moderately-sized entries is held to the byte
// budget even though the entry-count cap is never reached.
func TestImmutableCacheByteBudget(t *testing.T) {
	c := &immutableCache[string]{maxItems: 1000, maxBytes: 1000}
	// Insert 100 entries of cost 100 each (10_000 bytes total) - way over the 1000
	// byte budget but well under the 1000 entry cap.
	for i := 0; i < 100; i++ {
		c.put("k"+strconv.Itoa(i), "v", 100)
	}
	c.mu.Lock()
	total := c.curBytes
	count := len(c.order)
	mapLen := len(c.entries)
	c.mu.Unlock()
	if total > 1000 {
		t.Fatalf("curBytes = %d, want <= 1000", total)
	}
	if count != mapLen {
		t.Fatalf("order/entries desync: order=%d entries=%d", count, mapLen)
	}
	// Only the most recent entries survive (FIFO): the last key must be present, an
	// early one evicted.
	if _, ok := c.get("k99"); !ok {
		t.Fatal("most recent entry k99 should be cached")
	}
	if _, ok := c.get("k0"); ok {
		t.Fatal("oldest entry k0 should have been evicted")
	}
}

// TestImmutableCacheSkipsOversizedEntry verifies that an entry larger than the
// whole budget is not cached at all (and doesn't evict the existing contents).
func TestImmutableCacheSkipsOversizedEntry(t *testing.T) {
	c := &immutableCache[string]{maxBytes: 1000}
	c.put("small", "v", 100)
	c.put("huge", "v", 5000) // exceeds budget on its own
	if _, ok := c.get("huge"); ok {
		t.Fatal("oversized entry should not be cached")
	}
	if _, ok := c.get("small"); !ok {
		t.Fatal("inserting an oversized (skipped) entry must not evict existing entries")
	}
	c.mu.Lock()
	total := c.curBytes
	c.mu.Unlock()
	if total != 100 {
		t.Fatalf("curBytes = %d, want 100 (only the small entry)", total)
	}
}

// TestImmutableCacheEntryCountCap verifies the entry-count cap still applies when
// entries are tiny (byte budget never reached).
func TestImmutableCacheEntryCountCap(t *testing.T) {
	c := &immutableCache[int]{maxItems: 3, maxBytes: 1 << 30}
	for i := 0; i < 10; i++ {
		c.put("k"+strconv.Itoa(i), i, 1)
	}
	c.mu.Lock()
	count := len(c.order)
	c.mu.Unlock()
	if count != 3 {
		t.Fatalf("entry count = %d, want 3", count)
	}
	if _, ok := c.get("k9"); !ok {
		t.Fatal("k9 should be present")
	}
	if _, ok := c.get("k6"); ok {
		t.Fatal("k6 should have been evicted")
	}
}

// TestImmutableCacheReplaceKeyAccounting verifies that re-putting an existing key
// doesn't leak its cost or duplicate it in the eviction order.
func TestImmutableCacheReplaceKeyAccounting(t *testing.T) {
	c := &immutableCache[string]{maxItems: 10, maxBytes: 1 << 30}
	c.put("k", "v", 100)
	c.put("k", "v2", 200)
	c.mu.Lock()
	total := c.curBytes
	count := len(c.order)
	c.mu.Unlock()
	if total != 200 {
		t.Fatalf("curBytes = %d, want 200 (old cost released)", total)
	}
	if count != 1 {
		t.Fatalf("order length = %d, want 1 (key not duplicated)", count)
	}
	if v, _ := c.get("k"); v != "v2" {
		t.Fatalf("get = %q, want v2", v)
	}
}
