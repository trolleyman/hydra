package http

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/trolleyman/hydra/internal/db"
	"github.com/trolleyman/hydra/internal/heads"
	"github.com/trolleyman/hydra/internal/paths"
	"github.com/trolleyman/hydra/internal/reviewq"
	"github.com/trolleyman/hydra/internal/reviewstore"
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

// An agent resolving its own review comments is the point of the tool: it is the
// only thing that knows #3 is actually done. The parts worth pinning are that it
// resolves by the shared numbering, that it does NOT silently swallow a number
// nobody has (an agent told "resolved 3 of 4" as if it were 4 moves on), and that
// reopen is the inverse rather than a second spelling of resolve.
func TestResolveHydraComments(t *testing.T) {
	projectRoot := t.TempDir()
	s := &Server{}
	first, err := reviewstore.AppendComment(projectRoot, "head", reviewstore.Comment{
		Status: reviewstore.StatusPublished, Author: reviewstore.AuthorUser, Body: "fix this", Path: "a.go", Line: 4,
	})
	if err != nil {
		t.Fatalf("append: %v", err)
	}

	res := s.resolveHydraComments(projectRoot, "head", reviewq.Request{Numbers: []int{first.Number}})
	if !res.OK {
		t.Fatalf("resolve failed: %s", res.Message)
	}
	if got, _ := reviewstore.FindComment(projectRoot, "head", first.Number); !got.Resolved {
		t.Error("the comment was not marked resolved")
	}
	// Local only, and it has to SAY so - an agent that believes it closed a PR
	// discussion will tell the user it did.
	if !strings.Contains(res.Message, "forge") {
		t.Errorf("message does not say the resolve is local: %s", res.Message)
	}

	// A number nobody has is called out, and the one that does exist still lands.
	second, _ := reviewstore.AppendComment(projectRoot, "head", reviewstore.Comment{
		Status: reviewstore.StatusPublished, Author: reviewstore.AuthorUser, Body: "and this", Path: "b.go", Line: 9,
	})
	res = s.resolveHydraComments(projectRoot, "head", reviewq.Request{Numbers: []int{second.Number, 999}})
	if !res.OK {
		t.Fatalf("partial resolve reported failure: %s", res.Message)
	}
	if !strings.Contains(res.Message, "#999") {
		t.Errorf("the number that matched nothing was not named: %s", res.Message)
	}
	if got, _ := reviewstore.FindComment(projectRoot, "head", second.Number); !got.Resolved {
		t.Error("the real comment was skipped because an unknown one rode with it")
	}

	// Reopen is the inverse.
	if res := s.resolveHydraComments(projectRoot, "head", reviewq.Request{Numbers: []int{first.Number}, Reopen: true}); !res.OK {
		t.Fatalf("reopen failed: %s", res.Message)
	}
	if got, _ := reviewstore.FindComment(projectRoot, "head", first.Number); got.Resolved {
		t.Error("reopen did not put the comment back")
	}

	// No numbers at all is a mistake worth naming rather than a silent no-op.
	if res := s.resolveHydraComments(projectRoot, "head", reviewq.Request{}); res.OK {
		t.Error("an empty resolve reported success")
	}
}

// A REVIEWER resolves the head's comments, not its own private set: the review
// slot has no comment store, so its writes must land on the head it is reviewing.
func TestResolveHydraCommentsFromTheReviewSlot(t *testing.T) {
	projectRoot := t.TempDir()
	s := &Server{}
	c, err := reviewstore.AppendComment(projectRoot, "head", reviewstore.Comment{
		Status: reviewstore.StatusPublished, Author: reviewstore.AuthorUser, Body: "look at this", Path: "a.go", Line: 1,
	})
	if err != nil {
		t.Fatalf("append: %v", err)
	}
	if res := s.resolveHydraComments(projectRoot, heads.ReviewSessionID("head"), reviewq.Request{Numbers: []int{c.Number}}); !res.OK {
		t.Fatalf("reviewer resolve failed: %s", res.Message)
	}
	if got, _ := reviewstore.FindComment(projectRoot, "head", c.Number); !got.Resolved {
		t.Error("the reviewer's resolve did not reach the head's comment store")
	}
}
