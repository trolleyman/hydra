package http

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/db"
	"github.com/trolleyman/hydra/internal/forge"
	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/heads"
	"github.com/trolleyman/hydra/internal/mcpserver"
	"github.com/trolleyman/hydra/internal/reviewstore"
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
//   - auto-publishes armed unlinked heads once green and auto-pushes linked heads.
//
// See docs/non-local-integration.md. Unlinked heads cost nothing (they aren't polled).
func (s *Server) RunReviewWatcher(ctx context.Context) {
	t := time.NewTicker(reviewPollInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.pollLinkedReviews(ctx)
			s.checkAutoPush(ctx)
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
	// Refresh the remote-tracking refs first, once per (project, remote). Every
	// head's ahead/behind is measured against <remote>/<downstream> from cached
	// refs (downstreamAheadBehind), so without a fetch "behind" only ever moved
	// when something else happened to fetch - a reviewer's push was invisible
	// until you tried to pull. This is the same throttled best-effort fetch the
	// sidebar's push status kicks off, so the two share a window rather than
	// doubling up on remote traffic.
	fetched := map[string]bool{}
	for _, a := range linked {
		remote := reviewRemote(a.ProjectPath)
		key := a.ProjectPath + "\x00" + remote
		if remote == "" || fetched[key] {
			continue
		}
		fetched[key] = true
		go s.maybeFetchRemote(a.ProjectPath, remote)
	}
	for _, a := range linked {
		st, err := s.refreshHeadReview(ctx, a)
		if err != nil {
			continue // provider not resolvable / transient forge error - retry next tick
		}
		if st.State == forge.StateMerged {
			s.handleRemoteMerge(ctx, a.ProjectPath, a.ID)
		}
	}
}

// refreshHeadReview re-reads one linked head's MR from the forge and rewrites
// both the cached UI state and the head's review file (the snapshot the agent's
// review tools read). Shared by the 30s watcher tick and the on-demand refresh a
// head requests through reviewq, so both paths produce identical state.
func (s *Server) refreshHeadReview(ctx context.Context, a db.Agent) (forge.Status, error) {
	projectRoot := a.ProjectPath
	review := reviewConfigFor(projectRoot)
	remote := review.GetRemote()
	provider, err := forge.Resolve(review, git.RemoteURL(projectRoot, remote))
	if err != nil {
		return forge.Status{}, errtrace.Wrap(err)
	}
	st, err := provider.Status(ctx, projectRoot, remote, a.ReviewID)
	if err != nil {
		return forge.Status{}, errtrace.Wrap(err)
	}
	// Cache the fresh state on the head (for the UI chip).
	s.cacheReviewState(projectRoot, a.ID, st)

	// Fetch the review threads only when the status reports unresolved ones, then
	// write the per-head review file the agent's mcp__hydra__* tools read. The
	// threads are cached for the diff viewer in the same pass, so opening the diff
	// does not re-hit the forge.
	var discussions []forge.Discussion
	if st.UnresolvedDiscussions > 0 {
		if threads, terr := provider.Threads(ctx, projectRoot, remote, a.ReviewID); terr == nil {
			discussions = forge.UnresolvedDiscussions(threads)
			cacheThreads(projectRoot, a.ID, threads)
		}
	} else {
		cacheThreads(projectRoot, a.ID, nil)
	}
	writeReviewFile(projectRoot, a, st, discussions)
	return st, nil
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

// reviewSnapshot assembles the per-head review file the in-sandbox `hydra mcp`
// server reads from an MR link plus its freshly-polled forge state. Shared
// by the watcher and the adopt-spawn seed (docs/pr-adoption.md), so both write
// the same shape.
// numberDiscussion assigns a discussion its number from the head's shared
// sequence, or 0 when there is no head to number against (the adopt-spawn seed
// runs before the head exists).
func numberDiscussion(projectRoot, headID string, d forge.Discussion) int {
	if projectRoot == "" || headID == "" {
		return 0
	}
	return reviewstore.NumberForForgeNote(projectRoot, headID, d.NoteID, d.ID)
}

func reviewSnapshot(projectRoot, headID, url, id, provider, targetBranch string, st forge.Status, discussions []forge.Discussion) mcpserver.ReviewFile {
	rf := mcpserver.ReviewFile{
		Linked:                true,
		URL:                   url,
		ID:                    id,
		Provider:              provider,
		TargetBranch:          targetBranch,
		State:                 st.State,
		CIStatus:              st.CIStatus,
		Approvals:             st.Approvals,
		ApprovalsRequired:     st.ApprovalsRequired,
		UnresolvedDiscussions: st.UnresolvedDiscussions,
		Mergeable:             st.Mergeable,
		UpdatedAt:             time.Now().Format(time.RFC3339),
	}
	for _, d := range discussions {
		rf.Comments = append(rf.Comments, mcpserver.ReviewComment{
			ID: d.ID, Number: numberDiscussion(projectRoot, headID, d),
			Author: d.Author, Body: d.Body, Path: d.Path, Line: d.Line, URL: d.URL,
		})
	}
	return rf
}

// writeReviewFile writes the per-head review snapshot (status + unresolved
// discussions) the in-sandbox `hydra mcp` server reads. Best-effort.
func writeReviewFile(projectRoot string, a db.Agent, st forge.Status, discussions []forge.Discussion) {
	rf := reviewSnapshot(projectRoot, a.ID, a.ReviewURL, a.ReviewID, a.ReviewProvider, a.ReviewTargetBranch, st, discussions)
	_ = heads.WriteReviewSnapshot(projectRoot, a.ID, rf)
}

// handleRemoteMerge tears down a head whose MR reports merged: fetch, fast-forward
// the local target branch (the code has landed remotely), then archive as merged
// via the existing teardown. Squash merges are handled because the truth is the MR
// state, not git ancestry. Best-effort ff: a divergent local target is left
// for the user's Sync rather than forced.
func (s *Server) handleRemoteMerge(ctx context.Context, projectRoot, headID string) {
	head, err := heads.GetHeadByID(ctx, s.Sessions, s.DB, projectRoot, headID)
	if err != nil || head == nil {
		return
	}
	// Fast-forward the local target branch to what merged remotely, so the trunk is
	// current before we drop the head. Best-effort - a pull that can't ff is left to
	// the user (their working tree may be dirty).
	//
	// Skip this entirely for an adopted PR: its target branch belongs to a repo we
	// may not own or track locally, so advancing a same-named local branch would be
	// wrong. We still archive the head as merged below (the MR state is the truth).
	target := head.ReviewTargetBranch
	if target == "" {
		target = head.BaseBranch
	}
	remote := reviewConfigFor(projectRoot).GetRemote()
	if target != "" && !head.ReviewAdopted {
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
	// Preserve Hydra's local stack edge when the parent PR lands remotely. This
	// mirrors performClaimedMerge; Graphite/GitHub handle the remote retarget.
	if head.Branch != nil {
		if children, err := s.DB.AgentsByBaseBranch(projectRoot, *head.Branch); err == nil {
			for _, child := range children {
				if err := s.DB.ReparentAgent(child.ID, *head.Branch, target); err != nil {
					log.Printf("warn: review watcher: reparent child %s: %v", child.ID, err)
				}
			}
		}
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

// checkAutoPush handles automatic review syncing. Linked heads auto-push
// after the agent finishes without waiting for tests. An explicitly armed,
// unlinked head retains the old behavior and opens a draft MR once tests pass.
//
// The arm is STICKY: it survives a successful publish/push, so an armed head
// keeps its MR in sync for the rest of its life rather than syncing once and
// going quiet. That is the whole point of arming it - a commit the agent makes
// after the MR opens is exactly the commit that used to sit there unnoticed. It
// is consumed only on failure (so a broken push can't loop) - see autoPush.
func (s *Server) checkAutoPush(ctx context.Context) {
	if s.DB == nil {
		return
	}
	armed, err := s.DB.AutoPushHeads()
	if err != nil || len(armed) == 0 {
		return
	}
	for _, a := range armed {
		projectRoot := a.ProjectPath
		head, err := heads.GetHeadByID(ctx, s.Sessions, s.DB, projectRoot, a.ID)
		if err != nil || head == nil || head.Branch == nil {
			continue
		}
		if !head.IsLinked() && (s.Tests == nil || !s.headTestsGreen(projectRoot, *head)) {
			continue
		}
		if !headFinishedFor(a, autoMergeFinishedDwell, time.Now()) {
			continue
		}
		s.autoPush(ctx, projectRoot, *head)
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

// autoPush publishes or pushes an armed head. Unlinked -> draft MR (via
// publishHead); linked -> plain push (via pushHeadToMR). Reuses the shared cores
// so the claim/gate/link logic stays in one place.
//
// The arm is kept on success and consumed on failure. Keeping it is what makes a
// linked head stay in sync commit after commit; consuming it on failure is what
// stops a push that can never succeed (bad credentials, a protected branch) from
// retrying every 30s forever. A linked head with nothing to push does neither -
// it is a no-op, so an idle armed head costs one local rev-list per tick and no
// network at all.
func (s *Server) autoPush(ctx context.Context, projectRoot string, head heads.Head) {
	// An adopted head can only be armed through an explicit acknowledgement
	// (ArmAutoPush; never from the `[review] auto_push` default at
	// spawn), so an armed one here means the user asked for exactly this and we
	// push. What stays unconditional is a read-only PR: no push to it can ever
	// succeed, so disarm rather than re-log every tick (docs/pr-adoption.md).
	if head.ReviewAdopted && !head.ReviewCanPush {
		_ = s.DB.SetAutoPush(head.ID, false, "")
		log.Printf("review watcher: disarming auto-publish for adopted head %s (read-only PR: no maintainer-edit access)", head.ID)
		return
	}
	if head.IsLinked() {
		// Nothing to send: stay armed and silent. Checked from cached refs, so this
		// is the cheap path an already-synced head takes on every tick. An adopted
		// head is tracked by the PR's local head pseudo-ref (its branch may live on a
		// fork, so <remote>/<downstream> need not exist at all) - the same ref the
		// agent page's ahead/behind chips read.
		if head.Branch != nil {
			var ahead int
			var ok bool
			if head.ReviewAdopted {
				localRef, _ := git.PRHeadRefspec(head.ReviewProvider, head.ReviewID)
				ahead, _, ok = git.AheadBehind(projectRoot, *head.Branch, localRef)
			} else {
				ahead, _, ok = downstreamAheadBehind(projectRoot, *head.Branch, reviewRemote(projectRoot), head.DownstreamBranch)
			}
			if ok && ahead == 0 {
				return
			}
		}
		if err := s.pushHeadToMR(ctx, projectRoot, head); err != nil {
			_ = s.DB.SetAutoPush(head.ID, false, "")
			log.Printf("warn: auto-publish push for %s failed (sync-when-green disarmed): %v", head.ID, err)
		}
	} else {
		draft := true
		if _, fail := s.publishHead(ctx, projectRoot, head, publishOverrides{Draft: &draft}); fail != nil {
			_ = s.DB.SetAutoPush(head.ID, false, "")
			log.Printf("warn: auto-publish for %s failed (publish-when-green disarmed): %s", head.ID, fail.detail)
		}
	}
	s.notifyAgentsChanged(projectRoot, true)
}
