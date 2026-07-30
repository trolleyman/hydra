package http

import (
	"context"
	"errors"
	"fmt"
	"time"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/forge"
	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/heads"
	"github.com/trolleyman/hydra/internal/mcpserver"
)

// adoptTimeout bounds the forge lookup + PR-head fetch a spawn-from-PR performs
// host-side. Both are network calls that must not hang the spawn.
const adoptTimeout = 60 * time.Second

// ListReviews enumerates the open PRs/MRs on a project's forge for the adoption
// picker (docs/pr-adoption.md). It never fails hard: an unconfigured or
// unauthenticated forge returns the flags plus an error hint and an empty list,
// so the picker can guide the user to `gh`/`glab auth login`.
func (s *Server) ListReviews(ctx context.Context, request api.ListReviewsRequestObject) (api.ListReviewsResponseObject, error) {
	projectRoot, err := s.resolveProjectRoot(request.ProjectId)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}

	review := reviewConfigFor(projectRoot)
	remote := review.GetRemote()
	remoteURL := git.RemoteURL(projectRoot, remote)
	provider, err := forge.Resolve(review, remoteURL)
	if err != nil {
		return api.ListReviews200JSONResponse{
			Configured: false,
			Reviews:    []api.ReviewRef{},
			Error:      ptr(err.Error()),
		}, nil
	}

	resp := api.ListReviews200JSONResponse{Configured: true, Provider: ptr(provider.Name()), Reviews: []api.ReviewRef{}}
	if e, ok := peekAuthStatus(provider.Name()); ok {
		resp.Authenticated = e.ok
		resp.AuthStatus = ptr(e.detail)
	}
	warmAuthStatus(provider.Name())

	opts := forge.ListMROptions{Limit: 50}
	if request.Params.State != nil {
		opts.State = *request.Params.State
	}
	if request.Params.Author != nil {
		opts.Author = *request.Params.Author
	}
	if request.Params.Search != nil {
		opts.Search = *request.Params.Search
	}
	if request.Params.Limit != nil && *request.Params.Limit > 0 {
		opts.Limit = *request.Params.Limit
	}

	listCtx, cancel := context.WithTimeout(s.backgroundOr(ctx), adoptTimeout)
	defer cancel()
	refs, err := provider.ListMRs(listCtx, projectRoot, remote, opts)
	if err != nil {
		resp.Error = ptr(fmt.Sprintf("list PRs failed: %v", err))
		return resp, nil
	}
	resp.Reviews = make([]api.ReviewRef, 0, len(refs))
	for _, r := range refs {
		resp.Reviews = append(resp.Reviews, mrRefToAPI(r))
	}
	return resp, nil
}

// mrRefToAPI maps a forge.MRRef to its API shape.
func mrRefToAPI(r forge.MRRef) api.ReviewRef {
	ref := api.ReviewRef{
		Id:           r.ID,
		Url:          r.URL,
		Title:        r.Title,
		State:        r.State,
		HeadRef:      r.HeadRef,
		TargetBranch: r.TargetBranch,
		CrossRepo:    r.CrossRepo,
		CanPush:      r.CanPush,
	}
	if r.Author != "" {
		ref.Author = ptr(r.Author)
	}
	ref.Draft = ptr(r.Draft)
	if r.HeadRepoURL != "" {
		ref.HeadRepoUrl = ptr(r.HeadRepoURL)
	}
	return ref
}

// resolveAdoptSpec turns an adopt_mr request into a fully-resolved AdoptSpec by
// looking the MR up on the forge and fetching its head commit into a private
// local ref, host-side. Both steps run with the user's forge/git credentials -
// never in the agent sandbox. It returns a user-facing error string (for a 400)
// on any failure, so the spawn handler can surface it cleanly.
func (s *Server) resolveAdoptSpec(ctx context.Context, projectRoot string, body api.AdoptMRRequest) (*heads.AdoptSpec, string) {
	id := body.Id
	if id == "" {
		return nil, "adopt_mr.id is required"
	}
	review := reviewConfigFor(projectRoot)
	remote := review.GetRemote()
	if body.Remote != nil && *body.Remote != "" {
		remote = *body.Remote
	}
	remoteURL := git.RemoteURL(projectRoot, remote)
	provider, err := forge.Resolve(review, remoteURL)
	if err != nil {
		return nil, err.Error()
	}

	adoptCtx, cancel := context.WithTimeout(s.backgroundOr(ctx), adoptTimeout)
	defer cancel()

	ref, err := provider.GetMR(adoptCtx, projectRoot, remote, id)
	if err != nil {
		return nil, fmt.Sprintf("look up PR %s failed: %v", id, err)
	}
	if ref.HeadRef == "" {
		return nil, fmt.Sprintf("PR %s has no head branch to adopt", id)
	}

	// Fetch the PR head into a private local ref via the forge's read-only
	// pseudo-ref on the target repo - which resolves a fork PR too, so no remote
	// is ever added for the fork.
	localRef, refspec := git.PRHeadRefspec(provider.Name(), ref.ID)
	if err := git.FetchRefspec(adoptCtx, projectRoot, remote, refspec); err != nil {
		var authErr *git.AuthError
		if errors.As(err, &authErr) {
			return nil, authErr.Error()
		}
		return nil, fmt.Sprintf("fetch PR %s head failed: %v", id, err)
	}

	spec := &heads.AdoptSpec{
		Provider:     provider.Name(),
		ReviewID:     ref.ID,
		ReviewURL:    ref.URL,
		TargetBranch: ref.TargetBranch,
		HeadRef:      ref.HeadRef,
		HeadRepoURL:  ref.HeadRepoURL,
		WorktreeBase: localRef,
		CanPush:      ref.CanPush,
	}
	spec.Review = ptr(adoptReviewSnapshot(adoptCtx, provider, projectRoot, remote, ref))
	return spec, ""
}

// adoptReviewSnapshot fetches the PR's status + unresolved discussions so the
// spawn can write the head's review file before the agent launches (the agent
// typically asks for its review comments seconds into its first turn, and the
// review watcher would not fill the file in for another 30s). Best-effort: a
// forge hiccup still yields a linked snapshot built from the MRRef, which the
// watcher then completes on its next tick.
func adoptReviewSnapshot(ctx context.Context, provider forge.Provider, projectRoot, remote string, ref forge.MRRef) mcpserver.ReviewFile {
	st := forge.Status{ID: ref.ID, URL: ref.URL, State: ref.State}
	if s, err := provider.Status(ctx, projectRoot, remote, ref.ID); err == nil {
		st = s
	}
	var discussions []forge.Discussion
	if st.UnresolvedDiscussions > 0 {
		if threads, err := provider.Threads(ctx, projectRoot, remote, ref.ID); err == nil {
			discussions = forge.UnresolvedDiscussions(threads)
		}
	}
	// No head id yet - this seeds the review file as part of spawning onto an
	// existing PR, so there is no numbering sequence to draw from until it exists.
	// The watcher numbers these on its first pass.
	return reviewSnapshot("", "", ref.URL, ref.ID, provider.Name(), ref.TargetBranch, st, discussions)
}
