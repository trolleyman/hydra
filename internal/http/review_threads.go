package http

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/forge"
	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/heads"
	"github.com/trolleyman/hydra/internal/reviewstore"
)

// threadsTimeout bounds the forge calls a diff-viewer thread fetch makes. Short:
// a user is watching a spinner, and a failure degrades to the cached threads.
const threadsTimeout = 20 * time.Second

// GetReviewThreads returns the head's MR conversations for the diff viewer:
// forge threads read live, with Hydra's local-only notes merged in. It never
// fails hard - an unlinked head yields an empty list, and a forge error yields
// the last cached threads plus an explanation (docs/review-threads.md).
func (s *Server) GetReviewThreads(ctx context.Context, request api.GetReviewThreadsRequestObject) (api.GetReviewThreadsResponseObject, error) {
	projectRoot, head, errResp := s.reviewThreadHead(ctx, request.ProjectId, request.Id)
	if errResp != nil {
		return api.GetReviewThreads404JSONResponse(*errResp), nil
	}
	return api.GetReviewThreads200JSONResponse(s.reviewThreadsResponse(ctx, projectRoot, *head)), nil
}

// CreateReviewComment starts a new review thread on a line of the head's MR, as
// the user.
func (s *Server) CreateReviewComment(ctx context.Context, request api.CreateReviewCommentRequestObject) (api.CreateReviewCommentResponseObject, error) {
	projectRoot, head, errResp := s.reviewThreadHead(ctx, request.ProjectId, request.Id)
	if errResp != nil {
		return api.CreateReviewComment404JSONResponse(*errResp), nil
	}
	body := strings.TrimSpace(request.Body.Body)
	if body == "" {
		return reviewThreadBadRequest("the comment is empty"), nil
	}
	provider, remote, err := s.reviewProviderFor(projectRoot, *head)
	if err != nil {
		return reviewThreadBadRequest(err.Error()), nil
	}
	callCtx, cancel := context.WithTimeout(s.backgroundOr(ctx), threadsTimeout)
	defer cancel()
	err = provider.CommentOnLine(callCtx, projectRoot, remote, head.ReviewID, forge.NewLineComment{
		Path: request.Body.Path, Line: request.Body.Line, Body: body,
	})
	if err != nil {
		return reviewThreadBadRequest(fmt.Sprintf("the forge rejected the comment: %v", err)), nil
	}
	return api.CreateReviewComment200JSONResponse(s.reviewThreadsResponse(ctx, projectRoot, *head)), nil
}

// ReplyToReviewThread adds a reply to a thread - posted to the forge as the
// user, or kept local when the request asks for that.
func (s *Server) ReplyToReviewThread(ctx context.Context, request api.ReplyToReviewThreadRequestObject) (api.ReplyToReviewThreadResponseObject, error) {
	projectRoot, head, errResp := s.reviewThreadHead(ctx, request.ProjectId, request.Id)
	if errResp != nil {
		return api.ReplyToReviewThread404JSONResponse(*errResp), nil
	}
	body := strings.TrimSpace(request.Body.Body)
	if body == "" {
		return replyBadRequest("the reply is empty"), nil
	}
	if request.Body.Local != nil && *request.Body.Local {
		if _, err := reviewstore.AppendNote(projectRoot, head.ID, reviewstore.LocalNote{
			ThreadID: request.ThreadId, Author: "", Body: body,
		}); err != nil {
			return replyBadRequest(fmt.Sprintf("the note could not be saved: %v", err)), nil
		}
		s.notifyAgentsChanged(projectRoot, false)
		return api.ReplyToReviewThread200JSONResponse(s.reviewThreadsResponse(ctx, projectRoot, *head)), nil
	}
	provider, remote, err := s.reviewProviderFor(projectRoot, *head)
	if err != nil {
		return replyBadRequest(err.Error()), nil
	}
	callCtx, cancel := context.WithTimeout(s.backgroundOr(ctx), threadsTimeout)
	defer cancel()
	if err := provider.ReplyToThread(callCtx, projectRoot, remote, head.ReviewID, request.ThreadId, body); err != nil {
		return replyBadRequest(fmt.Sprintf("the forge rejected the reply: %v", err)), nil
	}
	return api.ReplyToReviewThread200JSONResponse(s.reviewThreadsResponse(ctx, projectRoot, *head)), nil
}

// reviewThreadHead resolves the project root + head for a thread request.
func (s *Server) reviewThreadHead(ctx context.Context, projectID, id string) (string, *heads.Head, *api.ErrorResponse) {
	projectRoot, err := s.resolveProjectRoot(projectID)
	if err != nil {
		return "", nil, &api.ErrorResponse{Code: 404, Error: api.ErrorResponseErrorNotFound, Details: err.Error()}
	}
	head, err := heads.GetHeadByID(ctx, s.Sessions, s.DB, projectRoot, id)
	if err != nil || head == nil {
		return "", nil, &api.ErrorResponse{Code: 404, Error: api.ErrorResponseErrorNotFound, Details: "agent not found: " + id}
	}
	return projectRoot, head, nil
}

// reviewProviderFor resolves the forge provider + remote for a linked head, with
// a user-facing error when the head has no MR or no provider resolves.
func (s *Server) reviewProviderFor(projectRoot string, head heads.Head) (forge.Provider, string, error) {
	if !head.IsLinked() {
		return nil, "", errtrace.Wrap(fmt.Errorf("this head is not linked to a pull/merge request"))
	}
	review := reviewConfigFor(projectRoot)
	remote := review.GetRemote()
	provider, err := forge.Resolve(review, git.RemoteURL(projectRoot, remote))
	if err != nil {
		return nil, "", errtrace.Wrap(err)
	}
	return provider, remote, nil
}

// reviewThreadsResponse reads the head's threads live from the forge, caches
// them, merges in the local notes and maps the lot to the API shape. A failed
// live read falls back to the cache with stale=true rather than an error, so the
// diff viewer keeps showing the conversation.
func (s *Server) reviewThreadsResponse(ctx context.Context, projectRoot string, head heads.Head) api.ReviewThreadsResponse {
	resp := api.ReviewThreadsResponse{Threads: []api.ReviewThread{}, Linked: head.IsLinked()}
	if !head.IsLinked() {
		return resp
	}
	resp.MrUrl = ptr(head.ReviewURL)
	resp.Provider = ptr(head.ReviewProvider)

	var threads []forge.Thread
	provider, remote, err := s.reviewProviderFor(projectRoot, head)
	if err == nil {
		callCtx, cancel := context.WithTimeout(s.backgroundOr(ctx), threadsTimeout)
		threads, err = provider.Threads(callCtx, projectRoot, remote, head.ReviewID)
		cancel()
	}
	if err == nil {
		_ = reviewstore.SaveThreads(projectRoot, head.ID, threads)
		resp.FetchedAt = ptr(time.Now().Format(time.RFC3339))
	} else {
		cached, fetchedAt := reviewstore.LoadThreads(projectRoot, head.ID)
		threads = cached
		resp.Stale = ptr(true)
		resp.Error = ptr(err.Error())
		if fetchedAt != "" {
			resp.FetchedAt = ptr(fetchedAt)
		}
	}
	resp.Threads = s.mergeLocalNotes(projectRoot, head.ID, threads, reviewstore.LoadNotes(projectRoot, head.ID))
	return resp
}

// mergeLocalNotes maps forge threads to the API shape with each thread's local
// notes appended in time order. Notes whose thread has vanished from the forge
// are dropped rather than orphaned into a thread of their own - they are replies
// to something that no longer exists.
func (s *Server) mergeLocalNotes(projectRoot, headID string, threads []forge.Thread, notes []reviewstore.LocalNote) []api.ReviewThread {
	read := reviewstore.ReadSet(projectRoot, headID)
	byThread := map[string][]reviewstore.LocalNote{}
	for _, n := range notes {
		byThread[n.ThreadID] = append(byThread[n.ThreadID], n)
	}
	out := make([]api.ReviewThread, 0, len(threads))
	for _, t := range threads {
		// Hydra's local mark counts as resolved, and is flagged as local so the UI
		// can say the forge still shows it open (reviewstore.ThreadState).
		locally := reviewstore.ThreadResolved(projectRoot, headID, t.ID)
		at := api.ReviewThread{
			Id: t.ID, Path: t.Path, Line: t.Line,
			Resolved: ptr(t.Resolved || locally), ResolvedLocally: ptr(locally),
			Outdated: ptr(t.Outdated),
			Notes:    make([]api.ReviewThreadNote, 0, len(t.Notes)),
		}
		if t.URL != "" {
			at.Url = ptr(t.URL)
		}
		for _, n := range t.Notes {
			// Numbered from the head's ONE sequence, on first sight. Idempotent, so
			// numbering on every render costs nothing after the first.
			num := reviewstore.NumberForForgeNote(projectRoot, headID, n.ID, t.ID)
			an := api.ReviewThreadNote{Id: n.ID, Body: n.Body, Origin: api.Forge}
			if num > 0 {
				an.Number = &num
				an.Read = ptr(read[num])
			}
			if n.Author != "" {
				an.Author = ptr(n.Author)
			}
			if n.URL != "" {
				an.Url = ptr(n.URL)
			}
			if n.CreatedAt != "" {
				an.CreatedAt = ptr(n.CreatedAt)
			}
			at.Notes = append(at.Notes, an)
		}
		local := byThread[t.ID]
		sort.Slice(local, func(i, j int) bool { return local[i].CreatedAt < local[j].CreatedAt })
		for _, n := range local {
			num := reviewstore.NumberForForgeNote(projectRoot, headID, n.ID, t.ID)
			an := api.ReviewThreadNote{Id: n.ID, Body: n.Body, Origin: api.LocalOnly}
			if num > 0 {
				an.Number = &num
				// A note the AGENT wrote is news; one you wrote is not.
				an.Read = ptr(read[num] || n.Author != reviewstore.AuthorAgent)
			}
			if n.Author != "" {
				an.Author = ptr(n.Author)
			}
			if n.CreatedAt != "" {
				an.CreatedAt = ptr(n.CreatedAt)
			}
			at.Notes = append(at.Notes, an)
		}
		out = append(out, at)
	}
	return out
}

// cacheThreads stores a head's threads from a background poll, so the diff
// viewer has something to render before (or instead of) its own live read.
func cacheThreads(projectRoot, id string, threads []forge.Thread) {
	_ = reviewstore.SaveThreads(projectRoot, id, threads)
}

func reviewThreadBadRequest(detail string) api.CreateReviewComment400JSONResponse {
	return api.CreateReviewComment400JSONResponse{Code: 400, Error: api.ErrorResponseErrorBadRequest, Details: detail}
}

func replyBadRequest(detail string) api.ReplyToReviewThread400JSONResponse {
	return api.ReplyToReviewThread400JSONResponse{Code: 400, Error: api.ErrorResponseErrorBadRequest, Details: detail}
}
