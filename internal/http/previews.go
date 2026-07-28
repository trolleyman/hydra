package http

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"sort"

	"braces.dev/errtrace"

	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/heads"
	"github.com/trolleyman/hydra/internal/preview"
)

// previewResolution is everything the three preview endpoints share: the
// project, the [previews.<name>] specs defined at the requested version
// (name-sorted), and the resolved preview version itself.
type previewResolution struct {
	projectRoot string
	specs       []config.PreviewScript
	version     preview.Version
}

// previewSpecsByName loads the preview scripts that apply at one version and
// indexes them by name - artifactSpecsByName's twin for [previews.<name>], and
// it makes the same trade: the version's own
// .hydra/config.toml decides which previews exist - so a branch adding one gets
// it on that branch - while the live config keeps the two human-controlled
// vetoes. Specs with an empty name or command are dropped; on a duplicate name
// the first definition wins.
//
// Security: a version's config is attacker-controllable, so unsafe_host is
// honored only when the trusted live config authorizes that exact name+command
// under the SAME kind of script (see hostKey); otherwise the command is forced
// back into the sandbox. A preview authorized as a host command is strictly more
// dangerous than an artifact one - it is resident, not one-shot - which is
// exactly why the key is kind-scoped and a media artifact's authorization can
// never be spent on a preview.
func previewSpecsByName(projectRoot string, worktreeDir, ref string, liveCfg config.Config) (map[string]config.PreviewScript, error) {
	content, err := configTOMLAtVersion(projectRoot, worktreeDir, ref)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	specs, err := config.PreviewsAtProjectTOML(content)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}

	trustedHost := trustedHostPreviews(liveCfg)
	byName := make(map[string]config.PreviewScript, len(specs))
	for _, spec := range specs {
		if spec.Name == "" || spec.Script == "" {
			continue
		}
		if _, dup := byName[spec.Name]; dup {
			continue
		}
		if spec.UnsafeHost && !trustedHost[hostKey(spec.Name, spec.Script, hostKindPreview)] {
			spec.UnsafeHost = false
		}
		byName[spec.Name] = spec
	}
	return byName, nil
}

// trustedHostPreviews is trustedHostCommands for [previews.<name>]: the set of
// name+command pairs the live config authorizes to run unconfined on the host.
func trustedHostPreviews(cfg config.Config) map[string]bool {
	trusted := map[string]bool{}
	for _, p := range cfg.Previews {
		if p.UnsafeHost && p.Name != "" && p.Script != "" {
			trusted[hostKey(p.Name, p.Script, hostKindPreview)] = true
		}
	}
	return trusted
}

// disabledPreviews returns the set of preview names the live config marks
// enabled = false. The live config is human-controlled, so it - not a previewed
// ref's config - decides whether a preview is offered. Mirrors disabledArtifacts.
func disabledPreviews(cfg config.Config) map[string]bool {
	disabled := map[string]bool{}
	for _, p := range cfg.Previews {
		if p.Name != "" && !p.IsEnabled() {
			disabled[p.Name] = true
		}
	}
	return disabled
}

// resolvePreviews resolves a previews request the same way the artifacts/tests
// endpoints resolve their right (head) side: the agent's uncommitted worktree
// when requested, an explicit ref, or the branch tip. Returns nil when the agent
// is unknown.
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

	// Where the [previews.<name>] tables are read from: a live worktree's own
	// file, or the config at the resolved commit.
	var srcWorktree, srcRef string
	var pv preview.Version
	uncommitted := includeUncommitted != nil && *includeUncommitted
	switch {
	case uncommitted && head.Worktree != nil:
		srcWorktree = *head.Worktree
		pv = preview.Version{HeadID: head.ID, WorktreeDir: *head.Worktree}
	case headRef != nil && *headRef != "":
		// A pinned commit: no Branch, so the slot never follows a moving tip.
		sha, err := git.ResolveRef(projectRoot, *headRef)
		if err != nil {
			return nil, errtrace.Wrap(err)
		}
		srcRef = sha
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
		srcRef = sha
		pv = preview.Version{HeadID: head.ID, SHA: sha, Branch: *head.Branch}
	}

	liveCfg, err := config.Load(projectRoot)
	if err != nil {
		return &previewResolution{projectRoot: projectRoot, version: pv}, nil //nolint:nilerr // no config -> no previews
	}
	byName, err := previewSpecsByName(projectRoot, srcWorktree, srcRef, liveCfg)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	disabled := disabledPreviews(liveCfg)
	specs := make([]config.PreviewScript, 0, len(byName))
	for name, spec := range byName {
		if !disabled[name] {
			specs = append(specs, spec)
		}
	}
	sort.Slice(specs, func(i, j int) bool { return specs[i].Name < specs[j].Name })
	return &previewResolution{projectRoot: projectRoot, specs: specs, version: pv}, nil
}

// previewURL builds the URL of a preview instance from the API request's Host
// header (so it is correct for both local and remote browsers) and the
// instance's proxy port.
//
// The URL is deliberately PROTOCOL-RELATIVE ("//host:port/"): the preview
// listener is plain HTTP, but the browser resolves the scheme from the page it
// runs in. Served locally over http the link stays http; fronted by a TLS
// terminator (Tailscale serve, a reverse proxy) the Hydra page is https, so the
// link becomes https too - which both avoids the browser blocking an http
// preview embedded in an https page as mixed content, and keeps the preview
// inside the same secure context. It does mean the front must also expose the
// preview port over TLS (see docs/remote-access.md); the scheme just follows
// the page rather than lying about it.
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
	u := fmt.Sprintf("//%s/", net.JoinHostPort(host, fmt.Sprintf("%d", port)))
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
	if st.Stale {
		stale := true
		out.Stale = &stale
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
