package http

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/forge"
	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/heads"
	hydratests "github.com/trolleyman/hydra/internal/tests"
)

// reviewPollInterval is how often the MR lifecycle watcher polls each linked
// head's forge MR. Slower than the auto-merge watcher (5s) - forge APIs are
// remote and rate-limited, and MR state changes on human timescales.
const reviewPollInterval = 30 * time.Second

// RunReviewWatcher polls each MR-linked head's forge MR (across ALL projects,
// like the other daemon background loops - one hydrad serves every project), and:
//   - refreshes the cached MR state on the head (state/CI/approvals/discussions);
//   - detects a remote merge -> fetches, fast-forwards the local target branch,
//     archives the head as "merged" and tears it down (the code has landed);
//   - auto-publishes / auto-pushes armed publish-when-green heads once green.
//
// NON_LOCAL_INTEGRATION.md 3.5. Unlinked heads cost nothing (they aren't polled).
func (s *Server) RunReviewWatcher(ctx context.Context) {
	t := time.NewTicker(reviewPollInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.pollLinkedReviews(ctx)
			s.checkPublishWhenGreen(ctx)
		}
	}
}

// pollLinkedReviews refreshes each linked head's MR state and handles remote
// merges. Each head resolves its provider/remote from its OWN project-root config
// (never the daemon's boot project's), per the single-daemon design constraint.
func (s *Server) pollLinkedReviews(ctx context.Context) {
	if s.DB == nil {
		return
	}
	linked, err := s.DB.LinkedReviewHeads()
	if err != nil || len(linked) == 0 {
		return
	}
	for _, a := range linked {
		projectRoot := a.ProjectPath
		review := reviewConfigFor(projectRoot)
		remote := review.GetRemote()
		remoteURL := git.RemoteURL(projectRoot, remote)
		provider, err := forge.Resolve(review, remoteURL)
		if err != nil {
			continue // provider not resolvable now (CLI missing / auto-detect) - retry
		}
		st, err := provider.Status(ctx, projectRoot, remote, a.ReviewID)
		if err != nil {
			continue // transient forge error
		}
		// Cache the fresh state on the head.
		s.cacheReviewState(projectRoot, a.ID, st)

		if st.State == forge.StateMerged {
			s.handleRemoteMerge(ctx, projectRoot, a.ID)
		}
	}
}

// cacheReviewState persists a forge Status onto the head and notifies clients when
// it changed, so the UI chip updates without a manual refresh.
func (s *Server) cacheReviewState(projectRoot, headID string, st forge.Status) {
	apiState := reviewStateJSON(st)
	data, err := json.Marshal(apiState)
	if err != nil {
		return
	}
	_ = s.DB.SetReviewState(headID, string(data), time.Now().Format(time.RFC3339))
	s.notifyAgentsChanged(projectRoot, false)
}

// handleRemoteMerge tears down a head whose MR reports merged: fetch, fast-forward
// the local target branch (the code has landed remotely), then archive as merged
// via the existing teardown. Squash merges are handled because the truth is the MR
// state, not git ancestry (3.5). Best-effort ff: a divergent local target is left
// for the user's Sync rather than forced.
func (s *Server) handleRemoteMerge(ctx context.Context, projectRoot, headID string) {
	head, err := heads.GetHeadByID(ctx, s.Sessions, s.DB, projectRoot, headID)
	if err != nil || head == nil {
		return
	}
	// Fast-forward the local target branch to what merged remotely, so the trunk is
	// current before we drop the head. Best-effort - a pull that can't ff is left to
	// the user (their working tree may be dirty).
	target := head.ReviewTargetBranch
	if target == "" {
		target = head.BaseBranch
	}
	remote := reviewConfigFor(projectRoot).GetRemote()
	if target != "" {
		fetchCtx, cancel := context.WithTimeout(s.backgroundOr(ctx), 30*time.Second)
		if err := git.Fetch(fetchCtx, projectRoot, remote); err == nil {
			authorName, authorEmail := gitConfigVal(projectRoot, "user.name"), gitConfigVal(projectRoot, "user.email")
			if mergeDir, cleanup, err := heads.ResolveMergeDir(projectRoot, target); err == nil {
				_ = git.Merge(mergeDir, remote+"/"+target, authorName, authorEmail)
				cleanup()
			}
		}
		cancel()
	}

	// Claim + tear down as merged (the remote landed the code). A busy head retries
	// next tick.
	if ok, err := s.DB.TrySetHeadStatus(head.ID, "idle", "merging"); err != nil || !ok {
		return
	}
	s.stopHeadPreviews(projectRoot, head.ID)
	if err := heads.KillHeadNoLock(ctx, s.Sessions, s.DB, *head, "merged"); err != nil {
		log.Printf("warn: review watcher: teardown of remotely-merged head %s failed: %v", head.ID, err)
		_ = s.DB.ClearHeadStatus(head.ID, nil)
		return
	}
	log.Printf("review watcher: head %s merged remotely (MR %s) - archived", head.ID, head.ReviewID)
	s.notifyAgentsChanged(projectRoot, true)
}

// checkPublishWhenGreen auto-publishes/pushes armed heads once their local tests
// are green and the agent has finished, mirroring the merge-when-green watcher
// (3.5). An unlinked armed head auto-opens a DRAFT MR; a linked one auto-pushes
// (plain push only - never auto-force).
func (s *Server) checkPublishWhenGreen(ctx context.Context) {
	if s.DB == nil || s.Tests == nil {
		return
	}
	armed, err := s.DB.ArmedPublishWhenGreen()
	if err != nil || len(armed) == 0 {
		return
	}
	for _, a := range armed {
		projectRoot := a.ProjectPath
		head, err := heads.GetHeadByID(ctx, s.Sessions, s.DB, projectRoot, a.ID)
		if err != nil || head == nil || head.Branch == nil {
			continue
		}
		if !s.headTestsGreen(projectRoot, *head) {
			continue
		}
		if !headFinishedFor(a, autoMergeFinishedDwell, time.Now()) {
			continue
		}
		s.autoPublish(ctx, projectRoot, *head)
	}
}

// headTestsGreen reports whether every configured local runner has a passing
// verdict for the head's current commit (missing/running/red -> false). Kicks a
// run for a missing verdict so the next tick can decide.
func (s *Server) headTestsGreen(projectRoot string, head heads.Head) bool {
	if head.Branch == nil {
		return false
	}
	liveCfg, err := config.Load(projectRoot)
	if err != nil {
		return false
	}
	v := hydratests.Version{Ref: *head.Branch}
	runners := s.testRunnersFor(projectRoot, v, liveCfg)
	if len(runners) == 0 {
		return true // nothing to gate on -> treat as green
	}
	mgr := s.Tests.Manager(projectRoot)
	passing := 0
	for _, r := range runners {
		rep, ok, perr := mgr.Peek(r.Name, v)
		if perr != nil || !ok {
			_, _ = mgr.Get(r, v) // kick a run for the missing verdict
			return false
		}
		if rep.Status == hydratests.StatusPassing {
			passing++
		} else {
			return false
		}
	}
	return passing == len(runners)
}

// autoPublish publishes an armed head once, consuming the arm so a failure doesn't
// loop. Unlinked -> draft MR (via publishHead); linked -> plain push (via
// pushHeadToMR). Reuses the shared cores so the claim/gate/link logic stays in
// one place.
func (s *Server) autoPublish(ctx context.Context, projectRoot string, head heads.Head) {
	// Consume the arm up front (a failed publish shouldn't retry forever).
	_ = s.DB.SetPublishWhenGreen(head.ID, false, "")
	if head.IsLinked() {
		if err := s.pushHeadToMR(ctx, projectRoot, head); err != nil {
			log.Printf("warn: auto-publish push for %s failed: %v", head.ID, err)
		}
	} else {
		draft := true
		if _, fail := s.publishHead(ctx, projectRoot, head, publishOverrides{Draft: &draft}, false); fail != nil {
			log.Printf("warn: auto-publish for %s failed: %s", head.ID, fail.detail)
		}
	}
	s.notifyAgentsChanged(projectRoot, true)
}
