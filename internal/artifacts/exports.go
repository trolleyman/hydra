package artifacts

import "braces.dev/errtrace"

// This file exposes the bounded worktree-slot pool and the priority generation
// scheduler to sibling generators (notably internal/tests, the per-project test
// runner) so they reuse the exact same checkout/concurrency machinery instead of
// duplicating it (see PLAN #68). The artifacts package keeps using the unexported
// names internally; these are thin, allocation-free wrappers over the same code.

// SlotPool is the exported handle for the reusable detached-worktree pool. See
// slotPool for the implementation and crash-safety guarantees.
type SlotPool = slotPool

// Slot is one reusable detached-HEAD worktree handed out by a SlotPool.
type Slot = slot

// GenScheduler is the exported handle for the priority generation scheduler. See
// genScheduler for the queueing/priority semantics.
type GenScheduler = genScheduler

// NewSlotPool creates a worktree-slot pool rooted at dir for projectRoot, capped
// at maxSlots (0 = unbounded). A sibling generator should give it a dir distinct
// from the artifacts pool's so the two don't fight over the same worktrees.
func NewSlotPool(projectRoot, dir string, maxSlots int) *SlotPool {
	return newSlotPool(projectRoot, dir, maxSlots)
}

// NewGenScheduler creates a generation scheduler with the given concurrency limit
// (0 = unlimited).
func NewGenScheduler(limit int) *GenScheduler {
	return newGenScheduler(limit)
}

// SlotsForConcurrency sizes a slot pool for a generation concurrency, matching the
// artifacts pool's sizing so a sibling generator inherits the same warm-slot
// headroom.
func SlotsForConcurrency(n int) int { return slotsForConcurrency(n) }

// Path returns the worktree directory a Slot currently has checked out.
func (s *slot) Path() string { return s.path }

// Acquire returns a worktree checked out at sha; release it with Release.
func (p *slotPool) Acquire(sha string, cleanIgnored bool) (*Slot, error) {
	return errtrace.Wrap2(p.acquire(sha, cleanIgnored))
}

// Release returns a slot to the pool for reuse.
func (p *slotPool) Release(s *Slot) { p.release(s) }

// SetMaxSlots resizes the pool's cap (0 = unbounded).
func (p *slotPool) SetMaxSlots(n int) { p.setMaxSlots(n) }

// Clean tears the pool down to empty (call on boot before any generation).
func (p *slotPool) Clean() { p.clean() }

// Acquire blocks until a generation slot is free, honoring foreground priority.
func (s *genScheduler) Acquire(key string, fg bool) { s.acquire(key, fg) }

// Release returns a generation slot, handing it to the best queued waiter.
func (s *genScheduler) Release() { s.release() }

// Promote raises a still-queued waiter to foreground priority.
func (s *genScheduler) Promote(key string) { s.promote(key) }

// SetLimit changes the concurrency cap (0 = unlimited).
func (s *genScheduler) SetLimit(n int) { s.setLimit(n) }
