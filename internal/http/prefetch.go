package http

import (
	"context"
	"log"
	"sync"
	"time"

	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/heads"
)

// prefetchInterval is how often the daemon proactively pre-generates artifacts
// for idle heads. A worktree head must look unchanged across one interval before
// it is prefetched (see prefetchOnce), so a settled head's artifacts are ready
// roughly two intervals after the agent stops writing - well before the user
// clicks in, which is the whole point - while an actively-editing head is left
// alone so its heavy build isn't run against a moving target.
//
// This periodic sweep is the backstop: the low-latency path is PrefetchHeadNow,
// fired the moment a head transitions into a resting status (finished / waiting /
// needs_input), which is a definitive "the agent stopped editing" signal and so
// doesn't need to wait out the two-sweep stability check.
const prefetchInterval = 30 * time.Second

// artifactPrefetchState is the bookkeeping shared by the periodic prefetch sweep
// (RunArtifactPrefetcher) and the on-transition immediate prefetch
// (PrefetchHeadNow). Both goroutines read and write the two maps, so every access
// goes through mu.
//
//   - lastHash: headID -> last-seen worktree state hash, so a head is prefetched
//     by the sweep only once its working tree has stopped changing (one interval
//     of stability). PrefetchHeadNow also records here so a head it prefetched
//     early is seen as unchanged by the next sweep (which would otherwise treat
//     the mid-run fingerprint it last recorded as a change and cancel the render).
//   - lastDirs: headID -> the worktree-side entry dirs last kicked off for it, so
//     a head moving to a new version can cancel its now-stale background renders.
type artifactPrefetchState struct {
	mu       sync.Mutex
	lastHash map[string]string
	lastDirs map[string][]string
}

// prefetchState lazily initialises and returns the shared prefetch bookkeeping.
func (s *Server) prefetchState() *artifactPrefetchState {
	s.artifactPrefetchOnce.Do(func() {
		s.artifactPrefetch = &artifactPrefetchState{
			lastHash: map[string]string{},
			lastDirs: map[string][]string{},
		}
	})
	return s.artifactPrefetch
}

// observe records head's current worktree fingerprint and reports whether the
// tree has stopped changing (settled, so it is worth running a potentially heavy
// generation against) and whether it changed since the last sweep (changed, so
// any stale background build can be cancelled). A first sighting is unsettled
// (wait one interval to confirm stability); a differing fingerprint is unsettled
// and changed; an identical one is settled.
func (st *artifactPrefetchState) observe(headID, hash string) (settled, changed bool) {
	st.mu.Lock()
	defer st.mu.Unlock()
	prev, seen := st.lastHash[headID]
	st.lastHash[headID] = hash
	switch {
	case !seen:
		return false, false
	case prev != hash:
		return false, true
	default:
		return true, false
	}
}

// setHash records head's fingerprint unconditionally. PrefetchHeadNow uses it so
// the render it kicks off isn't cancelled by the next sweep as a stale version.
func (st *artifactPrefetchState) setHash(headID, hash string) {
	st.mu.Lock()
	defer st.mu.Unlock()
	st.lastHash[headID] = hash
}

// takeDirs removes and returns the background entry dirs recorded for headID.
func (st *artifactPrefetchState) takeDirs(headID string) []string {
	st.mu.Lock()
	defer st.mu.Unlock()
	dirs := st.lastDirs[headID]
	delete(st.lastDirs, headID)
	return dirs
}

// setDirs records (or clears, when empty) the background entry dirs kicked off
// for headID so a later change can cancel them.
func (st *artifactPrefetchState) setDirs(headID string, dirs []string) {
	st.mu.Lock()
	defer st.mu.Unlock()
	if len(dirs) == 0 {
		delete(st.lastDirs, headID)
		return
	}
	st.lastDirs[headID] = dirs
}

// pruneTo drops per-head state for heads that no longer exist so the maps can't
// grow without bound across the daemon's lifetime.
func (st *artifactPrefetchState) pruneTo(live map[string]struct{}) {
	st.mu.Lock()
	defer st.mu.Unlock()
	for id := range st.lastHash {
		if _, ok := live[id]; !ok {
			delete(st.lastHash, id)
		}
	}
	for id := range st.lastDirs {
		if _, ok := live[id]; !ok {
			delete(st.lastDirs, id)
		}
	}
}

// prefetch kicks off background generation for both sides of every script in the
// plan, so the results are cached before the user opens the artifacts panel.
// Each side reuses the same per-version cache and in-flight dedup as a
// foreground Get, so an already-generated or in-flight version is a no-op.
// Background generations yield their slot to foreground requests but are never
// preempted, so this work is never wasted.
func (p *artifactPlan) prefetch() {
	for _, name := range p.names {
		leftSpec, rightSpec := p.specsFor(name)
		if leftSpec != nil && shouldAutoRun(leftSpec.AutoRun, p.agentRunning) {
			_, _ = p.mgr.Prefetch(*leftSpec, p.left)
		}
		if rightSpec != nil && shouldAutoRun(rightSpec.AutoRun, p.agentRunning) {
			_, _ = p.mgr.Prefetch(*rightSpec, p.right)
		}
	}
}

// RunArtifactPrefetcher periodically pre-generates artifacts for every active
// head across all registered projects, so a head that has "sat there for ages"
// already has its screenshots rendered instead of starting the work only when a
// user clicks in. roots is re-evaluated each cycle so runtime project add/remove
// is picked up. The pacing and the debounce live in prefetchOnce. Runs until ctx
// is done; the first cycle waits one interval so boot work settles first.
func (s *Server) RunArtifactPrefetcher(ctx context.Context, roots func() []string) {
	if s.Artifacts == nil {
		return
	}
	ticker := time.NewTicker(prefetchInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.prefetchOnce(ctx, roots())
		}
	}
}

// prefetchOnce runs one prefetch sweep over the given project roots. For each
// non-archived head with a branch it resolves the same comparison the diff
// viewer shows by default (merge-base vs the working tree) and kicks off
// background generation. A head whose working tree changed since the last sweep
// is skipped this round - its build would be run against a moving target - so
// only heads that have settled get pre-generated.
func (s *Server) prefetchOnce(ctx context.Context, roots []string) {
	st := s.prefetchState()
	live := map[string]struct{}{}
	for _, root := range roots {
		cfg, err := config.Load(root)
		if err != nil || len(cfg.Artifacts) == 0 {
			continue // no artifacts configured for this project
		}
		mgr := s.Artifacts.Manager(root)
		// Apply any config change to the generation parallelism before this
		// project's manager is exercised (cheap and idempotent). This applies to
		// foreground generation too, so do it even when prefetch is disabled below.
		mgr.SetConcurrency(cfg.ResolveArtifactConcurrency())
		// Respect the per-project opt-out: foreground generation (on open) and the
		// concurrency cap still apply, but skip the proactive background work.
		if !cfg.IsArtifactPrefetchEnabled() {
			continue
		}

		hs, err := heads.ListHeads(ctx, s.Sessions, s.DB, root)
		if err != nil {
			log.Printf("warn: prefetch artifacts: list heads (%s): %v", root, err)
			continue
		}
		for i := range hs {
			head := &hs[i]
			// Archived (killed/merged) and ephemeral test heads are never viewed
			// for artifacts, and a head with no branch has nothing to compare.
			if head.Archived || head.Ephemeral || head.Branch == nil {
				continue
			}
			live[head.ID] = struct{}{}
			// A head with no worktree compares against its committed branch tip,
			// which is stable, so it is always settled and never changed.
			if head.Worktree == nil {
				s.prefetchHead(root, head)
				continue
			}
			h, err := git.WorktreeStateHash(*head.Worktree)
			if err != nil {
				continue // can't tell; skip this round rather than thrash
			}
			settled, changed := st.observe(head.ID, h)
			if changed {
				// The working tree moved since we prefetched it, so the builds we
				// kicked off for its previous state are stale. Cancel any still
				// running purely as background work - freeing the generation slot and
				// its build memory at once - instead of letting a dead render finish.
				for _, d := range st.takeDirs(head.ID) {
					mgr.CancelStaleBackground(d)
				}
			}
			if !settled {
				continue
			}
			s.prefetchHead(root, head)
		}
	}
	st.pruneTo(live)
}

// prefetchHead resolves the default comparison for one head and kicks off its
// background generation, recording the worktree-side entry dirs so a later sweep
// can cancel them if the head moves on. Best-effort: a head that can't be resolved
// (config gone, branch deleted mid-sweep) is simply skipped.
func (s *Server) prefetchHead(projectRoot string, head *heads.Head) {
	// Mirror the diff viewer's default selection for an active head: base against
	// the merge-base and show the uncommitted working tree (resolveArtifactPlan
	// falls back to the branch tip when the head has no worktree).
	t := true
	params := api.GetAgentArtifactsParams{IncludeUncommitted: &t}
	plan, err := s.resolveArtifactPlan(projectRoot, head, params)
	if err != nil || plan == nil {
		return
	}
	s.prefetchState().setDirs(head.ID, plan.staleableDirs())
	plan.prefetch()
}

// PrefetchHeadNow kicks off background artifact generation for a single head
// immediately, bypassing the periodic sweep's two-interval worktree-settle
// debounce. It is meant to be fired the moment a head transitions into a resting
// status (finished / waiting / needs_input): the agent has stopped editing, so
// its working tree is a stable target and there's no reason to wait up to two 30s
// sweeps to notice. Best-effort and safe to call redundantly - the Manager dedups
// by version, so a version already cached or in-flight is a no-op. It shares the
// sweep's bookkeeping, so a render it starts is cancellable by a later sweep if
// the head resumes and moves on.
func (s *Server) PrefetchHeadNow(ctx context.Context, projectRoot, headID string) {
	if s.Artifacts == nil {
		return
	}
	cfg, err := config.Load(projectRoot)
	if err != nil || len(cfg.Artifacts) == 0 {
		return // no artifacts configured for this project
	}
	mgr := s.Artifacts.Manager(projectRoot)
	// Keep the generation parallelism in sync even on this path (idempotent).
	mgr.SetConcurrency(cfg.ResolveArtifactConcurrency())
	if !cfg.IsArtifactPrefetchEnabled() {
		return // proactive background work opted out for this project
	}
	head, err := heads.GetHeadByID(ctx, s.Sessions, s.DB, projectRoot, headID)
	if err != nil || head == nil {
		return
	}
	if head.Archived || head.Ephemeral || head.Branch == nil {
		return
	}
	// Record the tree's current fingerprint as the settled state so the next sweep
	// sees it as unchanged (it last recorded a mid-run hash) and doesn't cancel the
	// render we're about to start as though it were stale.
	if head.Worktree != nil {
		if h, err := git.WorktreeStateHash(*head.Worktree); err == nil {
			s.prefetchState().setHash(headID, h)
		}
	}
	s.prefetchHead(projectRoot, head)
}
