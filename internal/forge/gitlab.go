package forge

import (
	"context"
	"encoding/json"
	"errors"
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
	IID                       int    `json:"iid"`
	WebURL                    string `json:"web_url"`
	State                     string `json:"state"` // opened | merged | closed | locked
	Draft                     bool   `json:"draft"`
	WorkInProgress            bool   `json:"work_in_progress"`
	MergeStatus               string `json:"merge_status"` // can_be_merged | cannot_be_merged | ...
	DetailedMergeStatus       string `json:"detailed_merge_status"`
	HasConflicts              bool   `json:"has_conflicts"`
	BlockingDiscussionsResolved bool `json:"blocking_discussions_resolved"`
	UserNotesCount            int    `json:"user_notes_count"`
	Upvotes                   int    `json:"upvotes"`
	Pipeline                  *struct {
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

// glabDiscussion mirrors the GitLab discussions API shape.
type glabDiscussion struct {
	ID    string `json:"id"`
	Notes []struct {
		ID       int    `json:"id"`
		Body     string `json:"body"`
		System   bool   `json:"system"`
		Resolved bool   `json:"resolved"`
		Author   struct {
			Username string `json:"username"`
		} `json:"author"`
		Position *struct {
			NewPath string `json:"new_path"`
			NewLine int    `json:"new_line"`
		} `json:"position"`
	} `json:"notes"`
}

func (p *gitlabProvider) Discussions(ctx context.Context, repoDir, _ string, id string) ([]Discussion, error) {
	// glab api hits the GitLab REST API with glab's auth. CURRENT_PROJECT is a glab
	// placeholder for the resolved project path.
	out, err := p.run(ctx, repoDir, "glab", "api", "projects/:id/merge_requests/"+id+"/discussions", "--paginate")
	if err != nil {
		// Fall back gracefully: no discussions rather than a hard error.
		return nil, errtrace.Wrap(err)
	}
	var discussions []glabDiscussion
	if err := json.Unmarshal([]byte(strings.TrimSpace(out)), &discussions); err != nil {
		return nil, errtrace.Wrap(err)
	}
	var res []Discussion
	for _, d := range discussions {
		for _, n := range d.Notes {
			if n.System || n.Resolved {
				continue // skip system notes and already-resolved threads
			}
			disc := Discussion{
				ID:     d.ID,
				Author: n.Author.Username,
				Body:   n.Body,
			}
			if n.Position != nil {
				disc.Path = n.Position.NewPath
				disc.Line = n.Position.NewLine
			}
			res = append(res, disc)
		}
	}
	return res, nil
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
