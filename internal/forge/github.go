package forge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"braces.dev/errtrace"
)

// githubProvider implements Provider by shelling out to the `gh` CLI. gh
// auto-detects the repository from the checkout's remotes, so most commands just
// run in RepoDir; --repo is not passed (letting gh's own resolution handle
// forks/multi-remote per its config).
type githubProvider struct{ run runner }

func (p *githubProvider) Name() string { return ProviderGitHub }

// ghPR is the subset of `gh pr view --json ...` output we read.
type ghPR struct {
	Number         int    `json:"number"`
	URL            string `json:"url"`
	State          string `json:"state"` // OPEN | MERGED | CLOSED
	IsDraft        bool   `json:"isDraft"`
	Mergeable      string `json:"mergeable"` // MERGEABLE | CONFLICTING | UNKNOWN
	ReviewDecision string `json:"reviewDecision"`
	StatusRollup   []struct {
		State      string `json:"state"`      // check runs: COMPLETED/IN_PROGRESS/QUEUED
		Status     string `json:"status"`     // legacy status contexts
		Conclusion string `json:"conclusion"` // SUCCESS/FAILURE/...
	} `json:"statusCheckRollup"`
}

func (p *githubProvider) EnsureMR(ctx context.Context, o EnsureMROptions) (MR, error) {
	if pr, ok, err := p.find(ctx, o.RepoDir, o.SourceBranch); err != nil {
		return MR{}, errtrace.Wrap(err)
	} else if ok {
		return MR{ID: strconv.Itoa(pr.Number), URL: pr.URL}, nil
	}
	args := []string{"pr", "create", "--head", o.SourceBranch, "--base", o.TargetBranch, "--title", o.Title, "--body", o.Description}
	if o.Draft {
		args = append(args, "--draft")
	}
	// squash / remove-source-branch are merge-time options on GitHub, not settable
	// at PR-create; they are applied by Merge.
	out, err := p.run(ctx, o.RepoDir, "gh", args...)
	if err != nil {
		return MR{}, errtrace.Wrap(err)
	}
	// gh prints the new PR URL on stdout; re-query for the number.
	if pr, ok, err2 := p.find(ctx, o.RepoDir, o.SourceBranch); err2 == nil && ok {
		return MR{ID: strconv.Itoa(pr.Number), URL: pr.URL}, nil
	}
	return MR{URL: strings.TrimSpace(lastLine(out))}, nil
}

// find looks up an open/closed PR for a branch. Not found is (false, nil), not an
// error (gh exits non-zero with "no pull requests found").
func (p *githubProvider) find(ctx context.Context, dir, branch string) (ghPR, bool, error) {
	out, err := p.run(ctx, dir, "gh", "pr", "view", branch, "--json", ghViewFields)
	if err != nil {
		if isNoPR(err) {
			return ghPR{}, false, nil
		}
		return ghPR{}, false, errtrace.Wrap(err)
	}
	var pr ghPR
	if err := json.Unmarshal([]byte(out), &pr); err != nil {
		return ghPR{}, false, errtrace.Wrap(err)
	}
	return pr, true, nil
}

// ghViewFields are the --json fields fetched for status. reviewThreads is NOT
// among them: it is a GraphQL-only field that `gh pr view --json` rejects
// ("Unknown JSON field"), so unresolved-discussion counts come from a separate
// GraphQL query (unresolvedThreadCount).
const ghViewFields = "number,url,state,isDraft,mergeable,reviewDecision,statusCheckRollup"

func (p *githubProvider) Status(ctx context.Context, repoDir, _ /*remote*/, id string) (Status, error) {
	out, err := p.run(ctx, repoDir, "gh", "pr", "view", id, "--json", ghViewFields)
	if err != nil {
		return Status{}, errtrace.Wrap(err)
	}
	var pr ghPR
	if err := json.Unmarshal([]byte(out), &pr); err != nil {
		return Status{}, errtrace.Wrap(err)
	}
	st := pr.toStatus()
	// Unresolved review threads need GraphQL (see ghViewFields). Best-effort: a
	// failure here just leaves the count at 0 rather than failing the whole poll.
	if n, err := p.unresolvedThreadCount(ctx, repoDir, id); err == nil {
		st.UnresolvedDiscussions = n
	}
	return st, nil
}

// unresolvedThreadCount returns the number of unresolved review threads on PR
// `id` via a GraphQL query (the only place GitHub exposes thread resolution).
// The repo (owner/name) is resolved from the checkout with `gh repo view`.
func (p *githubProvider) unresolvedThreadCount(ctx context.Context, repoDir, id string) (int, error) {
	num, err := strconv.Atoi(id)
	if err != nil {
		return 0, errtrace.Wrap(err)
	}
	owner, name, err := p.repoOwnerName(ctx, repoDir)
	if err != nil {
		return 0, errtrace.Wrap(err)
	}
	const query = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved}}}}}`
	out, err := p.run(ctx, repoDir, "gh", "api", "graphql",
		"-f", "query="+query,
		"-F", "owner="+owner,
		"-F", "name="+name,
		"-F", "number="+strconv.Itoa(num))
	if err != nil {
		return 0, errtrace.Wrap(err)
	}
	var resp struct {
		Data struct {
			Repository struct {
				PullRequest struct {
					ReviewThreads struct {
						Nodes []struct {
							IsResolved bool `json:"isResolved"`
						} `json:"nodes"`
					} `json:"reviewThreads"`
				} `json:"pullRequest"`
			} `json:"repository"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(out), &resp); err != nil {
		return 0, errtrace.Wrap(err)
	}
	unresolved := 0
	for _, t := range resp.Data.Repository.PullRequest.ReviewThreads.Nodes {
		if !t.IsResolved {
			unresolved++
		}
	}
	return unresolved, nil
}

// repoOwnerName resolves the checkout's forge repository as owner, name. It uses
// gh's own repo detection (remotes/config), matching how the other gh calls
// resolve the repo.
func (p *githubProvider) repoOwnerName(ctx context.Context, repoDir string) (owner, name string, err error) {
	out, err := p.run(ctx, repoDir, "gh", "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner")
	if err != nil {
		return "", "", errtrace.Wrap(err)
	}
	full := strings.TrimSpace(out)
	i := strings.IndexByte(full, '/')
	if i <= 0 || i == len(full)-1 {
		return "", "", errtrace.Wrap(fmt.Errorf("unexpected repo name %q from gh repo view", full))
	}
	return full[:i], full[i+1:], nil
}

func (pr ghPR) toStatus() Status {
	st := Status{
		ID:        strconv.Itoa(pr.Number),
		URL:       pr.URL,
		State:     ghState(pr.State, pr.IsDraft),
		CIStatus:  ghCIStatus(pr.StatusRollup),
		Mergeable: strings.EqualFold(pr.Mergeable, "MERGEABLE"),
	}
	if strings.EqualFold(pr.ReviewDecision, "APPROVED") {
		st.Approvals, st.ApprovalsRequired = 1, 1
	} else if strings.EqualFold(pr.ReviewDecision, "REVIEW_REQUIRED") {
		st.ApprovalsRequired = 1
	}
	// UnresolvedDiscussions is filled by Status via unresolvedThreadCount (GraphQL).
	return st
}

// ghState maps gh's PR state to the normalized state.
func ghState(state string, draft bool) string {
	switch strings.ToUpper(state) {
	case "MERGED":
		return StateMerged
	case "CLOSED":
		return StateClosed
	default:
		if draft {
			return StateDraft
		}
		return StateOpen
	}
}

// ghCIStatus reduces the status-check rollup to one normalized CI status.
func ghCIStatus(rollup []struct {
	State      string `json:"state"`
	Status     string `json:"status"`
	Conclusion string `json:"conclusion"`
}) string {
	if len(rollup) == 0 {
		return CINone
	}
	anyRunning := false
	for _, c := range rollup {
		concl := strings.ToUpper(c.Conclusion)
		state := strings.ToUpper(c.State)
		status := strings.ToUpper(c.Status)
		switch {
		case concl == "FAILURE" || concl == "TIMED_OUT" || concl == "CANCELLED" || concl == "ACTION_REQUIRED" || state == "FAILURE" || state == "ERROR":
			return CIFailed
		case state == "IN_PROGRESS" || state == "QUEUED" || state == "PENDING" || status == "IN_PROGRESS" || status == "QUEUED" || status == "PENDING" || (concl == "" && state == "" && status == ""):
			anyRunning = true
		}
	}
	if anyRunning {
		return CIRunning
	}
	return CISuccess
}

func (p *githubProvider) Merge(ctx context.Context, repoDir, _ string, id string, o MergeOptions) error {
	args := []string{"pr", "merge", id}
	if o.Squash {
		args = append(args, "--squash")
	} else {
		args = append(args, "--merge")
	}
	if o.Auto {
		args = append(args, "--auto")
	}
	if o.RemoveSourceBranch {
		args = append(args, "--delete-branch")
	}
	_, err := p.run(ctx, repoDir, "gh", args...)
	return errtrace.Wrap(err)
}

// ghComment is one PR review comment (file/line context) from `gh api`.
type ghComment struct {
	ID   int    `json:"id"`
	Body string `json:"body"`
	Path string `json:"path"`
	Line int    `json:"line"`
	User struct {
		Login string `json:"login"`
	} `json:"user"`
	HTMLURL string `json:"html_url"`
}

func (p *githubProvider) Discussions(ctx context.Context, repoDir, _ string, id string) ([]Discussion, error) {
	// Review comments (with file/line) via the REST API through gh, which reuses
	// gh's auth. This lists all review comments; GitHub does not expose a simple
	// "unresolved only" filter over REST, so all are returned (best-effort).
	out, err := p.run(ctx, repoDir, "gh", "api", "repos/{owner}/{repo}/pulls/"+id+"/comments", "--paginate")
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	var comments []ghComment
	if err := json.Unmarshal([]byte(out), &comments); err != nil {
		return nil, errtrace.Wrap(err)
	}
	res := make([]Discussion, 0, len(comments))
	for _, c := range comments {
		res = append(res, Discussion{
			ID:     strconv.Itoa(c.ID),
			Author: c.User.Login,
			Body:   c.Body,
			Path:   c.Path,
			Line:   c.Line,
			URL:    c.HTMLURL,
		})
	}
	return res, nil
}

// ghAuthStatus reports gh login state via `gh auth status`.
func ghAuthStatus(ctx context.Context) (bool, string, error) {
	if !cliAvailable("gh") {
		return false, "gh not installed", nil
	}
	out, err := execRunner(ctx, "", "gh", "auth", "status")
	if err != nil {
		var cliErr *CLIError
		if errors.As(err, &cliErr) {
			return false, firstNonEmptyLine(cliErr.Stderr), nil
		}
		return false, "not authenticated", nil
	}
	return true, firstNonEmptyLine(out), nil
}

// isNoPR reports whether a gh error is the benign "no PR for this branch" case.
func isNoPR(err error) bool {
	var cliErr *CLIError
	if errors.As(err, &cliErr) {
		low := strings.ToLower(cliErr.Stderr)
		return strings.Contains(low, "no pull requests found") || strings.Contains(low, "no open pull requests")
	}
	return false
}

// lastLine returns the last non-empty line of s (gh prints the PR URL last).
func lastLine(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if t := strings.TrimSpace(lines[i]); t != "" {
			return t
		}
	}
	return ""
}

// firstNonEmptyLine returns the first non-empty line of s.
func firstNonEmptyLine(s string) string {
	for _, ln := range strings.Split(s, "\n") {
		if t := strings.TrimSpace(ln); t != "" {
			return t
		}
	}
	return ""
}
