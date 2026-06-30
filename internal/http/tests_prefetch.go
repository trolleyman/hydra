package http

import (
	"context"
	"log"
	"time"

	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/heads"
	hydratests "github.com/trolleyman/hydra/internal/tests"
)

// testPrefetchInterval is how often the daemon proactively re-runs a head's test
// suites so a stale verdict (one computed for an older commit) is refreshed in the
// background instead of only when the panel is opened or the merge gate runs. It
// mirrors prefetchInterval for artifacts. Tests run against the committed branch
// tip, which only changes on a new commit, so the per-commit cache makes a sweep a
// no-op until the tip moves — no settle debounce is needed (unlike the working-tree
// artifact prefetcher).
const testPrefetchInterval = 30 * time.Second

// RunTestPrefetcher periodically re-runs the test suites for every active head
// across all registered projects whose branch-tip verdict is missing or stale, so
// the verdict is ready before a user opens the tests panel. It mirrors
// RunArtifactPrefetcher: roots is re-evaluated each cycle so runtime project
// add/remove is picked up, the concurrency cap is applied every sweep (so a config
// change takes effect without a restart), and background runs yield their slot to
// foreground requests but are never preempted. Runs until ctx is done; the first
// cycle waits one interval so boot work settles first.
func (s *Server) RunTestPrefetcher(ctx context.Context, roots func() []string) {
	if s.Tests == nil {
		return
	}
	// headID -> the branch-tip SHA last prefetched, so a head that moves to a new
	// commit can cancel its now-stale background runs. Persists across cycles;
	// pruned to the live head set each sweep.
	lastSHA := map[string]string{}
	// headID -> the entry dirs last kicked off for it, paired with lastSHA above.
	lastDirs := map[string][]string{}
	ticker := time.NewTicker(testPrefetchInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.testPrefetchOnce(ctx, roots(), lastSHA, lastDirs)
		}
	}
}

// testPrefetchOnce runs one prefetch sweep over the given project roots. For each
// non-archived head with a branch it kicks off a background run of every enabled
// runner against the head's branch tip; the per-commit cache and in-flight dedup
// make this a no-op when a fresh verdict already exists, so work only happens when
// the tip moved (the verdict went stale). lastSHA/lastDirs carry per-head state
// across sweeps and are pruned to the live head set here.
func (s *Server) testPrefetchOnce(ctx context.Context, roots []string, lastSHA map[string]string, lastDirs map[string][]string) {
	live := map[string]struct{}{}
	for _, root := range roots {
		cfg, err := config.Load(root)
		if err != nil {
			continue
		}
		mgr := s.Tests.Manager(root)
		// Apply any config change to the parallelism before this project's manager is
		// exercised (cheap and idempotent). This applies to foreground runs too, so do
		// it even when prefetch is disabled below.
		mgr.SetConcurrency(cfg.ResolveTestConcurrency())

		var runners []config.TestScript
		for _, t := range cfg.Tests {
			if t.IsEnabled() {
				runners = append(runners, t)
			}
		}
		if len(runners) == 0 {
			continue // no tests configured for this project
		}
		// Respect the per-project opt-out: foreground runs (on open / at merge) and the
		// concurrency cap still apply, but skip the proactive background work.
		if !cfg.IsTestPrefetchEnabled() {
			continue
		}

		hs, err := heads.ListHeads(ctx, s.Sessions, s.DB, root)
		if err != nil {
			log.Printf("warn: prefetch tests: list heads (%s): %v", root, err)
			continue
		}
		for i := range hs {
			head := &hs[i]
			// Archived (killed/merged) and ephemeral test heads have no verdict chip,
			// and a head with no branch has nothing to run against.
			if head.Archived || head.Ephemeral || head.Branch == nil {
				continue
			}
			live[head.ID] = struct{}{}
			sha, err := git.ResolveRef(root, *head.Branch)
			if err != nil {
				continue // branch deleted mid-sweep, etc. — skip rather than thrash
			}
			if prev, ok := lastSHA[head.ID]; ok && prev != sha {
				// The branch tip moved since we prefetched it, so any run still in flight
				// for the previous commit is stale. Cancel ones running purely as
				// background work — freeing the generation slot — instead of letting a
				// dead run finish.
				for _, d := range lastDirs[head.ID] {
					mgr.CancelStaleBackground(d)
				}
				delete(lastDirs, head.ID)
			}
			lastSHA[head.ID] = sha

			v := hydratests.Version{Ref: *head.Branch}
			var dirs []string
			for _, r := range runners {
				_, _ = mgr.Prefetch(r, v)
				if d, derr := mgr.EntryDir(r.Name, v); derr == nil {
					dirs = append(dirs, d)
				}
			}
			if len(dirs) > 0 {
				lastDirs[head.ID] = dirs
			}
		}
	}
	// Drop per-head state for heads that no longer exist so the maps can't grow
	// without bound across the daemon's lifetime.
	for id := range lastSHA {
		if _, ok := live[id]; !ok {
			delete(lastSHA, id)
		}
	}
	for id := range lastDirs {
		if _, ok := live[id]; !ok {
			delete(lastDirs, id)
		}
	}
}
