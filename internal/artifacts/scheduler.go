package artifacts

import "sync"

// genScheduler bounds how many artifact generations run at once and orders the
// queue by priority: foreground requests (a user actively viewing a diff) are
// always granted a free slot before queued background ones (proactive
// pre-generation). It does NOT preempt — a generation that already holds a slot
// runs to completion regardless of priority — so background work is never
// wasted; foreground simply jumps the *queue*. A foreground request that lands
// on an already-queued background entry can promote it (see promote), so the
// thing the user is now watching stops waiting behind other background work.
//
// The limit is mutable (setLimit) so a config change to artifact_concurrency
// takes effect without recreating the manager. A limit of 0 means unlimited
// (no cap) — every acquire is granted immediately.
type genScheduler struct {
	mu      sync.Mutex
	limit   int // 0 = unlimited (no cap)
	running int
	seq     int                // monotonic FIFO tiebreaker among equal-priority waiters
	waiters map[string]*waiter // queued (not-yet-granted) waiters, keyed by entry dir
}

// waiter is one queued acquire. ready is closed when the slot is handed to it
// (the running count is transferred, not re-incremented). fg marks foreground
// priority; seq breaks ties in FIFO order.
type waiter struct {
	ready chan struct{}
	fg    bool
	seq   int
}

func newGenScheduler(limit int) *genScheduler {
	if limit < 0 {
		limit = 0
	}
	return &genScheduler{limit: limit, waiters: map[string]*waiter{}}
}

// hasCapacityLocked reports whether another generation may start right now. A
// limit of 0 means unlimited (always capacity). Caller holds mu.
func (s *genScheduler) hasCapacityLocked() bool {
	return s.limit == 0 || s.running < s.limit
}

// acquire blocks until a generation slot is free, honoring priority. key is the
// entry dir, which is unique per in-flight generation (the manager dedups by
// dir before calling acquire), so it doubles as the promotion handle. fg sets
// the initial priority. The caller must call release when the generation ends.
func (s *genScheduler) acquire(key string, fg bool) {
	s.mu.Lock()
	if s.hasCapacityLocked() {
		s.running++
		s.mu.Unlock()
		return
	}
	w := &waiter{ready: make(chan struct{}), fg: fg, seq: s.seq}
	s.seq++
	s.waiters[key] = w
	s.mu.Unlock()
	<-w.ready
}

// release returns a slot, handing it to the highest-priority queued waiter
// (foreground before background, then FIFO) rather than decrementing, so the
// slot is transferred without a window where it sits idle while a waiter exists.
func (s *genScheduler) release() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if k, w := s.bestLocked(); w != nil {
		delete(s.waiters, k)
		close(w.ready) // running stays — the slot is transferred to this waiter
		return
	}
	s.running--
}

// promote raises a still-queued waiter to foreground priority, so a background
// pre-generation the user has now opened jumps ahead of other background work.
// A no-op if the entry isn't queued (already running, already foreground, or
// not tracked).
func (s *genScheduler) promote(key string) {
	s.mu.Lock()
	if w := s.waiters[key]; w != nil {
		w.fg = true
	}
	s.mu.Unlock()
}

// setLimit changes the concurrency cap. Raising it immediately grants slots to
// the highest-priority queued waiters; lowering it just stops new grants until
// running generations drain back under the new cap (no preemption).
func (s *genScheduler) setLimit(n int) {
	if n < 0 {
		n = 0
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.limit = n
	for s.hasCapacityLocked() {
		k, w := s.bestLocked()
		if w == nil {
			break
		}
		delete(s.waiters, k)
		s.running++
		close(w.ready)
	}
}

// bestLocked returns the highest-priority queued waiter (foreground first, then
// lowest seq) and its key, or ("", nil) when none are queued. Caller holds mu.
func (s *genScheduler) bestLocked() (string, *waiter) {
	var bestKey string
	var best *waiter
	for k, w := range s.waiters {
		if best == nil || better(w, best) {
			best, bestKey = w, k
		}
	}
	return bestKey, best
}

// better reports whether waiter a outranks b: foreground beats background, and
// among equal priority the earlier (lower seq) wins.
func better(a, b *waiter) bool {
	if a.fg != b.fg {
		return a.fg
	}
	return a.seq < b.seq
}
