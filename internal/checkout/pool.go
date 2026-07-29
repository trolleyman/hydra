// Package checkout hands out a small, bounded pool of reusable detached-HEAD
// worktrees ("slots") for running work against a specific commit - artifact
// generation, test runs, and anything else that needs a tree at a SHA without
// paying to create and destroy a full worktree per run.
//
// It is deliberately free of any knowledge of its callers: each consumer owns
// its own Pool, rooted at its own directory and sized by its own concurrency
// (see SlotsForConcurrency), so two consumers never fight over the same
// worktrees.
package checkout

import (
	"os"
	"path/filepath"
	"strconv"
	"sync"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/git"
)

// maxSlots is the floor on how many persistent worktree slots a pool keeps (see
// SlotsForConcurrency). Generations are already bounded by their consumer's
// concurrency limit, so at most that many slots are ever held at once; the
// headroom up to 4 lets freed slots stay "warm" on recently-used commits for
// zero-cost affinity reuse.
const maxSlots = 4

// SlotsForConcurrency sizes a worktree-slot pool for a generation concurrency.
// Every commit-side generation holds one slot for its duration, so the pool must
// have at least `n` slots or concurrent commit-side gens would deadlock waiting
// for a slot. The +2 keeps freed slots "warm" on recently-used commits for
// zero-cost affinity reuse, and the floor of maxSlots preserves that headroom at
// the default concurrency. n == 0 (unlimited concurrency) maps to 0 (an
// unbounded pool) so commit-side gens never block on a slot.
//
// It takes a plain int rather than a scheduler, so this package stays independent
// of whatever bounds the concurrency on the other side.
func SlotsForConcurrency(n int) int {
	if n <= 0 {
		return 0
	}
	return max(maxSlots, n+2)
}

// Slot is one reusable detached-HEAD worktree. sha is the commit it currently has
// checked out ("" when unknown - freshly failed or never checked out), used to
// serve an affinity hit (reuse with no git work) when a later acquire wants the
// same commit.
type Slot struct {
	path string
	sha  string
}

// Path returns the worktree directory the slot currently has checked out.
func (s *Slot) Path() string { return s.path }

// Pool hands out a small, bounded set of persistent detached worktrees, reusing
// them via cheap incremental `git checkout` instead of recreating a full worktree
// per commit. See PLAN #51.
//
// The pool is crash-safe by construction: slots hold no durable state, so a
// process that dies mid-generation just leaves worktree dirs behind, which Clean
// (run on boot, e.g. via a manager's CleanCheckouts) wipes and prunes. The
// in-memory pool then starts empty and recreates slots on demand.
type Pool struct {
	projectRoot string
	dir         string // this pool's own slots dir, e.g. <artifacts>/slots
	maxSlots    int

	mu    sync.Mutex
	cond  *sync.Cond
	all   []*Slot // every live slot (created, not yet cleaned)
	free  []*Slot // currently-available subset of all
	nextN int     // monotonic slot-dir name counter (never reused, avoids collisions)
}

// NewPool creates a worktree-slot pool rooted at dir for projectRoot, capped at
// max live slots (0 = unbounded). Each consumer should give it a dir distinct
// from every other pool's so the two don't fight over the same worktrees.
func NewPool(projectRoot, dir string, max int) *Pool {
	p := &Pool{projectRoot: projectRoot, dir: dir, maxSlots: max}
	p.cond = sync.NewCond(&p.mu)
	return p
}

// SetMaxSlots adjusts the cap on live worktree slots, so the pool can grow with
// a raised generation concurrency. Raising it wakes any acquire blocked on the
// old cap (there is now room to grow a new slot); lowering it just stops further
// growth - existing slots stay until Clean. Each commit-side generation holds
// one slot for its duration, so the cap must stay at least as large as the
// generation concurrency or acquires would deadlock waiting for a free slot
// while every slot is held by a running generation.
func (p *Pool) SetMaxSlots(max int) {
	if max < 0 {
		max = 0
	}
	p.mu.Lock()
	// max == 0 means unlimited, which is always "more room" than any finite cap.
	grew := max == 0 || max > p.maxSlots
	p.maxSlots = max
	if grew {
		p.cond.Broadcast() // room to grow now; let waiters retry the create path
	}
	p.mu.Unlock()
}

// Acquire returns a worktree checked out at the given commit SHA. The caller must
// Release it when done. The slow git work (checkout / worktree add) runs without
// the pool lock held, so concurrent acquires/releases never block on it.
//
// cleanIgnored requests a pristine tree (git-ignored files removed too); see
// checkout. It also disables the affinity shortcut: a same-SHA hit reuses a slot
// with no git work at all, which would keep a prior run's ignored output, so when
// a pristine tree is wanted we always fall through to a checkout+clean instead.
func (p *Pool) Acquire(sha string, cleanIgnored bool) (*Slot, error) {
	p.mu.Lock()
	for {
		// 1. Affinity: a free slot already on this commit - reuse with zero git work.
		//    Only when the caller doesn't need ignored files wiped (see above).
		if !cleanIgnored {
			for i, s := range p.free {
				if s.sha == sha {
					p.free = append(p.free[:i], p.free[i+1:]...)
					p.mu.Unlock()
					return s, nil
				}
			}
		}

		// 2. Any free slot - reuse it via an incremental checkout (off the lock).
		if len(p.free) > 0 {
			s := p.free[len(p.free)-1]
			p.free = p.free[:len(p.free)-1]
			p.mu.Unlock()
			if err := p.checkout(s, sha, cleanIgnored); err != nil {
				// Checkout failed; the slot may be in a bad state. Forget its SHA and
				// return it to the free list so a later acquire can try to repair it
				// (checkout --force / a fresh clean), and wake a waiter.
				p.mu.Lock()
				s.sha = ""
				p.free = append(p.free, s)
				p.cond.Signal()
				p.mu.Unlock()
				return nil, errtrace.Wrap(err)
			}
			return s, nil
		}

		// 3. Room to grow - reserve a new slot under the lock, create it off the lock.
		//    maxSlots == 0 means unlimited (concurrency is unlimited), so always grow.
		if p.maxSlots == 0 || len(p.all) < p.maxSlots {
			s := &Slot{path: filepath.Join(p.dir, strconv.Itoa(p.nextN))}
			p.nextN++
			p.all = append(p.all, s)
			p.mu.Unlock()
			if err := p.create(s, sha); err != nil {
				// Creation failed; drop the reservation so the cap is accurate and a
				// later acquire can retry, then wake a waiter.
				p.mu.Lock()
				p.removeFromAll(s)
				p.cond.Signal()
				p.mu.Unlock()
				return nil, errtrace.Wrap(err)
			}
			return s, nil
		}

		// 4. All slots busy - wait for a release, then retry.
		p.cond.Wait()
	}
}

// Release returns a slot to the pool for reuse and wakes one waiter.
func (p *Pool) Release(s *Slot) {
	p.mu.Lock()
	p.free = append(p.free, s)
	p.cond.Signal()
	p.mu.Unlock()
}

// create materialises a brand-new detached worktree at the slot path on sha.
func (p *Pool) create(s *Slot, sha string) error {
	// Defensively clear any stale worktree/dir at the path (e.g. a crash left one
	// that boot cleanup somehow missed) before adding.
	_ = git.RemoveWorktree(p.projectRoot, s.path)
	_ = os.RemoveAll(s.path)
	if err := git.AddDetachedWorktree(p.projectRoot, s.path, sha); err != nil {
		_ = os.RemoveAll(s.path)
		return errtrace.Wrap(err)
	}
	s.sha = sha
	return nil
}

// checkout switches an existing slot to sha incrementally, then removes stray
// untracked files. cleanIgnored=false keeps ignored caches warm (`git clean -fd`);
// true wipes them too for a pristine tree (`git clean -fdx`). A freshly created
// slot is pristine already, so only this reuse path needs the clean.
func (p *Pool) checkout(s *Slot, sha string, cleanIgnored bool) error {
	if err := git.CheckoutDetached(s.path, sha); err != nil {
		return errtrace.Wrap(err)
	}
	if err := git.CleanWorktree(s.path, cleanIgnored); err != nil {
		return errtrace.Wrap(err)
	}
	s.sha = sha
	return nil
}

// removeFromAll drops s from the all-slots list by identity. Caller holds p.mu.
func (p *Pool) removeFromAll(s *Slot) {
	for i, x := range p.all {
		if x == s {
			p.all = append(p.all[:i], p.all[i+1:]...)
			return
		}
	}
}

// Clean tears the pool down to empty: it deregisters known slot worktrees, wipes
// the whole slots dir (covering slots left behind by a crash that aren't in the
// in-memory list), and prunes the dangling git admin entries for the now-missing
// worktrees. Safe to call on boot before any generation is in flight.
func (p *Pool) Clean() {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, s := range p.all {
		_ = git.RemoveWorktree(p.projectRoot, s.path)
	}
	_ = os.RemoveAll(p.dir)
	_ = git.PruneWorktrees(p.projectRoot)
	p.all = nil
	p.free = nil
}
