package http

import (
	"context"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"github.com/trolleyman/hydra/internal/heads"
	"github.com/trolleyman/hydra/internal/paths"
	"github.com/trolleyman/hydra/internal/reviewq"
	"github.com/trolleyman/hydra/internal/reviewstore"
)

const (
	// reviewReqPollInterval is how often the daemon drains pending review-refresh
	// requests. They're interactive (an agent is blocked mid tool-call waiting), so
	// this is far tighter than the review watcher's 30s tick; a tick with nothing
	// pending is one readdir per project.
	reviewReqPollInterval = 500 * time.Millisecond
	// reviewRefreshMinAge is how fresh a head's cached MR state has to be for a
	// refresh request to be answered from it instead of hitting the forge. Both
	// review tools refresh, and an agent commonly calls them back to back, so this
	// collapses that burst into one round trip without ever serving state the agent
	// could tell was stale.
	reviewRefreshMinAge = 5 * time.Second
	// reviewRefreshTimeout bounds the forge calls one request may take. The
	// in-sandbox side waits a little longer than this before giving up and
	// answering from the cached snapshot.
	reviewRefreshTimeout = 20 * time.Second
	// reviewReqKeep is how many answered request/result pairs are kept per head
	// (purely for debugging a stuck refresh); older ones are swept.
	reviewReqKeep = 8
)

// RunReviewRequestWatcher answers the requests sandboxed heads drop into their
// reviewq dir - everything an in-sandbox tool needs the host to do for it:
//
//   - review refreshes (mcp__hydra__get_review_status / get_review_comments):
//     re-read the MR from the forge host-side and rewrite the head's review file,
//     so the agent gets live data instead of whatever the 30s watcher last cached;
//   - local-only replies on a review thread;
//   - the head's own tests/artifacts/services status and test logs
//     (mcp__hydra__get_head_status / get_test_logs), which live in the daemon's
//     managers - services state only ever exists in daemon memory.
//
// The forge CLIs are host-side only - the sandbox holds no `gh`/`glab`
// credentials and, under hard egress, has no route to the forge - which is why
// this is a file round-trip rather than the agent calling the forge itself.
// Heads that never ask cost nothing here (their dir stays empty). Iterates all
// projects, like the other daemon loops.
func (s *Server) RunReviewRequestWatcher(ctx context.Context, roots func() []string) {
	t := time.NewTicker(reviewReqPollInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			for _, root := range roots() {
				s.drainReviewRequests(ctx, root)
			}
		}
	}
}

// drainReviewRequests answers every pending refresh request under projectRoot.
func (s *Server) drainReviewRequests(ctx context.Context, projectRoot string) {
	entries, err := os.ReadDir(paths.GetReviewReqRootDir(projectRoot))
	if err != nil {
		return // no review-req dir here - nothing to do
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		id := e.Name()
		dir := paths.GetReviewReqDir(projectRoot, id)
		reqs, err := reviewq.ListRequests(dir)
		if err != nil || len(reqs) == 0 {
			continue
		}
		// Refreshes from one head all ask the same thing, so a burst collapses into
		// one forge round trip and they all get the same answer. Notes and status
		// requests carry their own payload and are handled individually.
		var refresh *reviewq.Result
		for _, r := range reqs {
			res := reviewq.Result{OK: true}
			switch r.Op {
			case reviewq.OpNote:
				res = s.recordLocalNote(projectRoot, id, r)
			case reviewq.OpComments:
				res = s.hydraCommentsText(projectRoot, id, r)
			case reviewq.OpAddComment:
				res = s.addHydraComment(projectRoot, id, r)
			case reviewq.OpHeadStatus:
				res = s.headStatusText(ctx, id)
			case reviewq.OpTestLogs:
				res = s.testLogsText(ctx, id, r)
			case reviewq.OpRunTests:
				res = s.runTestsText(ctx, id, r)
			case reviewq.OpRunArtifacts:
				res = s.runArtifactsText(ctx, id, r)
			default:
				if refresh == nil {
					v := s.refreshReviewOnDemand(ctx, id)
					refresh = &v
				}
				res = *refresh
			}
			if err := reviewq.WriteResult(dir, r.ReqID, res); err != nil {
				log.Printf("warn: review refresh: write result for %s: %v", id, err)
			}
		}
		reviewq.Sweep(dir, reviewReqKeep)
	}
}

// refreshReviewOnDemand performs one head's requested refresh. It deliberately
// does NOT fail the request when the head has no MR or the snapshot is young -
// the review file is still the answer, it just didn't need rewriting.
func (s *Server) refreshReviewOnDemand(ctx context.Context, id string) reviewq.Result {
	if s.DB == nil {
		return reviewq.Result{OK: true, Message: "Hydra has no database open, so the review state could not be refreshed."}
	}
	a, err := s.DB.GetAgent(id)
	if err != nil || a == nil {
		return reviewq.Result{OK: true, Message: "This head is no longer known to Hydra, so its review state could not be refreshed."}
	}
	if a.ReviewID == "" && a.ReviewURL == "" {
		return reviewq.Result{OK: true} // unlinked: nothing to fetch, and the file already says so
	}
	if fresh(a.ReviewStateTime, reviewRefreshMinAge) {
		return reviewq.Result{OK: true} // just refreshed (usually by the sibling tool call)
	}
	refreshCtx, cancel := context.WithTimeout(s.backgroundOr(ctx), reviewRefreshTimeout)
	defer cancel()
	if _, err := s.refreshHeadReview(refreshCtx, *a); err != nil {
		return reviewq.Result{OK: false, Message: "The forge lookup failed (" + err.Error() + "), so this is Hydra's last cached state."}
	}
	return reviewq.Result{OK: true, Refreshed: true}
}

// recordLocalNote stores an agent's LOCAL-ONLY reply to a review comment,
// addressed by number.
//
// The number is what makes one tool cover both origins: it resolves either to one
// of Hydra's own comments (the reply becomes another comment, threaded under it)
// or to a forge note (the reply becomes a local note on that note's thread). It is
// never forwarded to the forge either way - the agent has no forge credentials,
// and a write to someone's PR is always an explicit user action. The user sees the
// reply in the diff viewer marked private and can repeat it to the forge
// themselves.
//
// Scoped to the calling head by construction: the request arrived on that head's
// own reviewq dir, and the number is resolved against that head's own store, so an
// agent cannot address a comment on someone else's diff even by guessing.
func (s *Server) recordLocalNote(projectRoot, id string, r reviewq.Request) reviewq.Result {
	if strings.TrimSpace(r.Body) == "" {
		return reviewq.Result{Message: "The reply was empty, so nothing was recorded."}
	}
	owner, author := commentOwner(id)
	target := r.ReplyTo
	if target <= 0 {
		return reviewq.Result{Message: "No comment number was given, so the reply had nothing to attach to. Take the number from get_review_comments."}
	}

	// One of Hydra's own comments: reply in kind, threaded under it.
	if parent, ok := reviewstore.FindComment(projectRoot, owner, target); ok && !parent.IsDraft() {
		c, err := reviewstore.AppendComment(projectRoot, owner, reviewstore.Comment{
			Status: reviewstore.StatusPublished, Author: author, Body: r.Body,
			ReplyTo: parent.Number, Path: parent.Path, Line: parent.Line, OldSide: parent.OldSide,
		})
		if err != nil {
			return reviewq.Result{Message: "The reply could not be saved: " + err.Error()}
		}
		s.notifyAgentsChanged(projectRoot, false)
		return reviewq.Result{OK: true, Message: fmt.Sprintf(
			"Saved as %s, threaded under #%d. The user can see it in Hydra's diff viewer.", c.Label(), parent.Number)}
	}

	// Otherwise a forge note: the reply attaches to its THREAD, local-only.
	_, ref, ok := reviewstore.ForgeRef(projectRoot, owner, target)
	if !ok || ref.Thread == "" {
		return reviewq.Result{Message: fmt.Sprintf(
			"No comment on this head has the number %d. Call get_review_comments to see what is there.", target)}
	}
	if _, err := reviewstore.AppendNote(projectRoot, owner, reviewstore.LocalNote{
		ThreadID: ref.Thread, Author: author, Body: r.Body,
	}); err != nil {
		return reviewq.Result{Message: "The reply could not be saved: " + err.Error()}
	}
	s.notifyAgentsChanged(projectRoot, false)
	return reviewq.Result{OK: true, Message: fmt.Sprintf(
		"Saved as a local note on the thread holding #%d. The user can see it in Hydra next to that thread; it was NOT posted to the forge.", target)}
}

// commentOwner maps the session id a review request arrived under to the HEAD
// whose comment store it belongs to, and the author to record for a write.
//
// A review slot has its own request dir (`<head>@review`) but no comment store of
// its own - the comments are about the head, and a reviewer that wrote into a
// private store would be talking to nobody. It signs as the reviewer rather than
// as the agent, because "your reviewer says this" and "the head says this" are
// very different claims, and the head must not be able to sign as its own
// reviewer.
func commentOwner(sessionID string) (headID, author string) {
	if head, slot, ok := heads.SplitSlotID(sessionID); ok && slot == heads.ReviewSlot {
		return head, reviewstore.AuthorReviewer
	}
	return sessionID, reviewstore.AuthorAgent
}

// hydraCommentsText answers an agent's read of Hydra's own review comments.
//
// PublishedComments, never LoadComments: a draft is the user's half-written
// thought, and half-written thoughts are not instructions. The filter lives in
// the store so a new caller cannot leak them by forgetting to apply it.
func (s *Server) hydraCommentsText(projectRoot, id string, r reviewq.Request) reviewq.Result {
	owner, _ := commentOwner(id)
	all := reviewstore.PublishedComments(projectRoot, owner)
	if len(r.Numbers) > 0 {
		want := map[int]bool{}
		for _, n := range r.Numbers {
			want[n] = true
		}
		var picked []reviewstore.Comment
		for _, c := range all {
			if want[c.Number] {
				picked = append(picked, c)
			}
		}
		if len(picked) == 0 {
			return reviewq.Result{OK: false, Message: "No published comment matches those numbers. Call get_review_comments with no arguments to see what is there."}
		}
		all = picked
	}
	// Full context only for a narrowed read. "Show me everything" should stay
	// cheap enough to call habitually; a diff block per comment would make an
	// unfiltered read on a long review the most expensive tool in the session.
	return reviewq.Result{OK: true, Message: reviewstore.RenderForAgent(all, len(r.Numbers) > 0, s.artifactImagePath(projectRoot))}
}

// artifactImagePath resolves a comment's image anchor back to the picture it was
// pinned on, so an agent reading the comment can simply open the file and look at
// what was meant instead of reasoning from coordinates alone. The sandbox mounts
// the filesystem read-only, so the path it hands out is one the agent can read.
//
// Validation is Manager.BlobPath's, deliberately: it already checks the key's
// shape and keeps the resolved path inside the entry dir, and an anchor arrives
// from a browser like any other client input. A file that no longer exists (the
// artifact cache was cleared, or it has been regenerated under a new key) returns
// "", which renders the anchor without a path rather than a path that 404s.
func (s *Server) artifactImagePath(projectRoot string) reviewstore.ImagePathFunc {
	return func(c reviewstore.Comment) (string, string) {
		a := c.Image
		picture := ""
		if a != nil && s.Artifacts != nil && a.Script != "" && a.Key != "" && a.File != "" {
			if path, _, err := s.Artifacts.Manager(projectRoot).BlobPath(a.Script, a.Key, a.File); err == nil {
				if _, err := os.Stat(path); err == nil {
					picture = path
				}
			}
		}
		// No second path any more: the artifact entry a comment points at is
		// PINNED against pruning, so the full picture stays retrievable and there
		// is nothing derived to keep alongside it.
		return picture, ""
	}
}

// addHydraComment appends an agent-authored review comment and tells the user's
// UI to refresh. Published on write: an agent has no drafts.
func (s *Server) addHydraComment(projectRoot, id string, r reviewq.Request) reviewq.Result {
	if strings.TrimSpace(r.Body) == "" {
		return reviewq.Result{Message: "The comment was empty, so nothing was recorded."}
	}
	owner, author := commentOwner(id)
	c, err := reviewstore.AppendComment(projectRoot, owner, reviewstore.Comment{
		Status: reviewstore.StatusPublished, Author: author, Body: r.Body,
		Path: r.Path, Line: r.Line, ReplyTo: r.ReplyTo,
	})
	if err != nil {
		return reviewq.Result{Message: "The comment could not be saved: " + err.Error()}
	}
	s.notifyAgentsChanged(projectRoot, false)
	msg := fmt.Sprintf("Saved as %s", c.Label())
	if anchor := c.Anchor(); anchor != "" {
		msg += " on " + anchor
	}
	return reviewq.Result{OK: true, Message: msg + ". The user can see it in Hydra's diff viewer; refer to it by its number from here on."}
}

// fresh reports whether an RFC3339 timestamp is within d of now. An empty or
// unparseable stamp is never fresh (so the refresh goes ahead).
func fresh(ts string, d time.Duration) bool {
	if ts == "" {
		return false
	}
	t, err := time.Parse(time.RFC3339, ts)
	if err != nil {
		return false
	}
	return time.Since(t) < d
}
