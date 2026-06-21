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
// anything that depends on the working tree (uncommitted/untracked changes) — that
// is mutable and has no stable key.
//
// Eviction is FIFO with a fixed cap (insertion order, not true LRU). Correctness
// never depends on a hit, so the simpler policy is fine; the cap just bounds
// memory. The zero value is usable: the map is allocated lazily on first put and
// a nil/zero max falls back to defaultGitCacheMax.
type immutableCache[V any] struct {
	mu      sync.Mutex
	entries map[string]V
	order   []string
	max     int
}

const defaultGitCacheMax = 256

func (c *immutableCache[V]) get(key string) (V, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	v, ok := c.entries[key]
	return v, ok
}

func (c *immutableCache[V]) put(key string, v V) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.entries == nil {
		c.entries = make(map[string]V)
	}
	max := c.max
	if max <= 0 {
		max = defaultGitCacheMax
	}
	if _, exists := c.entries[key]; !exists {
		c.order = append(c.order, key)
		for len(c.order) > max {
			oldest := c.order[0]
			c.order = c.order[1:]
			delete(c.entries, oldest)
		}
	}
	c.entries[key] = v
}
