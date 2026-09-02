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

// gitlabProvider implements Provider by shelling out to the `glab` CLI. glab
// auto-detects the project from the checkout's remotes and handles self-hosted
// hosts via its multi-host config.
type gitlabProvider struct{ run runner }

func (p *gitlabProvider) Name() string { return ProviderGitLab }

// glabMR is the subset of `glab mr view -F json` output we read. GitLab's API is
// the source, so field names are snake_case.
type glabMR struct {
	IID                         int    `json:"iid"`
	WebURL                      string `json:"web_url"`
	State                       string `json:"state"` // opened | merged | closed | locked
	Draft                       bool   `json:"draft"`
	WorkInProgress              bool   `json:"work_in_progress"`
	MergeStatus                 string `json:"merge_status"` // can_be_merged | cannot_be_merged | ...
	DetailedMergeStatus         string `json:"detailed_merge_status"`
	HasConflicts                bool   `json:"has_conflicts"`
	BlockingDiscussionsResolved bool   `json:"blocking_discussions_resolved"`
	UserNotesCount              int    `json:"user_notes_count"`
	Upvotes                     int    `json:"upvotes"`
	Pipeline                    *struct {
		Status string `json:"status"` // success | failed | running | pending | canceled
	} `json:"pipeline"`
	HeadPipeline *struct {
		Status string `json:"status"`
	} `json:"head_pipeline"`
}

func (p *gitlabProvider) EnsureMR(ctx context.Context, o EnsureMROptions) (MR, error) {
	if mr, ok, err := p.findBySource(ctx, o.RepoDir, o.SourceBranch); err != nil {
		return MR{}, errtrace.Wrap(err)
	} else if ok {
		return MR{ID: strconv.Itoa(mr.IID), URL: mr.WebURL}, nil
	}
	args := []string{"mr", "create",
		"--source-branch", o.SourceBranch,
		"--target-branch", o.TargetBranch,
		"--title", o.Title,
		"--description", o.Description,
		"--yes", // non-interactive
	}
	if o.Draft {
		args = append(args, "--draft")
	}
	if o.Squash {
		args = append(args, "--squash-before-merge")
	}
	if o.RemoveSourceBranch {
		args = append(args, "--remove-source-branch")
	}
	out, err := p.run(ctx, o.RepoDir, "glab", args...)
	if err != nil {
		return MR{}, errtrace.Wrap(err)
	}
	// glab prints the MR URL; re-query for the IID.
	if mr, ok, err2 := p.findBySource(ctx, o.RepoDir, o.SourceBranch); err2 == nil && ok {
		return MR{ID: strconv.Itoa(mr.IID), URL: mr.WebURL}, nil
	}
	return MR{URL: firstMRURL(out)}, nil
}

// findBySource finds an open MR by its source branch. Not found is (false, nil).
func (p *gitlabProvider) findBySource(ctx context.Context, dir, branch string) (glabMR, bool, error) {
	out, err := p.run(ctx, dir, "glab", "mr", "list", "--source-branch", branch, "-F", "json")
	if err != nil {
		return glabMR{}, false, errtrace.Wrap(err)
	}
	var list []glabMR
	if err := json.Unmarshal([]byte(strings.TrimSpace(out)), &list); err != nil {
		return glabMR{}, false, errtrace.Wrap(err)
	}
	if len(list) == 0 {
		return glabMR{}, false, nil
	}
	return list[0], true, nil
}

func (p *gitlabProvider) Status(ctx context.Context, repoDir, _ string, id string) (Status, error) {
	out, err := p.run(ctx, repoDir, "glab", "mr", "view", id, "-F", "json")
	if err != nil {
		return Status{}, errtrace.Wrap(err)
	}
	var mr glabMR
	if err := json.Unmarshal([]byte(strings.TrimSpace(out)), &mr); err != nil {
		return Status{}, errtrace.Wrap(err)
	}
	return mr.toStatus(), nil
}

func (mr glabMR) toStatus() Status {
	st := Status{
		ID:        strconv.Itoa(mr.IID),
		URL:       mr.WebURL,
		State:     glabState(mr.State, mr.Draft || mr.WorkInProgress),
		CIStatus:  glabCIStatus(mr.pipelineStatus()),
		Approvals: mr.Upvotes,
		Mergeable: mr.MergeStatus == "can_be_merged" || mr.DetailedMergeStatus == "mergeable",
	}
	// GitLab reports whether blocking discussions are resolved rather than a count;
	// surface at least one unresolved when they are not (the exact count comes from
	// Discussions()).
	if !mr.BlockingDiscussionsResolved {
		st.UnresolvedDiscussions = 1
	}
	return st
}

func (mr glabMR) pipelineStatus() string {
	if mr.HeadPipeline != nil {
		return mr.HeadPipeline.Status
	}
	if mr.Pipeline != nil {
		return mr.Pipeline.Status
	}
	return ""
}

// glabState maps GitLab's MR state to the normalized state.
func glabState(state string, draft bool) string {
	switch strings.ToLower(state) {
	case "merged":
		return StateMerged
	case "closed", "locked":
		return StateClosed
	default:
		if draft {
			return StateDraft
		}
		return StateOpen
	}
}

// glabCIStatus maps a GitLab pipeline status to the normalized CI status.
func glabCIStatus(status string) string {
	switch strings.ToLower(status) {
	case "":
		return CINone
	case "success":
		return CISuccess
	case "failed":
		return CIFailed
	case "running":
		return CIRunning
	case "pending", "created", "scheduled", "preparing", "waiting_for_resource", "manual":
		return CIPending
	case "canceled", "skipped":
		return CINone
	default:
		return CIPending
	}
}

func (p *gitlabProvider) Merge(ctx context.Context, repoDir, _ string, id string, o MergeOptions) error {
	args := []string{"mr", "merge", id, "--yes"}
	if o.Squash {
		args = append(args, "--squash")
	}
	if o.RemoveSourceBranch {
		args = append(args, "--remove-source-branch")
	}
	if o.Auto {
		// Delegate to GitLab's merge-when-pipeline-succeeds (respects merge trains).
		args = append(args, "--when-pipeline-succeeds")
	}
	_, err := p.run(ctx, repoDir, "glab", args...)
	return errtrace.Wrap(err)
}

func (p *gitlabProvider) Close(ctx context.Context, repoDir, _ string, id string) error {
	_, err := p.run(ctx, repoDir, "glab", "mr", "close", id)
	return errtrace.Wrap(err)
}

// glabDiscussion mirrors the GitLab discussions API shape. A discussion IS the
// thread; its notes carry the position (file/line) and resolution state.
type glabDiscussion struct {
	ID    string     `json:"id"`
	Notes []glabNote `json:"notes"`
}

type glabNote struct {
	ID        int    `json:"id"`
	Body      string `json:"body"`
	System    bool   `json:"system"`
	Resolved  bool   `json:"resolved"`
	CreatedAt string `json:"created_at"`
	Author    struct {
		Username  string `json:"username"`
		AvatarURL string `json:"avatar_url"`
	} `json:"author"`
	Position *struct {
		NewPath   string `json:"new_path"`
		NewLine   int    `json:"new_line"`
		LineRange *struct {
			Start struct {
				NewLine int `json:"new_line"`
			} `json:"start"`
			End struct {
				NewLine int `json:"new_line"`
			} `json:"end"`
		} `json:"line_range"`
	} `json:"position"`
	Suggestions []struct {
		ID          int    `json:"id"`
		FromLine    int    `json:"from_line"`
		ToLine      int    `json:"to_line"`
		Appliable   bool   `json:"appliable"`
		Applied     bool   `json:"applied"`
		FromContent string `json:"from_content"`
		ToContent   string `json:"to_content"`
	} `json:"suggestions"`
}

func (p *gitlabProvider) Threads(ctx context.Context, repoDir, _ string, id string) ([]Thread, error) {
	// glab api hits the GitLab REST API with glab's auth. :id is a glab
	// placeholder for the resolved project path.
	out, err := p.run(ctx, repoDir, "glab", "api", "projects/:id/merge_requests/"+id+"/discussions", "--paginate")
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	var discussions []glabDiscussion
	if err := json.Unmarshal([]byte(strings.TrimSpace(out)), &discussions); err != nil {
		return nil, errtrace.Wrap(err)
	}
	webURL := p.mrWebURL(ctx, repoDir, id)
	threads := make([]Thread, 0, len(discussions))
	for _, d := range discussions {
		t := Thread{ID: d.ID}
		for _, n := range d.Notes {
			if n.System {
				continue // "changed the description", "added 1 commit", ... - not a conversation
			}
			// Resolution is per-note on GitLab but is really a thread property; any
			// resolved note means the thread is resolved.
			if n.Resolved {
				t.Resolved = true
			}
			if n.Position != nil && t.Path == "" {
				t.Path, t.Line = n.Position.NewPath, n.Position.NewLine
				if n.Position.LineRange != nil {
					t.StartLine = n.Position.LineRange.Start.NewLine
					t.Line = n.Position.LineRange.End.NewLine
				}
			}
			note := Note{
				ID: strconv.Itoa(n.ID), Author: n.Author.Username, AvatarURL: n.Author.AvatarURL,
				Body: n.Body, CreatedAt: n.CreatedAt,
			}
			if len(n.Suggestions) == 1 {
				s := n.Suggestions[0]
				note.Suggestion = &Suggestion{
					FromLine: s.FromLine, ToLine: s.ToLine, FromContent: s.FromContent,
					ToContent: s.ToContent, Appliable: s.Appliable, Applied: s.Applied,
				}
			}
			if webURL != "" {
				note.URL = webURL + "#note_" + note.ID
			}
			t.Notes = append(t.Notes, note)
		}
		if len(t.Notes) == 0 {
			continue // a purely system discussion
		}
		t.URL = t.Notes[0].URL
		threads = append(threads, t)
	}
	return threads, nil
}

// mrWebURL resolves the MR's web URL so notes can carry deep links. Best-effort:
// an error just means notes render without a link.
func (p *gitlabProvider) mrWebURL(ctx context.Context, repoDir, id string) string {
	out, err := p.run(ctx, repoDir, "glab", "api", "projects/:id/merge_requests/"+id)
	if err != nil {
		return ""
	}
	var mr struct {
		WebURL string `json:"web_url"`
	}
	if json.Unmarshal([]byte(strings.TrimSpace(out)), &mr) != nil {
		return ""
	}
	return mr.WebURL
}

func (p *gitlabProvider) ReplyToThread(ctx context.Context, repoDir, _ string, id, threadID, body string) error {
	if strings.TrimSpace(body) == "" {
		return errtrace.Wrap(errors.New("reply body is empty"))
	}
	_, err := p.run(ctx, repoDir, "glab", "api", "-X", "POST",
		"projects/:id/merge_requests/"+id+"/discussions/"+threadID+"/notes",
		"-f", "body="+body)
	return errtrace.Wrap(err)
}

func (p *gitlabProvider) CommentOnLine(ctx context.Context, repoDir, _ string, id string, c NewLineComment) error {
	if strings.TrimSpace(c.Body) == "" {
		return errtrace.Wrap(errors.New("comment body is empty"))
	}
	// A positioned discussion needs the MR's three diff refs; GitLab rejects a
	// position without them, so they are read fresh rather than cached.
	out, err := p.run(ctx, repoDir, "glab", "api", "projects/:id/merge_requests/"+id)
	if err != nil {
		return errtrace.Wrap(err)
	}
	var mr struct {
		DiffRefs struct {
			BaseSha  string `json:"base_sha"`
			StartSha string `json:"start_sha"`
			HeadSha  string `json:"head_sha"`
		} `json:"diff_refs"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(out)), &mr); err != nil {
		return errtrace.Wrap(err)
	}
	if mr.DiffRefs.HeadSha == "" {
		return errtrace.Wrap(fmt.Errorf("could not resolve the diff refs of MR %s", id))
	}
	_, err = p.run(ctx, repoDir, "glab", "api", "-X", "POST",
		"projects/:id/merge_requests/"+id+"/discussions",
		"-f", "body="+c.Body,
		"-f", "position[position_type]=text",
		"-f", "position[base_sha]="+mr.DiffRefs.BaseSha,
		"-f", "position[start_sha]="+mr.DiffRefs.StartSha,
		"-f", "position[head_sha]="+mr.DiffRefs.HeadSha,
		"-f", "position[new_path]="+c.Path,
		"-f", "position[old_path]="+c.Path,
		"-F", "position[new_line]="+strconv.Itoa(c.Line))
	return errtrace.Wrap(err)
}

// glabMRRef is the subset of `glab mr {list,view} -F json` fields needed to
// adopt an MR. GitLab MR JSON is snake_case.
type glabMRRef struct {
	IID                int    `json:"iid"`
	WebURL             string `json:"web_url"`
	Title              string `json:"title"`
	State              string `json:"state"`
	Draft              bool   `json:"draft"`
	WorkInProgress     bool   `json:"work_in_progress"`
	SourceBranch       string `json:"source_branch"`
	TargetBranch       string `json:"target_branch"`
	AllowCollaboration bool   `json:"allow_collaboration"`
	SourceProjectID    int    `json:"source_project_id"`
	TargetProjectID    int    `json:"target_project_id"`
	Author             struct {
		Username string `json:"username"`
	} `json:"author"`
}

func (r glabMRRef) toMRRef() MRRef {
	cross := r.SourceProjectID != 0 && r.TargetProjectID != 0 && r.SourceProjectID != r.TargetProjectID
	return MRRef{
		ID:           strconv.Itoa(r.IID),
		URL:          r.WebURL,
		Title:        r.Title,
		Author:       r.Author.Username,
		State:        glabState(r.State, r.Draft || r.WorkInProgress),
		Draft:        r.Draft || r.WorkInProgress,
		HeadRef:      r.SourceBranch,
		TargetBranch: r.TargetBranch,
		CrossRepo:    cross,
		CanPush:      !cross || r.AllowCollaboration,
	}
}

func (p *gitlabProvider) ListMRs(ctx context.Context, repoDir, _ string, o ListMROptions) ([]MRRef, error) {
	args := []string{"mr", "list", "-F", "json"}
	switch strings.ToLower(o.State) {
	case "", "open":
		args = append(args, "--opened")
	case "all":
		args = append(args, "--all")
	case "merged":
		args = append(args, "--merged")
	case "closed":
		args = append(args, "--closed")
	}
	if o.Author == "@me" {
		args = append(args, "--mine")
	}
	if o.Search != "" {
		args = append(args, "--search", o.Search)
	}
	if o.Limit > 0 {
		args = append(args, "--per-page", strconv.Itoa(o.Limit))
	}
	out, err := p.run(ctx, repoDir, "glab", args...)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	var list []glabMRRef
	if err := json.Unmarshal([]byte(strings.TrimSpace(out)), &list); err != nil {
		return nil, errtrace.Wrap(err)
	}
	res := make([]MRRef, 0, len(list))
	for _, r := range list {
		res = append(res, r.toMRRef())
	}
	return res, nil
}

func (p *gitlabProvider) GetMR(ctx context.Context, repoDir, _ string, id string) (MRRef, error) {
	out, err := p.run(ctx, repoDir, "glab", "mr", "view", id, "-F", "json")
	if err != nil {
		return MRRef{}, errtrace.Wrap(err)
	}
	var r glabMRRef
	if err := json.Unmarshal([]byte(strings.TrimSpace(out)), &r); err != nil {
		return MRRef{}, errtrace.Wrap(err)
	}
	ref := r.toMRRef()
	// A fork MR's source project has its own clone URL, which the MR JSON does not
	// carry. Resolve it with one extra API call. Best-effort: on failure the push
	// path falls back to the configured remote (and fails loudly for a real fork).
	if ref.CrossRepo && r.SourceProjectID != 0 {
		if cloneURL := p.projectCloneURL(ctx, repoDir, r.SourceProjectID); cloneURL != "" {
			ref.HeadRepoURL = cloneURL
		}
	}
	return ref, nil
}

// projectCloneURL resolves a GitLab project id to its HTTP clone URL via the API.
func (p *gitlabProvider) projectCloneURL(ctx context.Context, repoDir string, projectID int) string {
	out, err := p.run(ctx, repoDir, "glab", "api", "projects/"+strconv.Itoa(projectID))
	if err != nil {
		return ""
	}
	var proj struct {
		HTTPURLToRepo string `json:"http_url_to_repo"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(out)), &proj); err != nil {
		return ""
	}
	return proj.HTTPURLToRepo
}

// glabAuthStatus reports glab login state via `glab auth status`.
func glabAuthStatus(ctx context.Context) (bool, string, error) {
	if !cliAvailable("glab") {
		return false, "glab not installed", nil
	}
	out, err := execRunner(ctx, "", "glab", "auth", "status")
	if err != nil {
		var cliErr *CLIError
		if errors.As(err, &cliErr) {
			return false, firstNonEmptyLine(cliErr.Stderr), nil
		}
		return false, "not authenticated", nil
	}
	return true, firstNonEmptyLine(out), nil
}

// firstMRURL returns the first https URL found in glab's create output.
func firstMRURL(s string) string {
	for _, f := range strings.Fields(s) {
		if strings.HasPrefix(f, "https://") {
			return f
		}
	}
	return strings.TrimSpace(lastLine(s))
}
