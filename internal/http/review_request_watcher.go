package http

import (
	"context"
	"log"
	"os"
	"strings"
	"time"

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

// RunReviewRequestWatcher answers on-demand review refreshes for sandboxed heads:
// the in-sandbox review tools (mcp__hydra__get_review_status /
// get_review_comments) drop a request into the head's reviewq dir before
// answering, and this loop re-reads the MR from the forge host-side and rewrites
// the head's review file, so the agent gets live data instead of whatever the 30s
// review watcher last cached.
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
		// one forge round trip and they all get the same answer. Notes carry their
		// own payload and are handled individually.
		var refresh *reviewq.Result
		for _, r := range reqs {
			res := reviewq.Result{OK: true}
			switch r.Op {
			case reviewq.OpNote:
				res = s.recordLocalNote(projectRoot, id, r)
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

// recordLocalNote stores an agent's LOCAL-ONLY reply on a review thread. It is
// never forwarded to the forge: the agent has no forge credentials, and a write
// to someone's PR is always an explicit user action. The user sees the note in
// the diff viewer marked private, and can repeat it to the forge themselves.
func (s *Server) recordLocalNote(projectRoot, id string, r reviewq.Request) reviewq.Result {
	if strings.TrimSpace(r.Body) == "" {
		return reviewq.Result{Message: "The note was empty, so nothing was recorded."}
	}
	if strings.TrimSpace(r.ThreadID) == "" {
		return reviewq.Result{Message: "No thread id was given, so the note had nothing to attach to."}
	}
	if _, err := reviewstore.AppendNote(projectRoot, id, reviewstore.LocalNote{
		ThreadID: r.ThreadID, Author: reviewstore.AuthorAgent, Body: r.Body,
	}); err != nil {
		return reviewq.Result{Message: "The note could not be saved: " + err.Error()}
	}
	s.notifyAgentsChanged(projectRoot, false)
	return reviewq.Result{OK: true}
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
