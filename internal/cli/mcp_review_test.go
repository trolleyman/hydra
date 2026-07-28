package cli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/trolleyman/hydra/internal/mcpserver"
	"github.com/trolleyman/hydra/internal/reviewq"
)

// seedReviewEnv writes a review file and points the loader at it plus a request
// dir, returning the request dir.
func seedReviewEnv(t *testing.T, rf mcpserver.ReviewFile, withReqDir bool) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "review.json")
	data, err := json.Marshal(rf)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HYDRA_REVIEW_PATH", path)
	reqDir := filepath.Join(dir, "req")
	if withReqDir {
		t.Setenv("HYDRA_REVIEW_REQ_DIR", reqDir)
	} else {
		t.Setenv("HYDRA_REVIEW_REQ_DIR", "")
	}
	return reqDir
}

// The loader asks the daemon to re-read the MR before answering, and picks up
// what the daemon wrote - this is what makes the review tools live rather than
// serving whatever the 30s watcher last cached.
func TestLoadReviewFileRefreshesFirst(t *testing.T) {
	reqDir := seedReviewEnv(t, mcpserver.ReviewFile{Linked: true, URL: "https://gh/pr/1", UnresolvedDiscussions: 0}, true)

	// Stand in for the daemon: answer the request, having first rewritten the
	// review file with the freshly-fetched comment.
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 200; i++ {
			reqs, _ := reviewq.ListRequests(reqDir)
			if len(reqs) == 0 {
				time.Sleep(10 * time.Millisecond)
				continue
			}
			fresh, _ := json.Marshal(mcpserver.ReviewFile{
				Linked: true, URL: "https://gh/pr/1", UnresolvedDiscussions: 1,
				Comments: []mcpserver.ReviewComment{{Author: "alice", Body: "left while you were working"}},
			})
			_ = os.WriteFile(os.Getenv("HYDRA_REVIEW_PATH"), fresh, 0o644)
			_ = reviewq.WriteResult(reqDir, reqs[0].ReqID, reviewq.Result{OK: true, Refreshed: true})
			return
		}
	}()

	rf := loadReviewFile()
	<-done
	if rf == nil {
		t.Fatal("loadReviewFile returned nil")
	}
	if len(rf.Comments) != 1 || rf.Comments[0].Author != "alice" {
		t.Errorf("loader served the pre-refresh snapshot: %+v", rf)
	}
	if rf.StaleReason != "" {
		t.Errorf("a completed refresh should not be flagged stale: %q", rf.StaleReason)
	}
}

// A head seeded before the refresh channel existed (no request dir) must still
// answer from its file rather than hanging or erroring.
func TestLoadReviewFileWithoutRefreshChannel(t *testing.T) {
	seedReviewEnv(t, mcpserver.ReviewFile{Linked: true, URL: "https://gh/pr/1"}, false)
	rf := loadReviewFile()
	if rf == nil || rf.URL != "https://gh/pr/1" {
		t.Fatalf("loadReviewFile = %+v, want the seeded file", rf)
	}
	if rf.StaleReason != "" {
		t.Errorf("no channel is not a staleness reason: %q", rf.StaleReason)
	}
}

// A failed refresh is not fatal: the agent gets the cached snapshot plus the
// reason, which beats acting on "no comments" from stale state.
func TestLoadReviewFileFailedRefreshIsFlagged(t *testing.T) {
	reqDir := seedReviewEnv(t, mcpserver.ReviewFile{Linked: true, URL: "https://gh/pr/1"}, true)
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 200; i++ {
			reqs, _ := reviewq.ListRequests(reqDir)
			if len(reqs) == 0 {
				time.Sleep(10 * time.Millisecond)
				continue
			}
			_ = reviewq.WriteResult(reqDir, reqs[0].ReqID, reviewq.Result{OK: false, Message: "The forge lookup failed (gh: not logged in), so this is Hydra's last cached state."})
			return
		}
	}()

	rf := loadReviewFile()
	<-done
	if rf == nil {
		t.Fatal("loadReviewFile returned nil")
	}
	if rf.StaleReason == "" {
		t.Error("a failed refresh should be surfaced as a staleness reason")
	}
}
