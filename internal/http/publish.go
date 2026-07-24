package http

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/forge"
	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/heads"
)

// publishTimeout bounds a single host-side publish (push + MR create). Network
// calls to the remote and forge can be slow but must not hang the daemon.
const publishTimeout = 90 * time.Second

// reviewConfigFor loads a project's resolved [review] config (nil-safe). The
// review section drives all forge/remote resolution and is read only from the
// trusted root + local config (never a head's branch copy), following the
// unsafe_host trust precedent.
func reviewConfigFor(projectRoot string) *config.ReviewConfig {
	cfg, err := config.Load(projectRoot)
	if err != nil {
		return &config.ReviewConfig{}
	}
	if cfg.Review == nil {
		return &config.ReviewConfig{}
	}
	return cfg.Review
}

// reviewRemote returns the git remote the review flow targets (review.remote,
// default "origin").
func reviewRemote(projectRoot string) string {
	return reviewConfigFor(projectRoot).GetRemote()
}

// downstreamAheadBehind reports ahead/behind between the local head branch and the
// remote-tracking downstream ref (<remote>/<downstream>), from cached refs.
func downstreamAheadBehind(projectRoot, localBranch, remote, downstream string) (ahead, behind int, ok bool) {
	if localBranch == "" || downstream == "" || remote == "" {
		return 0, 0, false
	}
	return git.AheadBehind(projectRoot, localBranch, remote+"/"+downstream)
}

// resolveDownstreamBranch returns the head's downstream branch, seeding it from
// review.push_branch_template (with {id}/{ticket}/{base}) when unset. It never
// writes to the DB - the caller persists the resolved value at publish.
func resolveDownstreamBranch(review *config.ReviewConfig, jira *config.JiraConfig, h heads.Head) string {
	if h.DownstreamBranch != "" {
		return h.DownstreamBranch
	}
	ticket := ""
	if jira != nil {
		ticket = config.ExtractTicket(h.Prompt+" "+h.Title, jira.GetTicketPattern())
	}
	name := config.ExpandBranchTemplate(review.GetPushBranchTemplate(), map[string]string{
		"id":     h.ID,
		"ticket": ticket,
		"base":   h.BaseBranch,
	})
	if name == "" {
		name = h.ID
	}
	return name
}

// publishOverrides are the optional Create MR dialog overrides applied over the
// resolved [review] defaults.
type publishOverrides struct {
	DownstreamBranch string
	Remote           string
	TargetBranch     string
	Title            string
	Description      *string
	Draft            *bool
}

// publishFailure is a user-facing publish failure the HTTP layer maps to the
// right response (400 ErrorResponse for badReq, else 409 MergeConflictError).
type publishFailure struct {
	badReq  bool
	errType api.MergeConflictErrorError
	detail  string
	failing *int
}

// PublishAgent pushes a head's branch to the remote as its downstream branch and
// creates/updates the forge MR - host-side, with the user's own credentials
// (NON_LOCAL_INTEGRATION.md 3.3). Thin wrapper over publishHead.
func (s *Server) PublishAgent(ctx context.Context, request api.PublishAgentRequestObject) (api.PublishAgentResponseObject, error) {
	projectRoot, err := s.resolveProjectRoot(request.ProjectId)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	head, err := heads.GetHeadByID(ctx, s.Sessions, s.DB, projectRoot, request.Id)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	if head == nil {
		return api.PublishAgent404JSONResponse{Code: 404, Error: api.ErrorResponseErrorNotFound, Details: "agent not found"}, nil
	}
	if head.Branch == nil {
		return api.PublishAgent400JSONResponse{Code: 400, Error: api.ErrorResponseErrorBadRequest, Details: "agent has no git branch to publish"}, nil
	}

	var ov publishOverrides
	if b := request.Body; b != nil {
		if b.Remote != nil {
			ov.Remote = *b.Remote
		}
		if b.TargetBranch != nil {
			ov.TargetBranch = *b.TargetBranch
		}
		if b.DownstreamBranch != nil {
			ov.DownstreamBranch = *b.DownstreamBranch
		}
		if b.Title != nil {
			ov.Title = *b.Title
		}
		ov.Description = b.Description
		ov.Draft = b.Draft
	}
	force := request.Params.Force != nil && *request.Params.Force

	updated, fail := s.publishHead(ctx, projectRoot, *head, ov, force)
	if fail != nil {
		if fail.badReq {
			return api.PublishAgent400JSONResponse{Code: 400, Error: api.ErrorResponseErrorBadRequest, Details: fail.detail}, nil
		}
		resp := api.MergeConflictError{Error: fail.errType, Code: 409, Details: fail.detail}
		if fail.failing != nil {
			resp.FailingTests = fail.failing
		}
		return api.PublishAgent409JSONResponse(resp), nil
	}
	return api.PublishAgent200JSONResponse(s.agentResponseWithReview(*updated)), nil
}

// publishHead is the shared publish core used by the HTTP handler and the
// publish-when-green watcher: claim (publishing), local test gate (force
// bypasses), host-side refspec push, forge.EnsureMR, store the link, refresh
// cached state. Returns the updated head on success, else a *publishFailure.
func (s *Server) publishHead(ctx context.Context, projectRoot string, head heads.Head, ov publishOverrides, force bool) (*heads.Head, *publishFailure) {
	review := reviewConfigFor(projectRoot)
	cfg, _ := config.Load(projectRoot)
	remote := firstNonEmpty(ov.Remote, review.GetRemote())
	// The MR targets the head's base branch (where its work merges back), unless
	// the publish request explicitly overrode it. There is no configurable
	// [review] target_branch - the base branch is the source of truth.
	target := firstNonEmpty(ov.TargetBranch, head.BaseBranch)
	downstream := firstNonEmpty(ov.DownstreamBranch, resolveDownstreamBranch(review, cfg.Jira, head))
	title := firstNonEmpty(ov.Title, defaultMRTitle(head))
	description := head.Prompt
	if ov.Description != nil {
		description = *ov.Description
	}
	draft := review.IsDraft()
	if ov.Draft != nil {
		draft = *ov.Draft
	}

	if err := git.ValidateRef(downstream); err != nil {
		return nil, &publishFailure{badReq: true, detail: fmt.Sprintf("invalid downstream branch %q: %v", downstream, err)}
	}

	remoteURL := git.RemoteURL(projectRoot, remote)
	provider, err := forge.Resolve(review, remoteURL)
	if err != nil {
		return nil, &publishFailure{badReq: true, detail: err.Error()}
	}

	if s.DB != nil {
		ok, err := s.DB.TrySetHeadStatus(head.ID, "idle", "publishing")
		if err != nil {
			return nil, &publishFailure{errType: api.MergeConflictErrorErrorConflict, detail: err.Error()}
		}
		if !ok {
			return nil, &publishFailure{errType: api.MergeConflictErrorErrorConflict, detail: "operation already in progress"}
		}
	}
	release := func(errMsg *string) {
		if s.DB != nil {
			_ = s.DB.ClearHeadStatus(head.ID, errMsg)
		}
	}

	if !force && review.IsRequireLocalTests() {
		if code, failing, blocked := s.testGateVerdict(projectRoot, head); blocked {
			errMsg := "publish blocked: the head's tests are not passing (pass force=true to override)"
			release(&errMsg)
			f := &publishFailure{errType: code, detail: errMsg}
			if code == api.MergeConflictErrorErrorTestsFailing {
				f.failing = &failing
			}
			return nil, f
		}
	}

	pubCtx, cancel := context.WithTimeout(s.backgroundOr(ctx), publishTimeout)
	defer cancel()

	refspec := *head.Branch + ":refs/heads/" + downstream
	if _, err := git.PushRefspec(pubCtx, projectRoot, remote, refspec, nil); err != nil {
		var authErr *git.AuthError
		if errors.As(err, &authErr) {
			errMsg := authErr.Error()
			release(&errMsg)
			return nil, &publishFailure{badReq: true, detail: errMsg}
		}
		errMsg := fmt.Sprintf("push failed: %v", err)
		release(&errMsg)
		return nil, &publishFailure{errType: api.MergeConflictErrorErrorConflict, detail: errMsg}
	}

	mr, err := provider.EnsureMR(pubCtx, forge.EnsureMROptions{
		RepoDir:            projectRoot,
		Remote:             remote,
		SourceBranch:       downstream,
		TargetBranch:       target,
		Title:              title,
		Description:        description,
		Draft:              draft,
		Squash:             review.IsSquash(),
		RemoveSourceBranch: review.IsDeleteRemoteBranch(),
	})
	if err != nil {
		errMsg := fmt.Sprintf("create MR failed: %v", err)
		release(&errMsg)
		return nil, &publishFailure{badReq: true, detail: errMsg}
	}

	if s.DB != nil {
		if err := s.DB.SetReviewLink(head.ID, downstream, mr.URL, mr.ID, provider.Name(), target); err != nil {
			release(nil)
			return nil, &publishFailure{badReq: true, detail: err.Error()}
		}
	}
	release(nil)
	s.refreshReviewState(pubCtx, projectRoot, head.ID, provider, remote, mr.ID)
	s.notifyAgentsChanged(projectRoot, false)

	updated, _ := heads.GetHeadByID(ctx, s.Sessions, s.DB, projectRoot, head.ID)
	if updated == nil {
		updated = &head
	}
	return updated, nil
}

// firstNonEmpty returns the first non-empty string of a, b.
func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// PushToMr re-pushes the local head branch to its downstream branch (idempotent
// publish step 3). Plain push only.
func (s *Server) PushToMr(ctx context.Context, request api.PushToMrRequestObject) (api.PushToMrResponseObject, error) {
	projectRoot, head, resp := s.linkedHead(ctx, request.ProjectId, request.Id)
	if resp != nil {
		return pushToMrErr(resp), nil
	}
	if err := s.pushHeadToMR(ctx, projectRoot, *head); err != nil {
		var authErr *git.AuthError
		detail := fmt.Sprintf("push failed: %v", err)
		if errors.As(err, &authErr) {
			detail = authErr.Error()
		}
		return api.PushToMr400JSONResponse{Code: 400, Error: api.ErrorResponseErrorBadRequest, Details: detail}, nil
	}
	s.notifyAgentsChanged(projectRoot, false)
	updated, _ := heads.GetHeadByID(ctx, s.Sessions, s.DB, projectRoot, head.ID)
	if updated == nil {
		updated = head
	}
	return api.PushToMr200JSONResponse(s.agentResponseWithReview(*updated)), nil
}

// pushHeadToMR pushes a linked head's local branch to its downstream branch
// (plain push, idempotent). Shared by the PushToMr handler and auto-publish.
func (s *Server) pushHeadToMR(ctx context.Context, projectRoot string, head heads.Head) error {
	if head.Branch == nil || head.DownstreamBranch == "" {
		return errtrace.Wrap(fmt.Errorf("head is not linked to an MR"))
	}
	remote := reviewRemote(projectRoot)
	pubCtx, cancel := context.WithTimeout(s.backgroundOr(ctx), publishTimeout)
	defer cancel()
	refspec := *head.Branch + ":refs/heads/" + head.DownstreamBranch
	_, err := git.PushRefspec(pubCtx, projectRoot, remote, refspec, nil)
	return errtrace.Wrap(err)
}

// PullFromMr merges the remote downstream ref INTO the head branch (merge, not
// rebase - same semantics as update-from-base), so conflicts surface the same way.
func (s *Server) PullFromMr(ctx context.Context, request api.PullFromMrRequestObject) (api.PullFromMrResponseObject, error) {
	projectRoot, head, resp := s.linkedHead(ctx, request.ProjectId, request.Id)
	if resp != nil {
		return pullFromMrErr(resp), nil
	}
	remote := reviewRemote(projectRoot)
	mergeDir := projectRoot
	if head.Worktree != nil {
		mergeDir = *head.Worktree
	}
	pubCtx, cancel := context.WithTimeout(s.backgroundOr(ctx), publishTimeout)
	defer cancel()
	if err := git.Fetch(pubCtx, projectRoot, remote); err != nil {
		return api.PullFromMr400JSONResponse{Code: 400, Error: api.ErrorResponseErrorBadRequest, Details: fmt.Sprintf("fetch failed: %v", err)}, nil
	}
	track := remote + "/" + head.DownstreamBranch
	authorName, authorEmail := gitConfigVal(mergeDir, "user.name"), gitConfigVal(mergeDir, "user.email")
	if err := git.Merge(mergeDir, track, authorName, authorEmail); err != nil {
		var conflict *git.ConflictError
		var dirty *git.DirtyMergeError
		errMsg := fmt.Sprintf("pull failed: %v", err)
		switch {
		case errors.As(err, &dirty):
			files := dirty.Files
			return api.PullFromMr409JSONResponse(api.MergeConflictError{Error: api.MergeConflictErrorErrorUncommittedChanges, Code: 409, Details: errMsg, ConflictingFiles: &files}), nil
		case errors.As(err, &conflict):
			files := conflict.Files
			return api.PullFromMr409JSONResponse(api.MergeConflictError{Error: api.MergeConflictErrorErrorMergeConflict, Code: 409, Details: errMsg, ConflictingFiles: &files}), nil
		default:
			return api.PullFromMr409JSONResponse(api.MergeConflictError{Error: api.MergeConflictErrorErrorMergeConflict, Code: 409, Details: errMsg}), nil
		}
	}
	s.notifyAgentsChanged(projectRoot, false)
	updated, _ := heads.GetHeadByID(ctx, s.Sessions, s.DB, projectRoot, head.ID)
	if updated == nil {
		updated = head
	}
	return api.PullFromMr200JSONResponse(s.agentResponseWithReview(*updated)), nil
}

// SetDownstreamBranch edits a head's downstream branch. Soft-locked after first
// publish: on GitLab/GitHub the source branch IS the MR's identity, so renaming
// orphans the MR - the linked case is rejected with a hint (3.3a).
func (s *Server) SetDownstreamBranch(ctx context.Context, request api.SetDownstreamBranchRequestObject) (api.SetDownstreamBranchResponseObject, error) {
	projectRoot, err := s.resolveProjectRoot(request.ProjectId)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	head, err := heads.GetHeadByID(ctx, s.Sessions, s.DB, projectRoot, request.Id)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	if head == nil {
		return api.SetDownstreamBranch404JSONResponse{Code: 404, Error: api.ErrorResponseErrorNotFound, Details: "agent not found"}, nil
	}
	name := ""
	if request.Body != nil {
		name = strings.TrimSpace(request.Body.DownstreamBranch)
	}
	if err := git.ValidateRef(name); err != nil {
		return api.SetDownstreamBranch400JSONResponse{Code: 400, Error: api.ErrorResponseErrorBadRequest, Details: fmt.Sprintf("invalid branch name %q: %v", name, err)}, nil
	}
	if head.IsLinked() && name != head.DownstreamBranch {
		return api.SetDownstreamBranch400JSONResponse{Code: 400, Error: api.ErrorResponseErrorBadRequest, Details: "this head already has an MR: renaming its downstream branch would orphan it. Close the MR (or detach) first, then rename."}, nil
	}
	if s.DB != nil {
		if err := s.DB.SetDownstreamBranch(head.ID, name); err != nil {
			return nil, errtrace.Wrap(err)
		}
	}
	s.notifyAgentsChanged(projectRoot, false)
	updated, _ := heads.GetHeadByID(ctx, s.Sessions, s.DB, projectRoot, head.ID)
	if updated == nil {
		updated = head
	}
	return api.SetDownstreamBranch200JSONResponse(s.agentResponseWithReview(*updated)), nil
}

// GetReviewConfig returns the resolved [review] config plus live forge auth status
// for the Settings Review section and the Create MR dialog prefill.
func (s *Server) GetReviewConfig(ctx context.Context, request api.GetReviewConfigRequestObject) (api.GetReviewConfigResponseObject, error) {
	projectRoot, err := s.resolveProjectRoot(request.ProjectId)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	return api.GetReviewConfig200JSONResponse(s.resolveReviewConfigResponse(ctx, projectRoot)), nil
}

// resolveReviewConfigResponse builds the resolved [review] config response
// (defaults applied, provider auto-detected, live forge auth checked) for a
// project root. Shared by GetReviewConfig and SaveReviewConfig.
func (s *Server) resolveReviewConfigResponse(ctx context.Context, projectRoot string) api.ReviewConfigResponse {
	cfg, _ := config.Load(projectRoot)
	review := cfg.Review
	if review == nil {
		review = &config.ReviewConfig{}
	}
	remote := review.GetRemote()
	remoteURL := git.RemoteURL(projectRoot, remote)
	provider := review.ResolveProvider(remoteURL)

	resp := api.ReviewConfigResponse{
		Configured:         cfg.Review != nil || provider != "",
		Provider:           provider,
		ProviderSetting:    ptr(review.GetProvider()),
		Remote:             remote,
		RemoteUrl:          ptr(remoteURL),
		BrowseUrl:          ptr(config.BrowseURL(remoteURL)),
		Auth:               review.GetAuth(),
		DefaultAction:      review.GetDefaultAction(),
		PushBranchTemplate: ptr(review.GetPushBranchTemplate()),
		Draft:              ptr(review.IsDraft()),
		Squash:             ptr(review.IsSquash()),
		DeleteRemoteBranch: ptr(review.IsDeleteRemoteBranch()),
		RequireLocalTests:  ptr(review.IsRequireLocalTests()),
		PublishWhenGreen:   ptr(review.IsPublishWhenGreen()),
		ProtectedBranches:  &review.ProtectedBranches,
	}
	if provider != "" && review.GetAuth() == config.ReviewAuthCLI {
		authCtx, cancel := context.WithTimeout(s.backgroundOr(ctx), 8*time.Second)
		defer cancel()
		if ok, detail := cachedAuthStatus(authCtx, provider); detail != "" || ok {
			resp.Authenticated = &ok
			resp.AuthStatus = ptr(detail)
		}
	}
	return resp
}

// authStatusCache memoizes forge.AuthStatus per provider. The check shells out
// to `gh`/`glab auth status` (a network round-trip when logged in), which made
// GetReviewConfig take ~600ms+ on every page load - visible as the sidebar
// forge icon popping in late. Logged-in results are cached for a few minutes
// (auth rarely revokes); logged-out results only briefly, so "run `gh auth
// login`" -> reopen the dialog shows the fix without a long stale warning.
var authStatusCache = struct {
	sync.Mutex
	entries map[string]authStatusEntry
}{entries: map[string]authStatusEntry{}}

type authStatusEntry struct {
	ok     bool
	detail string
	at     time.Time
}

const (
	authStatusOKTTL   = 5 * time.Minute
	authStatusFailTTL = 15 * time.Second
)

func cachedAuthStatus(ctx context.Context, provider string) (bool, string) {
	authStatusCache.Lock()
	e, hit := authStatusCache.entries[provider]
	authStatusCache.Unlock()
	if hit {
		ttl := authStatusFailTTL
		if e.ok {
			ttl = authStatusOKTTL
		}
		if time.Since(e.at) < ttl {
			return e.ok, e.detail
		}
	}
	ok, detail, err := forge.AuthStatus(ctx, provider)
	if err != nil && !ok && detail == "" {
		// A failed/cancelled check (e.g. request context done) yields nothing
		// worth caching; keep any previous entry for the next attempt.
		return ok, detail
	}
	authStatusCache.Lock()
	authStatusCache.entries[provider] = authStatusEntry{ok: ok, detail: detail, at: time.Now()}
	authStatusCache.Unlock()
	return ok, detail
}

// ArmPublishWhenGreen arms publish-when-green for a head (3.5).
func (s *Server) ArmPublishWhenGreen(ctx context.Context, request api.ArmPublishWhenGreenRequestObject) (api.ArmPublishWhenGreenResponseObject, error) {
	projectRoot, err := s.resolveProjectRoot(request.ProjectId)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	head, err := heads.GetHeadByID(ctx, s.Sessions, s.DB, projectRoot, request.Id)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	if head == nil || head.Branch == nil {
		return api.ArmPublishWhenGreen404JSONResponse{Code: 404, Error: api.ErrorResponseErrorNotFound, Details: "agent not found"}, nil
	}
	if s.DB != nil {
		if err := s.DB.SetPublishWhenGreen(head.ID, true, time.Now().UTC().Format(time.RFC3339)); err != nil {
			return nil, errtrace.Wrap(err)
		}
	}
	s.notifyAgentsChanged(projectRoot, true)
	return api.ArmPublishWhenGreen204Response{}, nil
}

// DisarmPublishWhenGreen clears the publish-when-green intent for a head.
func (s *Server) DisarmPublishWhenGreen(ctx context.Context, request api.DisarmPublishWhenGreenRequestObject) (api.DisarmPublishWhenGreenResponseObject, error) {
	projectRoot, err := s.resolveProjectRoot(request.ProjectId)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	if s.DB != nil {
		if err := s.DB.SetPublishWhenGreen(request.Id, false, ""); err != nil {
			return nil, errtrace.Wrap(err)
		}
	}
	s.notifyAgentsChanged(projectRoot, true)
	return api.DisarmPublishWhenGreen204Response{}, nil
}

// linkedHead resolves a head and asserts it is linked to an MR with a branch and
// downstream name; on failure it returns a filled *linkErr the wrappers map to
// the right per-endpoint response type.
func (s *Server) linkedHead(ctx context.Context, projectID, id string) (string, *heads.Head, *linkErr) {
	projectRoot, err := s.resolveProjectRoot(projectID)
	if err != nil {
		return "", nil, &linkErr{code: 500, msg: err.Error()}
	}
	head, err := heads.GetHeadByID(ctx, s.Sessions, s.DB, projectRoot, id)
	if err != nil {
		return "", nil, &linkErr{code: 500, msg: err.Error()}
	}
	if head == nil {
		return "", nil, &linkErr{code: 404, msg: "agent not found"}
	}
	if head.Branch == nil {
		return "", nil, &linkErr{code: 400, msg: "agent has no git branch"}
	}
	if !head.IsLinked() || head.DownstreamBranch == "" {
		return "", nil, &linkErr{code: 400, msg: "agent is not linked to an MR"}
	}
	return projectRoot, head, nil
}

// linkErr is a small internal error carrier shared by the push/pull wrappers.
type linkErr struct {
	code int
	msg  string
}

func pushToMrErr(e *linkErr) api.PushToMrResponseObject {
	switch e.code {
	case 404:
		return api.PushToMr404JSONResponse{Code: 404, Error: api.ErrorResponseErrorNotFound, Details: e.msg}
	default:
		return api.PushToMr400JSONResponse{Code: 400, Error: api.ErrorResponseErrorBadRequest, Details: e.msg}
	}
}

func pullFromMrErr(e *linkErr) api.PullFromMrResponseObject {
	switch e.code {
	case 404:
		return api.PullFromMr404JSONResponse{Code: 404, Error: api.ErrorResponseErrorNotFound, Details: e.msg}
	default:
		return api.PullFromMr400JSONResponse{Code: 400, Error: api.ErrorResponseErrorBadRequest, Details: e.msg}
	}
}

// refreshReviewState polls the forge for the MR's current state and caches it on
// the head (best-effort; a failure just leaves the prior cache). Shared by publish
// and the lifecycle watcher.
func (s *Server) refreshReviewState(ctx context.Context, projectRoot, headID string, provider forge.Provider, remote, mrID string) {
	if s.DB == nil || mrID == "" {
		return
	}
	st, err := provider.Status(ctx, projectRoot, remote, mrID)
	if err != nil {
		return
	}
	data, err := json.Marshal(reviewStateJSON(st))
	if err != nil {
		return
	}
	_ = s.DB.SetReviewState(headID, string(data), time.Now().Format(time.RFC3339))
}

// reviewStateJSON converts a forge.Status into the api.ReviewState cached on the
// head (and returned to the UI). Shared by publish and the lifecycle watcher.
func reviewStateJSON(st forge.Status) api.ReviewState {
	return api.ReviewState{
		State:                 st.State,
		CiStatus:              ptr(st.CIStatus),
		Approvals:             ptr(st.Approvals),
		ApprovalsRequired:     ptr(st.ApprovalsRequired),
		UnresolvedDiscussions: ptr(st.UnresolvedDiscussions),
		Mergeable:             ptr(st.Mergeable),
	}
}

// defaultMRTitle seeds an MR title from the head's title or prompt first line.
func defaultMRTitle(h heads.Head) string {
	if t := strings.TrimSpace(h.Title); t != "" {
		return t
	}
	line := strings.TrimSpace(h.Prompt)
	if i := strings.IndexByte(line, '\n'); i >= 0 {
		line = line[:i]
	}
	if line == "" {
		return h.ID
	}
	return line
}

// backgroundOr returns the server's background context (so a publish outlives the
// request) or ctx when there is none.
func (s *Server) backgroundOr(ctx context.Context) context.Context {
	if s.BackgroundCtx != nil {
		return s.BackgroundCtx
	}
	return ctx
}
