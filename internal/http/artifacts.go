package http

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/artifacts"
	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/heads"
)

// GetAgentArtifacts runs (or returns cached) artifact scripts for both sides of
// the requested comparison and reports, per script, which files differ.
func (s *Server) GetAgentArtifacts(ctx context.Context, request api.GetAgentArtifactsRequestObject) (api.GetAgentArtifactsResponseObject, error) {
	projectRoot, err := s.resolveProjectRoot(request.ProjectId)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	head, err := heads.GetHeadByID(ctx, s.Sessions, s.DB, projectRoot, request.Id)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	if head == nil {
		return api.GetAgentArtifacts404JSONResponse{
			Code:    404,
			Error:   api.ErrorResponseErrorNotFound,
			Details: "agent not found",
		}, nil
	}

	empty := api.ArtifactsResponse{Scripts: []api.ArtifactSet{}}
	if s.Artifacts == nil {
		return api.GetAgentArtifacts200JSONResponse(empty), nil
	}
	mgr := s.Artifacts.Manager(projectRoot)

	cfg, err := config.Load(projectRoot)
	if err != nil || len(cfg.Artifacts) == 0 || head.Branch == nil {
		return api.GetAgentArtifacts200JSONResponse(empty), nil
	}

	// Left version: a committed ref. When no explicit base ref is requested we
	// baseline against the *merge-base* (fork point) of the base branch and the
	// head branch — NOT the base branch tip. This mirrors the triple-dot diff used
	// for code (see GetAgentDiff) so artifacts reflect only the branch's own
	// changes. Otherwise commits landed on the base branch after the fork would
	// regenerate the "before" artifact from newer state, producing spurious
	// before/after differences (e.g. a screenshot's clock) unrelated to the work.
	leftRef := head.BaseBranch
	if request.Params.BaseRef != nil && *request.Params.BaseRef != "" {
		leftRef = *request.Params.BaseRef
	} else if mb, err := git.GetMergeBase(projectRoot, head.BaseBranch, *head.Branch); err == nil && mb != "" {
		leftRef = mb
	}
	left := artifacts.Version{Ref: leftRef}

	// Right version: uncommitted working tree, an explicit ref, or the branch tip.
	var right artifacts.Version
	includeUncommitted := request.Params.IncludeUncommitted != nil && *request.Params.IncludeUncommitted
	switch {
	case includeUncommitted && head.Worktree != nil:
		right = artifacts.Version{WorktreeDir: *head.Worktree}
	case request.Params.HeadRef != nil && *request.Params.HeadRef != "":
		right = artifacts.Version{Ref: *request.Params.HeadRef}
	default:
		right = artifacts.Version{Ref: *head.Branch}
	}

	sets := make([]api.ArtifactSet, 0, len(cfg.Artifacts))
	for _, spec := range cfg.Artifacts {
		if spec.Name == "" || spec.Command == "" {
			continue
		}
		sets = append(sets, s.buildArtifactSet(request.ProjectId, spec, mgr, left, right))
	}

	return api.GetAgentArtifacts200JSONResponse(api.ArtifactsResponse{Scripts: sets}), nil
}

// buildArtifactSet generates/loads both sides for one script and folds them
// into the API representation.
func (s *Server) buildArtifactSet(projectID string, spec config.ArtifactScript, mgr *artifacts.Manager, left, right artifacts.Version) api.ArtifactSet {
	set := api.ArtifactSet{Name: spec.Name, Files: []api.ArtifactFile{}}

	leftMeta, lerr := mgr.Get(spec, left)
	rightMeta, rerr := mgr.Get(spec, right)
	if lerr != nil || rerr != nil {
		set.Status = api.Error
		msg := joinErrs(lerr, rerr)
		set.Error = &msg
		return set
	}

	// Overall status: generating dominates, then error, else ready.
	switch {
	case leftMeta.Status == artifacts.StatusGenerating || rightMeta.Status == artifacts.StatusGenerating:
		set.Status = api.Generating
		return set
	case leftMeta.Status == artifacts.StatusError || rightMeta.Status == artifacts.StatusError:
		set.Status = api.Error
		msg := joinMetaErrs(leftMeta, rightMeta)
		set.Error = &msg
		return set
	default:
		set.Status = api.Ready
	}

	deltas := mgr.Compare(leftMeta, rightMeta)
	set.Changed = artifacts.AnyChanged(deltas)
	for _, d := range deltas {
		f := api.ArtifactFile{Name: d.Name, ChangeType: api.ArtifactFileChangeType(d.Change)}
		if d.InLeft {
			f.LeftUrl = ptr(blobURL(projectID, spec.Name, leftMeta.Key, d.Name))
		}
		if d.InRight {
			f.RightUrl = ptr(blobURL(projectID, spec.Name, rightMeta.Key, d.Name))
		}
		set.Files = append(set.Files, f)
	}
	return set
}

// blobURL builds the (same-origin) URL the frontend fetches an artifact file from.
func blobURL(projectID, script, key, file string) string {
	q := url.Values{}
	q.Set("script", script)
	q.Set("key", key)
	q.Set("file", file)
	return fmt.Sprintf("/artifacts/projects/%s/blob?%s", url.PathEscape(projectID), q.Encode())
}

// HandleArtifactBlob serves a single generated artifact file. It is registered
// outside the OpenAPI mux because it returns raw image bytes, not JSON.
func (s *Server) HandleArtifactBlob(w http.ResponseWriter, r *http.Request) {
	projectID := r.PathValue("project_id")
	projectRoot, err := s.resolveProjectRoot(projectID)
	if err != nil || s.Artifacts == nil {
		http.NotFound(w, r)
		return
	}

	q := r.URL.Query()
	mgr := s.Artifacts.Manager(projectRoot)
	path, contentType, err := mgr.BlobPath(q.Get("script"), q.Get("key"), q.Get("file"))
	if err != nil {
		http.Error(w, "invalid artifact request", http.StatusBadRequest)
		return
	}
	f, err := os.Open(path)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || info.IsDir() {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "public, max-age=300")
	http.ServeContent(w, r, filepath.Base(path), info.ModTime(), f)
}

func joinErrs(a, b error) string {
	switch {
	case a != nil && b != nil:
		return a.Error() + "; " + b.Error()
	case a != nil:
		return a.Error()
	case b != nil:
		return b.Error()
	}
	return ""
}

func joinMetaErrs(a, b artifacts.Meta) string {
	var parts []string
	if a.Status == artifacts.StatusError && a.Error != "" {
		parts = append(parts, "left: "+a.Error)
	}
	if b.Status == artifacts.StatusError && b.Error != "" {
		parts = append(parts, "right: "+b.Error)
	}
	if len(parts) == 0 {
		return "generation failed"
	}
	out := parts[0]
	for _, p := range parts[1:] {
		out += "; " + p
	}
	return out
}
