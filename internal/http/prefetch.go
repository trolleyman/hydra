package http

import (
	"context"
	"log"
	"time"

	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/heads"
)

// prefetchInterval is how often the daemon proactively pre-generates artifacts
// for idle heads. A worktree head must look unchanged across one interval before
// it is prefetched (see prefetchOnce), so a settled head's artifacts are ready
// roughly two intervals after the agent stops writing — well before the user
// clicks in, which is the whole point — while an actively-editing head is left
// alone so its heavy build isn't run against a moving target.
const prefetchInterval = 30 * time.Second

// prefetch kicks off background generation for both sides of every script in the
// plan, so the results are cached before the user opens the artifacts panel.
// Each side reuses the same per-version cache and in-flight dedup as a
// foreground Get, so an already-generated or in-flight version is a no-op.
// Background generations yield their slot to foreground requests but are never
// preempted, so this work is never wasted.
func (p *artifactPlan) prefetch() {
	for _, name := range p.names {
		leftSpec, rightSpec := p.specsFor(name)
		if leftSpec != nil {
			_, _ = p.mgr.Prefetch(*leftSpec, p.left)
		}
		if rightSpec != nil {
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
	// headID -> last-seen worktree state hash, so a head is prefetched only once
	// its working tree has stopped changing (one interval of stability). Persists
	// across cycles; pruned to the live head set each cycle.
	lastHash := map[string]string{}
	// headID -> the (worktree-side) entry dirs last kicked off for it, so a head
	// moving to a new version can cancel its now-stale background renders.
	lastDirs := map[string][]string{}
	ticker := time.NewTicker(prefetchInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.prefetchOnce(ctx, roots(), lastHash, lastDirs)
		}
	}
}

// prefetchOnce runs one prefetch sweep over the given project roots. For each
// non-archived head with a branch it resolves the same comparison the diff
// viewer shows by default (merge-base vs the working tree) and kicks off
// background generation. A head whose working tree changed since the last sweep
// is skipped this round — its build would be run against a moving target — so
// only heads that have settled get pre-generated. lastHash carries the per-head
// worktree fingerprint across sweeps and is pruned to the live head set here.
func (s *Server) prefetchOnce(ctx context.Context, roots []string, lastHash map[string]string, lastDirs map[string][]string) {
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
			settled, changed := s.headState(head, lastHash)
			if changed {
				// The working tree moved since we prefetched it, so the builds we
				// kicked off for its previous state are stale. Cancel any still
				// running purely as background work — freeing the generation slot and
				// its build memory at once — instead of letting a dead render finish.
				for _, d := range lastDirs[head.ID] {
					mgr.CancelStaleBackground(d)
				}
				delete(lastDirs, head.ID)
			}
			if !settled {
				continue
			}
			s.prefetchHead(root, head, lastDirs)
		}
	}
	// Drop per-head state for heads that no longer exist so the maps can't grow
	// without bound across the daemon's lifetime.
	for id := range lastHash {
		if _, ok := live[id]; !ok {
			delete(lastHash, id)
		}
	}
	for id := range lastDirs {
		if _, ok := live[id]; !ok {
			delete(lastDirs, id)
		}
	}
}

// headState reports whether head's working tree has stopped changing (settled, so
// it is worth running a potentially heavy generation against) and whether it
// changed since the last sweep (changed, so any stale background build can be
// preempted). A head with no worktree compares against its committed branch tip,
// which is stable, so it is always settled and never changed. For a worktree head
// it fingerprints the working-tree state, records it for next time, and compares
// to the previous sweep's value: a first sighting is unsettled (wait one interval
// to confirm stability); a differing fingerprint is unsettled and changed; an
// identical one is settled.
func (s *Server) headState(head *heads.Head, lastHash map[string]string) (settled, changed bool) {
	if head.Worktree == nil {
		return true, false
	}
	h, err := git.WorktreeStateHash(*head.Worktree)
	if err != nil {
		return false, false // can't tell; skip this round rather than thrash
	}
	prev, seen := lastHash[head.ID]
	lastHash[head.ID] = h
	switch {
	case !seen:
		return false, false
	case prev != h:
		return false, true
	default:
		return true, false
	}
}

// prefetchHead resolves the default comparison for one head and kicks off its
// background generation, recording the worktree-side entry dirs so a later sweep
// can cancel them if the head moves on. Best-effort: a head that can't be resolved
// (config gone, branch deleted mid-sweep) is simply skipped.
func (s *Server) prefetchHead(projectRoot string, head *heads.Head, lastDirs map[string][]string) {
	// Mirror the diff viewer's default selection for an active head: base against
	// the merge-base and show the uncommitted working tree (resolveArtifactPlan
	// falls back to the branch tip when the head has no worktree).
	t := true
	params := api.GetAgentArtifactsParams{IncludeUncommitted: &t}
	plan, err := s.resolveArtifactPlan(projectRoot, head, params)
	if err != nil || plan == nil {
		return
	}
	if dirs := plan.staleableDirs(); len(dirs) > 0 {
		lastDirs[head.ID] = dirs
	}
	plan.prefetch()
}
