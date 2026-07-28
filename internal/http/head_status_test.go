package http

import (
	"context"
	"strings"
	"testing"

	"github.com/trolleyman/hydra/internal/db"
	"github.com/trolleyman/hydra/internal/paths"
	"github.com/trolleyman/hydra/internal/reviewq"
	hydratests "github.com/trolleyman/hydra/internal/tests"
)

// Like a refresh, a status request must ALWAYS be answered: the agent is blocked
// mid tool-call polling for the result file, so an unanswered request costs it
// the full in-sandbox timeout before it gives up.
func TestDrainReviewRequestsAnswersStatusOps(t *testing.T) {
	projectRoot := t.TempDir()
	store, err := db.Open(projectRoot)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	if err := store.CreateAgent(&db.Agent{ID: "head", ProjectPath: projectRoot}); err != nil {
		t.Fatalf("create agent: %v", err)
	}

	cases := []struct {
		reqid string
		req   reviewq.Request
	}{
		{"s1", reviewq.Request{Op: reviewq.OpHeadStatus}},
		{"s2", reviewq.Request{Op: reviewq.OpTestLogs, Runner: "unit"}},
		// A test_logs call with no runner is the agent's mistake, not Hydra's - it
		// still gets an answer, one that tells it what to do instead.
		{"s3", reviewq.Request{Op: reviewq.OpTestLogs}},
	}
	dir := paths.GetReviewReqDir(projectRoot, "head")
	for _, c := range cases {
		r := c.req
		r.ReqID = c.reqid
		r.TS = "t"
		if err := reviewq.WriteRequest(dir, r); err != nil {
			t.Fatalf("write %s: %v", c.reqid, err)
		}
	}
	// An id Hydra doesn't know must be answered too, rather than left to time out.
	unknownDir := paths.GetReviewReqDir(projectRoot, "gone")
	if err := reviewq.WriteRequest(unknownDir, reviewq.Request{ReqID: "s4", TS: "t", Op: reviewq.OpHeadStatus}); err != nil {
		t.Fatalf("write s4: %v", err)
	}

	(&Server{DB: store}).drainReviewRequests(context.Background(), projectRoot)

	for _, c := range cases {
		res, ok, err := reviewq.ReadResult(dir, c.reqid)
		if err != nil || !ok {
			t.Fatalf("%s: no result written (ok=%v err=%v)", c.reqid, ok, err)
		}
		if strings.TrimSpace(res.Message) == "" {
			t.Errorf("%s: empty message - the agent would get a blank tool result", c.reqid)
		}
	}
	if res, ok, _ := reviewq.ReadResult(unknownDir, "s4"); !ok || !strings.Contains(res.Message, "no longer known") {
		t.Errorf("unknown head: want a 'no longer known' explanation, got ok=%v %+v", ok, res)
	}
	// s3 named no runner, so it must say so rather than guess one.
	if res, _, _ := reviewq.ReadResult(dir, "s3"); !strings.Contains(res.Message, "No runner was named") {
		t.Errorf("s3: want the missing-runner explanation, got %q", res.Message)
	}
}

// The failing-case list is what tells an agent WHAT broke, so it must name the
// cases, keep their location, and cap a bulk failure instead of pasting a whole
// suite into the agent's context.
func TestFailingCasesText(t *testing.T) {
	cases := []hydratests.TestCase{
		{Name: "passes", Status: hydratests.CasePassed},
		{Name: "skipped", Status: hydratests.CaseSkipped},
		{Name: "breaks", Status: hydratests.CaseFailed, Path: "internal/x/y.go", Line: 42, Scope: []string{"TestOuter"}, Message: "want 1\ngot 2"},
	}
	got := failingCasesText(cases)
	for _, want := range []string{"TestOuter > breaks", "internal/x/y.go:42", "want 1 got 2"} {
		if !strings.Contains(got, want) {
			t.Errorf("failingCasesText = %q, missing %q", got, want)
		}
	}
	if strings.Contains(got, "passes") || strings.Contains(got, "skipped") {
		t.Errorf("failingCasesText listed a non-failing case: %q", got)
	}

	var bulk []hydratests.TestCase
	for range headStatusMaxCases + 7 {
		bulk = append(bulk, hydratests.TestCase{Name: "case", Status: hydratests.CaseFailed})
	}
	got = failingCasesText(bulk)
	if n := strings.Count(got, "  - case"); n != headStatusMaxCases {
		t.Errorf("listed %d cases, want the cap of %d", n, headStatusMaxCases)
	}
	if !strings.Contains(got, "and 7 more") {
		t.Errorf("bulk failure must count the tail it dropped, got %q", got)
	}

	if got := failingCasesText(cases[:2]); got != "" {
		t.Errorf("no failures should render nothing, got %q", got)
	}
}

// oneLine keeps a runaway assertion message from reflowing the whole answer.
func TestOneLine(t *testing.T) {
	if got := oneLine("  a\r\nb   c \n", 100); got != "a b c" {
		t.Errorf("oneLine = %q, want %q", got, "a b c")
	}
	if got := oneLine(strings.Repeat("x", 50), 10); got != strings.Repeat("x", 10)+"..." {
		t.Errorf("oneLine did not truncate: %q", got)
	}
	if got := oneLine("   ", 10); got != "" {
		t.Errorf("blank text should render nothing, got %q", got)
	}
}
