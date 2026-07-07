package forge

import (
	"braces.dev/errtrace"
	"context"
	"strings"
	"testing"
)

// fakeRunner records calls and returns scripted output/errors keyed by a
// substring of the joined command line.
type fakeRunner struct {
	calls    []string
	response func(cmdline string) (string, error)
}

func (f *fakeRunner) run(_ context.Context, _ string, name string, args ...string) (string, error) {
	cmdline := name + " " + strings.Join(args, " ")
	f.calls = append(f.calls, cmdline)
	if f.response != nil {
		return errtrace.Wrap2(f.response(cmdline))
	}
	return "", nil
}

func TestGhCIStatus(t *testing.T) {
	type check = struct {
		State      string `json:"state"`
		Status     string `json:"status"`
		Conclusion string `json:"conclusion"`
	}
	cases := []struct {
		name   string
		rollup []check
		want   string
	}{
		{"empty", nil, CINone},
		{"all success", []check{{Conclusion: "SUCCESS"}}, CISuccess},
		{"one failure", []check{{Conclusion: "SUCCESS"}, {Conclusion: "FAILURE"}}, CIFailed},
		{"in progress", []check{{State: "IN_PROGRESS"}}, CIRunning},
	}
	for _, c := range cases {
		if got := ghCIStatus(c.rollup); got != c.want {
			t.Errorf("%s: ghCIStatus = %q, want %q", c.name, got, c.want)
		}
	}
}

func TestGhStateAndStatus(t *testing.T) {
	pr := ghPR{Number: 7, URL: "https://gh/pr/7", State: "OPEN", IsDraft: true, Mergeable: "MERGEABLE", ReviewDecision: "APPROVED"}
	st := pr.toStatus()
	if st.State != StateDraft {
		t.Errorf("state = %q, want draft", st.State)
	}
	if st.Approvals != 1 || st.ApprovalsRequired != 1 {
		t.Errorf("approvals = %d/%d, want 1/1", st.Approvals, st.ApprovalsRequired)
	}
	if !st.Mergeable {
		t.Error("want mergeable")
	}
}

// TestGhStatusUnresolvedThreads checks Status pulls unresolved review threads
// from the GraphQL query (not `gh pr view`, which rejects reviewThreads) and
// never sends reviewThreads to `pr view`.
func TestGhStatusUnresolvedThreads(t *testing.T) {
	f := &fakeRunner{response: func(cmd string) (string, error) {
		switch {
		case strings.Contains(cmd, "pr view"):
			if strings.Contains(cmd, "reviewThreads") {
				t.Errorf("pr view must not request reviewThreads: %s", cmd)
			}
			return `{"number":7,"url":"https://gh/pr/7","state":"OPEN","mergeable":"MERGEABLE"}`, nil
		case strings.Contains(cmd, "repo view"):
			return "octo/hydra\n", nil
		case strings.Contains(cmd, "api graphql"):
			return `{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[{"isResolved":false},{"isResolved":true},{"isResolved":false}]}}}}}`, nil
		}
		return "", nil
	}}
	p := &githubProvider{run: f.run}
	st, err := p.Status(context.Background(), "/repo", "origin", "7")
	if err != nil {
		t.Fatal(err)
	}
	if st.UnresolvedDiscussions != 2 {
		t.Errorf("unresolved = %d, want 2", st.UnresolvedDiscussions)
	}
}

func TestGithubEnsureMRIdempotent(t *testing.T) {
	f := &fakeRunner{response: func(cmd string) (string, error) {
		if strings.Contains(cmd, "pr view") {
			return `{"number":42,"url":"https://gh/pr/42","state":"OPEN"}`, nil
		}
		t.Fatalf("unexpected command (should not create): %s", cmd)
		return "", nil
	}}
	p := &githubProvider{run: f.run}
	mr, err := p.EnsureMR(context.Background(), EnsureMROptions{SourceBranch: "feat/x", TargetBranch: "main"})
	if err != nil {
		t.Fatal(err)
	}
	if mr.ID != "42" || mr.URL != "https://gh/pr/42" {
		t.Errorf("mr = %+v, want id 42", mr)
	}
	for _, c := range f.calls {
		if strings.Contains(c, "pr create") {
			t.Errorf("should not have created a PR: %v", f.calls)
		}
	}
}

func TestGithubEnsureMRCreates(t *testing.T) {
	created := false
	f := &fakeRunner{response: func(cmd string) (string, error) {
		switch {
		case strings.Contains(cmd, "pr create"):
			created = true
			return "https://gh/pr/99\n", nil
		case strings.Contains(cmd, "pr view") && !created:
			return "", errtrace.Wrap(&CLIError{Stderr: "no pull requests found for branch"})
		case strings.Contains(cmd, "pr view") && created:
			return `{"number":99,"url":"https://gh/pr/99","state":"OPEN","isDraft":true}`, nil
		}
		return "", nil
	}}
	p := &githubProvider{run: f.run}
	mr, err := p.EnsureMR(context.Background(), EnsureMROptions{SourceBranch: "feat/x", TargetBranch: "main", Draft: true})
	if err != nil {
		t.Fatal(err)
	}
	if !created {
		t.Error("expected a create call")
	}
	if mr.ID != "99" {
		t.Errorf("mr = %+v, want id 99", mr)
	}
}

func TestGlabStatusParse(t *testing.T) {
	f := &fakeRunner{response: func(cmd string) (string, error) {
		if strings.Contains(cmd, "mr view") {
			return `{"iid":12,"web_url":"https://gl/mr/12","state":"opened","draft":false,"merge_status":"can_be_merged","blocking_discussions_resolved":false,"head_pipeline":{"status":"running"},"upvotes":2}`, nil
		}
		return "", nil
	}}
	p := &gitlabProvider{run: f.run}
	st, err := p.Status(context.Background(), "/repo", "origin", "12")
	if err != nil {
		t.Fatal(err)
	}
	if st.State != StateOpen {
		t.Errorf("state = %q, want open", st.State)
	}
	if st.CIStatus != CIRunning {
		t.Errorf("ci = %q, want running", st.CIStatus)
	}
	if st.Approvals != 2 {
		t.Errorf("approvals = %d, want 2", st.Approvals)
	}
	if st.UnresolvedDiscussions != 1 {
		t.Errorf("unresolved = %d, want 1 (blocking not resolved)", st.UnresolvedDiscussions)
	}
	if !st.Mergeable {
		t.Error("want mergeable")
	}
}

func TestGlabMergeArgs(t *testing.T) {
	f := &fakeRunner{}
	p := &gitlabProvider{run: f.run}
	if err := p.Merge(context.Background(), "/repo", "origin", "5", MergeOptions{Squash: true, RemoveSourceBranch: true, Auto: true}); err != nil {
		t.Fatal(err)
	}
	if len(f.calls) != 1 {
		t.Fatalf("calls = %v", f.calls)
	}
	got := f.calls[0]
	for _, want := range []string{"mr merge 5", "--yes", "--squash", "--remove-source-branch", "--when-pipeline-succeeds"} {
		if !strings.Contains(got, want) {
			t.Errorf("merge args %q missing %q", got, want)
		}
	}
}
