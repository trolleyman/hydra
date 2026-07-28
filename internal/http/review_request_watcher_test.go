package http

import (
	"context"
	"testing"
	"time"

	"github.com/trolleyman/hydra/internal/db"
	"github.com/trolleyman/hydra/internal/paths"
	"github.com/trolleyman/hydra/internal/reviewq"
)

// A refresh request must ALWAYS be answered, whatever state the head is in - the
// agent is blocked mid tool-call waiting for the result file, and an unanswered
// request means a 25s stall before it falls back to the cached snapshot.
func TestDrainReviewRequestsAlwaysAnswers(t *testing.T) {
	projectRoot := t.TempDir()
	store, err := db.Open(projectRoot)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	if err := store.CreateAgent(&db.Agent{ID: "unlinked", ProjectPath: projectRoot}); err != nil {
		t.Fatalf("create agent: %v", err)
	}
	// A head with a link whose state was cached moments ago: the daemon should
	// answer from it rather than burn a forge round trip (the sibling tool call
	// just refreshed it).
	if err := store.CreateAgent(&db.Agent{
		ID: "fresh", ProjectPath: projectRoot,
		ReviewID: "7", ReviewURL: "https://gh/pr/7",
		ReviewStateTime: time.Now().Format(time.RFC3339),
	}); err != nil {
		t.Fatalf("create agent: %v", err)
	}

	for _, id := range []string{"unlinked", "fresh", "gone"} {
		if err := reviewq.WriteRequest(paths.GetReviewReqDir(projectRoot, id), reviewq.Request{ReqID: "r1", TS: "t"}); err != nil {
			t.Fatalf("write request for %s: %v", id, err)
		}
	}

	(&Server{DB: store}).drainReviewRequests(context.Background(), projectRoot)

	for _, id := range []string{"unlinked", "fresh", "gone"} {
		dir := paths.GetReviewReqDir(projectRoot, id)
		res, ok, err := reviewq.ReadResult(dir, "r1")
		if err != nil || !ok {
			t.Fatalf("%s: no result written (ok=%v err=%v)", id, ok, err)
		}
		if !res.OK {
			t.Errorf("%s: result not OK: %+v", id, res)
		}
		if res.Refreshed {
			t.Errorf("%s: should not have hit the forge: %+v", id, res)
		}
		if pending, _ := reviewq.ListRequests(dir); len(pending) != 0 {
			t.Errorf("%s: request still pending after being answered: %v", id, pending)
		}
	}
	// A head Hydra no longer knows about should say so, so the agent doesn't read
	// a silent no-op as "your PR has no comments".
	if res, _, _ := reviewq.ReadResult(paths.GetReviewReqDir(projectRoot, "gone"), "r1"); res.Message == "" {
		t.Error("unknown head answered with no explanation")
	}
}

func TestFresh(t *testing.T) {
	now := time.Now()
	cases := []struct {
		name string
		ts   string
		want bool
	}{
		{"just now", now.Format(time.RFC3339), true},
		{"stale", now.Add(-time.Minute).Format(time.RFC3339), false},
		{"empty", "", false},
		{"unparseable", "not-a-time", false},
	}
	for _, c := range cases {
		if got := fresh(c.ts, reviewRefreshMinAge); got != c.want {
			t.Errorf("fresh(%s) = %v, want %v", c.name, got, c.want)
		}
	}
}
