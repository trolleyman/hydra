package http

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"sort"

	"braces.dev/errtrace"

	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/artifacts"
	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/heads"
	"github.com/trolleyman/hydra/internal/preview"
)

// previewResolution is everything the three preview endpoints share: the
// project, the server-type specs defined at the requested version (name-sorted),
// and the resolved preview version itself.
type previewResolution struct {
	projectRoot string
	specs       []config.ArtifactScript
	version     preview.Version
}

// resolvePreviews resolves a previews request the same way the artifacts/tests
// endpoints resolve their right (head) side: the agent's uncommitted worktree
// when requested, an explicit ref, or the branch tip. Specs are read from the
// version's own .hydra/config.toml (via artifactSpecsByName, sharing its
// enabled/unsafe_host trust gating with the diff pipeline) and filtered to
// type = "server". Returns nil when the agent is unknown.
func (s *Server) resolvePreviews(ctx context.Context, projectID, agentID string, headRef *string, includeUncommitted *bool) (*previewResolution, error) {
	projectRoot, err := s.resolveProjectRoot(projectID)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	head, err := heads.GetHeadByID(ctx, s.Sessions, s.DB, projectRoot, agentID)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	if head == nil {
		return nil, nil
	}

	var av artifacts.Version
	var pv preview.Version
	uncommitted := includeUncommitted != nil && *includeUncommitted
	switch {
	case uncommitted && head.Worktree != nil:
		av = artifacts.Version{WorktreeDir: *head.Worktree}
		pv = preview.Version{HeadID: head.ID, WorktreeDir: *head.Worktree}
	case headRef != nil && *headRef != "":
		// A pinned commit: no Branch, so the slot never follows a moving tip.
		sha, err := git.ResolveRef(projectRoot, *headRef)
		if err != nil {
			return nil, errtrace.Wrap(err)
		}
		av = artifacts.Version{Ref: sha}
		pv = preview.Version{HeadID: head.ID, SHA: sha}
	default:
		// "Latest commit" = the head's branch tip. Carry the branch so the slot
		// rebuilds and hot-swaps in the background as the tip advances.
		if head.Branch == nil {
			return nil, nil
		}
		sha, err := git.ResolveRef(projectRoot, *head.Branch)
		if err != nil {
			return nil, errtrace.Wrap(err)
		}
		av = artifacts.Version{Ref: sha}
		pv = preview.Version{HeadID: head.ID, SHA: sha, Branch: *head.Branch}
	}

	liveCfg, err := config.Load(projectRoot)
	if err != nil {
		return &previewResolution{projectRoot: projectRoot, version: pv}, nil //nolint:nilerr // no config -> no previews
	}
	byName, err := artifactSpecsByName(projectRoot, av, liveCfg)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	disabled := disabledArtifacts(liveCfg)
	specs := make([]config.ArtifactScript, 0, len(byName))
	for name, spec := range byName {
		if spec.IsServer() && !disabled[name] {
			specs = append(specs, spec)
		}
	}
	sort.Slice(specs, func(i, j int) bool { return specs[i].Name < specs[j].Name })
	return &previewResolution{projectRoot: projectRoot, specs: specs, version: pv}, nil
}

// previewURL builds the absolute URL of a preview instance from the API
// request's Host header (so it is correct for both local and remote browsers)
// and the instance's proxy port. Preview listeners are plain HTTP.
func previewURL(ctx context.Context, port int) *string {
	if port == 0 {
		return nil
	}
	host := "localhost"
	if r := requestFromContext(ctx); r != nil && r.Host != "" {
		host = r.Host
		if h, _, err := net.SplitHostPort(r.Host); err == nil {
			host = h
		}
	}
	u := fmt.Sprintf("http://%s/", net.JoinHostPort(host, fmt.Sprintf("%d", port)))
	return &u
}

// toAPIPreviewStatus folds an instance snapshot into the API shape.
func toAPIPreviewStatus(ctx context.Context, st preview.Status) api.PreviewStatus {
	out := api.PreviewStatus{
		Name:    st.Name,
		State:   api.PreviewState(st.State),
		Version: st.Version,
		Url:     previewURL(ctx, st.Port),
	}
	if st.Pid != 0 {
		out.Pid = &st.Pid
	}
	if st.Inflight != 0 {
		out.Connections = &st.Inflight
	}
	if !st.StartedAt.IsZero() && st.State != preview.StateStopped {
		t := st.StartedAt
		out.StartedAt = &t
	}
	if st.Progress != "" {
		out.Progress = &st.Progress
	}
	if st.Message != "" {
		out.Message = &st.Message
	}
	if len(st.Log) > 0 {
		lines := make([]api.ArtifactLogLine, 0, len(st.Log))
		for _, l := range st.Log {
			lines = append(lines, api.ArtifactLogLine{Text: l.Text, Stream: api.ArtifactLogLineStream(l.Stream)})
		}
		out.Log = &lines
	}
	return out
}

// previewNotFound is the shared 404 payload shape for the preview endpoints.
func previewNotFound(details string) api.ErrorResponse {
	return api.ErrorResponse{Code: 404, Error: api.ErrorResponseErrorNotFound, Details: details}
}

// GetAgentPreviews lists the server-type scripts at the requested version with
// their instance status, plus still-live instances at other versions. Purely a
// read - nothing spawns here.
func (s *Server) GetAgentPreviews(ctx context.Context, request api.GetAgentPreviewsRequestObject) (api.GetAgentPreviewsResponseObject, error) {
	res, err := s.resolvePreviews(ctx, request.ProjectId, request.Id, request.Params.HeadRef, request.Params.IncludeUncommitted)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	if res == nil {
		return api.GetAgentPreviews404JSONResponse(previewNotFound("agent not found")), nil
	}

	previews := make([]api.PreviewStatus, 0, len(res.specs))
	for _, spec := range res.specs {
		var st preview.Status
		if s.Previews != nil {
			st = s.Previews.Peek(res.projectRoot, spec, res.version)
		} else {
			st = preview.Status{Name: spec.Name, State: preview.StateStopped, Version: res.version.Label()}
		}
		previews = append(previews, toAPIPreviewStatus(ctx, st))
	}
	return api.GetAgentPreviews200JSONResponse(api.PreviewsResponse{Previews: previews}), nil
}

// StartAgentPreview ensures the named preview instance exists (listener + port)
// and spawns its server if not already running, returning the URL to open.
func (s *Server) StartAgentPreview(ctx context.Context, request api.StartAgentPreviewRequestObject) (api.StartAgentPreviewResponseObject, error) {
	if s.Previews == nil {
		return api.StartAgentPreview404JSONResponse(previewNotFound("previews disabled")), nil
	}
	res, err := s.resolvePreviews(ctx, request.ProjectId, request.Id, request.Params.HeadRef, request.Params.IncludeUncommitted)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	if res == nil {
		return api.StartAgentPreview404JSONResponse(previewNotFound("agent not found")), nil
	}
	for _, spec := range res.specs {
		if spec.Name != request.Name {
			continue
		}
		st, err := s.Previews.Ensure(res.projectRoot, spec, res.version)
		if err != nil {
			return nil, errtrace.Wrap(err)
		}
		return api.StartAgentPreview200JSONResponse(toAPIPreviewStatus(ctx, st)), nil
	}
	return api.StartAgentPreview404JSONResponse(previewNotFound("preview script not found: " + request.Name)), nil
}

// StopAgentPreview tears down the named preview's server process for the
// requested version; the listener persists for a later respawn.
func (s *Server) StopAgentPreview(ctx context.Context, request api.StopAgentPreviewRequestObject) (api.StopAgentPreviewResponseObject, error) {
	if s.Previews == nil {
		return api.StopAgentPreview404JSONResponse(previewNotFound("previews disabled")), nil
	}
	res, err := s.resolvePreviews(ctx, request.ProjectId, request.Id, request.Params.HeadRef, request.Params.IncludeUncommitted)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	if res == nil {
		return api.StopAgentPreview404JSONResponse(previewNotFound("agent not found")), nil
	}
	s.Previews.Stop(res.projectRoot, request.Name, res.version)
	return api.StopAgentPreview204Response{}, nil
}

// stopHeadPreviews tears down a head's live-worktree preview instances before
// its worktree is removed (kill/merge/restart/purge). Nil-safe; the preview
// reaper's worktree-gone sweep is the backstop for teardown paths that don't
// come through these handlers (e.g. the CLI).
func (s *Server) stopHeadPreviews(projectRoot, headID string) {
	if s.Previews != nil {
		s.Previews.StopHead(projectRoot, headID)
	}
}

// requestCtxKey keys the *http.Request injected into every strict handler's
// context (see NewHandler), used where a handler needs request metadata the
// generated signatures don't carry (e.g. the Host header for preview URLs).
type requestCtxKey struct{}

// requestFromContext returns the originating *http.Request, or nil (in-process
// callers, tests).
func requestFromContext(ctx context.Context) *http.Request {
	r, _ := ctx.Value(requestCtxKey{}).(*http.Request)
	return r
}
