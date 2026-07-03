package http

import "sync"

// immutableCache is a small, bounded, concurrency-safe cache for results that are
// immutable for a given key. It is used to memoise git history reads (the commit
// list and committed-diff for a fixed pair of commit SHAs): once two commits
// exist, the set of commits between them and the diff between them never change,
// so a cache hit can serve the same git output without re-shelling-out.
//
// Keys must therefore be derived from resolved commit SHAs (never branch names,
// which move) plus any options that change the output. Callers must NOT cache
// anything that depends on the working tree (uncommitted/untracked changes) - that
// is mutable and has no stable key.
//
// Eviction is FIFO (insertion order, not true LRU) bounded by BOTH a fixed entry
// count AND a total byte budget. The byte budget is the important one: a cached
// diff holds an entire parsed diff (every file/hunk/line), so its size is
// unbounded, and a frequently-committing head churns a fresh key per commit (the
// head SHA moves, and context-expansion/per-file fetches add yet more keys).
// Capping only the entry count would let a few hundred large diffs pile up into
// many gigabytes; the byte budget caps the actual memory instead. Each caller
// supplies the per-entry cost (estimated bytes) at put time, so the cache stays
// generic over V. An entry larger than the whole budget is simply not cached -
// correctness never depends on a hit, so it just recomputes live next time.
//
// The zero value is usable: the map is allocated lazily on first put and a
// nil/zero cap falls back to the defaults below.
type immutableCache[V any] struct {
	mu       sync.Mutex
	entries  map[string]cacheEntry[V]
	order    []string
	maxItems int
	maxBytes int64
	curBytes int64
}

// cacheEntry pairs a cached value with the estimated byte cost charged against the
// cache's budget, so eviction can subtract the right amount when a key is dropped.
type cacheEntry[V any] struct {
	val  V
	cost int64
}

const (
	defaultGitCacheMax = 256
	// defaultGitCacheMaxBytes bounds the total estimated memory of a single cache
	// across every key (so across every project - the daemon shares one Server).
	// 64 MiB comfortably holds many ordinary diffs/commit lists while keeping a
	// pathological case (huge generated-file diffs cached once per moving head SHA)
	// from growing without bound.
	defaultGitCacheMaxBytes = int64(64) << 20
)

func (c *immutableCache[V]) get(key string) (V, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[key]
	return e.val, ok
}

// put stores v under key, charging cost (the caller's estimate of v's in-memory
// byte size) against the cache budget. If cost alone exceeds the byte budget the
// value is not cached (and any stale entry under key is dropped); otherwise oldest
// entries are evicted until both the entry-count and total-byte caps hold.
func (c *immutableCache[V]) put(key string, v V, cost int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	maxItems := c.maxItems
	if maxItems <= 0 {
		maxItems = defaultGitCacheMax
	}
	maxBytes := c.maxBytes
	if maxBytes <= 0 {
		maxBytes = defaultGitCacheMaxBytes
	}

	// Drop any existing entry under this key first, so its old cost is released and
	// the key isn't double-counted in c.order.
	if old, exists := c.entries[key]; exists {
		c.curBytes -= old.cost
		delete(c.entries, key)
		c.removeOrderLocked(key)
	}

	// An entry that can't fit even on its own would evict everything else and still
	// not help; skip it. The cache is a pure optimization, so this just means a
	// recompute next time.
	if cost > maxBytes {
		return
	}

	if c.entries == nil {
		c.entries = make(map[string]cacheEntry[V])
	}
	c.entries[key] = cacheEntry[V]{val: v, cost: cost}
	c.order = append(c.order, key)
	c.curBytes += cost

	for len(c.order) > 0 && (len(c.order) > maxItems || c.curBytes > maxBytes) {
		oldest := c.order[0]
		c.order = c.order[1:]
		if e, ok := c.entries[oldest]; ok {
			c.curBytes -= e.cost
			delete(c.entries, oldest)
		}
	}
}

// removeOrderLocked drops key from the insertion-order slice. Caller holds c.mu.
func (c *immutableCache[V]) removeOrderLocked(key string) {
	for i, k := range c.order {
		if k == key {
			c.order = append(c.order[:i], c.order[i+1:]...)
			return
		}
	}
}
