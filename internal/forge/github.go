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
		if o.UpdateExistingMetadata {
			if _, err := p.run(ctx, o.RepoDir, "gh", "pr", "edit", strconv.Itoa(pr.Number), "--title", o.Title, "--body", o.Description); err != nil {
				return MR{}, errtrace.Wrap(err)
			}
		}
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

func (p *githubProvider) Close(ctx context.Context, repoDir, _ string, id string) error {
	_, err := p.run(ctx, repoDir, "gh", "pr", "close", id)
	return errtrace.Wrap(err)
}

// ghThreadsQuery pulls the PR's review threads with their comments. Thread
// resolution is GraphQL-only on GitHub (see ghViewFields), and fetching the
// comments in the same query keeps a thread render to ONE round trip.
const ghThreadsQuery = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved isOutdated path line startLine originalLine originalStartLine comments(first:100){nodes{databaseId body diffHunk url createdAt author{login avatarUrl}}}}}}}}`

// ghThreadsResp is the shape of ghThreadsQuery's response.
type ghThreadsResp struct {
	Data struct {
		Repository struct {
			PullRequest struct {
				ReviewThreads struct {
					Nodes []struct {
						IsResolved        bool   `json:"isResolved"`
						IsOutdated        bool   `json:"isOutdated"`
						Path              string `json:"path"`
						Line              *int   `json:"line"`
						StartLine         *int   `json:"startLine"`
						OriginalLine      *int   `json:"originalLine"`
						OriginalStartLine *int   `json:"originalStartLine"`
						Comments          struct {
							Nodes []struct {
								DatabaseID int    `json:"databaseId"`
								Body       string `json:"body"`
								DiffHunk   string `json:"diffHunk"`
								URL        string `json:"url"`
								CreatedAt  string `json:"createdAt"`
								Author     struct {
									Login string `json:"login"`
									// The forge already hosts these, so Hydra never has to:
									// the browser renders the URL directly, and a fetch that
									// fails just falls back to a monogram.
									AvatarURL string `json:"avatarUrl"`
								} `json:"author"`
							} `json:"nodes"`
						} `json:"comments"`
					} `json:"nodes"`
				} `json:"reviewThreads"`
			} `json:"pullRequest"`
		} `json:"repository"`
	} `json:"data"`
}

func (p *githubProvider) Threads(ctx context.Context, repoDir, _ string, id string) ([]Thread, error) {
	num, err := strconv.Atoi(id)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	owner, name, err := p.repoOwnerName(ctx, repoDir)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	out, err := p.run(ctx, repoDir, "gh", "api", "graphql",
		"-f", "query="+ghThreadsQuery,
		"-F", "owner="+owner,
		"-F", "name="+name,
		"-F", "number="+strconv.Itoa(num))
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	var resp ghThreadsResp
	if err := json.Unmarshal([]byte(out), &resp); err != nil {
		return nil, errtrace.Wrap(err)
	}
	nodes := resp.Data.Repository.PullRequest.ReviewThreads.Nodes
	threads := make([]Thread, 0, len(nodes))
	for _, n := range nodes {
		t := Thread{Path: n.Path, Resolved: n.IsResolved, Outdated: n.IsOutdated}
		// `line` goes null once a thread is outdated; originalLine still anchors it
		// to where it was written, which is what the diff viewer can match on.
		if n.Line != nil {
			t.Line = *n.Line
			if n.StartLine != nil {
				t.StartLine = *n.StartLine
			}
		} else if n.OriginalLine != nil {
			t.Line = *n.OriginalLine
			if n.OriginalStartLine != nil {
				t.StartLine = *n.OriginalStartLine
			}
		}
		for _, c := range n.Comments.Nodes {
			t.Notes = append(t.Notes, Note{
				ID:        strconv.Itoa(c.DatabaseID),
				Author:    c.Author.Login,
				AvatarURL: c.Author.AvatarURL,
				Body:      c.Body,
				DiffHunk:  c.DiffHunk,
				URL:       c.URL,
				CreatedAt: c.CreatedAt,
			})
		}
		if len(t.Notes) == 0 {
			continue // a thread with no readable comments has nothing to show or reply to
		}
		// GitHub replies address the ROOT comment's REST id, so that is the thread
		// handle Hydra carries around.
		t.ID = t.Notes[0].ID
		t.URL = t.Notes[0].URL
		threads = append(threads, t)
	}
	return threads, nil
}

func (p *githubProvider) ReplyToThread(ctx context.Context, repoDir, _ string, id, threadID, body string) error {
	if strings.TrimSpace(body) == "" {
		return errtrace.Wrap(errors.New("reply body is empty"))
	}
	owner, name, err := p.repoOwnerName(ctx, repoDir)
	if err != nil {
		return errtrace.Wrap(err)
	}
	path := fmt.Sprintf("repos/%s/%s/pulls/%s/comments/%s/replies", owner, name, id, threadID)
	_, err = p.run(ctx, repoDir, "gh", "api", "-X", "POST", path, "-f", "body="+body)
	return errtrace.Wrap(err)
}

func (p *githubProvider) CommentOnLine(ctx context.Context, repoDir, _ string, id string, c NewLineComment) error {
	if strings.TrimSpace(c.Body) == "" {
		return errtrace.Wrap(errors.New("comment body is empty"))
	}
	owner, name, err := p.repoOwnerName(ctx, repoDir)
	if err != nil {
		return errtrace.Wrap(err)
	}
	// A new review comment must name the commit it applies to; GitHub rejects a
	// stale sha, so it is read fresh rather than cached on the head.
	sha, err := p.run(ctx, repoDir, "gh", "api", fmt.Sprintf("repos/%s/%s/pulls/%s", owner, name, id), "-q", ".head.sha")
	if err != nil {
		return errtrace.Wrap(err)
	}
	sha = strings.TrimSpace(sha)
	if sha == "" {
		return errtrace.Wrap(fmt.Errorf("could not resolve the head commit of PR %s", id))
	}
	_, err = p.run(ctx, repoDir, "gh", "api", "-X", "POST",
		fmt.Sprintf("repos/%s/%s/pulls/%s/comments", owner, name, id),
		"-f", "body="+c.Body,
		"-f", "commit_id="+sha,
		"-f", "path="+c.Path,
		"-F", "line="+strconv.Itoa(c.Line),
		"-f", "side=RIGHT")
	return errtrace.Wrap(err)
}

// ghPRRef is the subset of `gh pr {list,view} --json ...` fields needed to adopt
// a PR (browse it, check out its head, work out where to push back). It is a
// wider projection than ghPR (which is status-only), so it lives separately.
type ghPRRef struct {
	Number              int    `json:"number"`
	URL                 string `json:"url"`
	Title               string `json:"title"`
	State               string `json:"state"`
	IsDraft             bool   `json:"isDraft"`
	HeadRefName         string `json:"headRefName"`
	BaseRefName         string `json:"baseRefName"`
	IsCrossRepository   bool   `json:"isCrossRepository"`
	MaintainerCanModify bool   `json:"maintainerCanModify"`
	Author              struct {
		Login string `json:"login"`
	} `json:"author"`
	HeadRepository struct {
		Name string `json:"name"`
	} `json:"headRepository"`
	HeadRepositoryOwner struct {
		Login string `json:"login"`
	} `json:"headRepositoryOwner"`
}

// ghAdoptFields are the --json fields fetched for adoption. Both `gh pr list` and
// `gh pr view` accept this set (the fields are defined on the PR type). If a gh
// version rejects one ("Unknown JSON field"), `gh pr list --json bogus` prints
// the valid set for that version.
const ghAdoptFields = "number,url,title,state,isDraft,headRefName,baseRefName,isCrossRepository,maintainerCanModify,author,headRepository,headRepositoryOwner"

func (r ghPRRef) toMRRef(basePRURL string) MRRef {
	ref := MRRef{
		ID:           strconv.Itoa(r.Number),
		URL:          r.URL,
		Title:        r.Title,
		Author:       r.Author.Login,
		State:        ghState(r.State, r.IsDraft),
		Draft:        r.IsDraft,
		HeadRef:      r.HeadRefName,
		TargetBranch: r.BaseRefName,
		CrossRepo:    r.IsCrossRepository,
		// Same-repo PRs are always pushable; a fork PR only when the author opted
		// in. We never assume pushable when unsure.
		CanPush: !r.IsCrossRepository || r.MaintainerCanModify,
	}
	if r.IsCrossRepository && r.HeadRepositoryOwner.Login != "" && r.HeadRepository.Name != "" {
		// gh's JSON has no clone URL, so build one from the fork's owner/name on the
		// same host as the PR (handles github.com and GHES). Best-effort: an
		// unparseable host leaves HeadRepoURL empty and the push falls back to the
		// configured remote (which will simply fail for a real fork - surfaced then).
		if host := urlSchemeHost(firstNonEmptyStr(r.URL, basePRURL)); host != "" {
			ref.HeadRepoURL = host + "/" + r.HeadRepositoryOwner.Login + "/" + r.HeadRepository.Name + ".git"
		}
	}
	return ref
}

func (p *githubProvider) ListMRs(ctx context.Context, repoDir, _ string, o ListMROptions) ([]MRRef, error) {
	args := []string{"pr", "list", "--json", ghAdoptFields}
	switch strings.ToLower(o.State) {
	case "", "open":
		args = append(args, "--state", "open")
	case "all":
		args = append(args, "--state", "all")
	case "merged":
		args = append(args, "--state", "merged")
	case "closed":
		args = append(args, "--state", "closed")
	}
	if o.Author != "" {
		args = append(args, "--author", o.Author)
	}
	if o.Search != "" {
		args = append(args, "--search", o.Search)
	}
	if o.Limit > 0 {
		args = append(args, "--limit", strconv.Itoa(o.Limit))
	}
	out, err := p.run(ctx, repoDir, "gh", args...)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	var list []ghPRRef
	if err := json.Unmarshal([]byte(out), &list); err != nil {
		return nil, errtrace.Wrap(err)
	}
	res := make([]MRRef, 0, len(list))
	for _, r := range list {
		res = append(res, r.toMRRef(""))
	}
	return res, nil
}

func (p *githubProvider) GetMR(ctx context.Context, repoDir, _ string, id string) (MRRef, error) {
	out, err := p.run(ctx, repoDir, "gh", "pr", "view", id, "--json", ghAdoptFields)
	if err != nil {
		return MRRef{}, errtrace.Wrap(err)
	}
	var r ghPRRef
	if err := json.Unmarshal([]byte(out), &r); err != nil {
		return MRRef{}, errtrace.Wrap(err)
	}
	return r.toMRRef(""), nil
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
