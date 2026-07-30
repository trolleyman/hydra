package http

// The HTTP face of Hydra's own review comments (internal/reviewstore/comments.go,
// docs/review-agent.md).
//
// The endpoint that earns the design is publish. It flips drafts to published and
// then tells the agent ONE line naming their numbers and locations - never their
// bodies. That replaces the old flow, which formatted each comment together with a
// fenced block of its diff context and injected the whole thing into the agent's
// transcript. Notifying by id is strictly better in four ways: it is constant-size
// (six comments cost one line, not six diff excerpts), it does not re-send a diff
// the agent already has, the comment stays canonical so the transcript cannot
// drift from it, and an id survives a compaction that an injected blob does not -
// which is what makes "you raised #3, is it fixed?" work two rounds later.

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/heads"
	"github.com/trolleyman/hydra/internal/reviewstore"
)

// GetReviewComments returns every comment on a head, drafts included. Only the
// browser reaches this; the agent-facing read is reviewstore.PublishedComments.
func (s *Server) GetReviewComments(ctx context.Context, request api.GetReviewCommentsRequestObject) (api.GetReviewCommentsResponseObject, error) {
	projectRoot, head, errResp := s.reviewThreadHead(ctx, request.ProjectId, request.Id)
	if errResp != nil {
		return api.GetReviewComments404JSONResponse(*errResp), nil
	}
	return api.GetReviewComments200JSONResponse(commentsResponse(projectRoot, head.ID, nil)), nil
}

// AddReviewComment stores a comment - a draft by default, published straight away
// for the one-shot "Comment to agent" path.
func (s *Server) AddReviewComment(ctx context.Context, request api.AddReviewCommentRequestObject) (api.AddReviewCommentResponseObject, error) {
	projectRoot, head, errResp := s.reviewThreadHead(ctx, request.ProjectId, request.Id)
	if errResp != nil {
		return api.AddReviewComment404JSONResponse(*errResp), nil
	}
	body := strings.TrimSpace(request.Body.Body)
	if body == "" {
		return commentBadRequest("the comment is empty"), nil
	}
	c := reviewstore.Comment{
		Body:     body,
		Author:   reviewstore.AuthorUser,
		Path:     derefOr(request.Body.Path, ""),
		Line:     derefOr(request.Body.Line, 0),
		OldSide:  derefOr(request.Body.OldSide, false),
		Commit:   derefOr(request.Body.Commit, ""),
		Diff:     derefOr(request.Body.Diff, ""),
		Context:  derefOr(request.Body.Context, ""),
		HunkHash: derefOr(request.Body.HunkHash, ""),
		ReplyTo:  derefOr(request.Body.ReplyTo, 0),
	}
	stored, err := reviewstore.AppendComment(projectRoot, head.ID, c)
	if err != nil {
		return commentBadRequest(fmt.Sprintf("the comment could not be saved: %v", err)), nil
	}
	resp := commentsResponse(projectRoot, head.ID, nil)
	if derefOr(request.Body.Publish, false) {
		published, err := reviewstore.PublishDrafts(projectRoot, head.ID, []int{stored.Number})
		if err != nil {
			return commentBadRequest(fmt.Sprintf("the comment was saved but could not be published: %v", err)), nil
		}
		resp = commentsResponse(projectRoot, head.ID, s.notifyComments(ctx, projectRoot, *head, published))
	}
	s.notifyAgentsChanged(projectRoot, false)
	return api.AddReviewComment200JSONResponse(resp), nil
}

// UpdateReviewComment edits a draft's body.
func (s *Server) UpdateReviewComment(ctx context.Context, request api.UpdateReviewCommentRequestObject) (api.UpdateReviewCommentResponseObject, error) {
	projectRoot, head, errResp := s.reviewThreadHead(ctx, request.ProjectId, request.Id)
	if errResp != nil {
		return api.UpdateReviewComment404JSONResponse(*errResp), nil
	}
	body := strings.TrimSpace(request.Body.Body)
	if body == "" {
		return updateCommentBadRequest("the comment is empty"), nil
	}
	if _, err := reviewstore.UpdateDraft(projectRoot, head.ID, request.Number, body); err != nil {
		return updateCommentBadRequest(commentWriteError(err)), nil
	}
	return api.UpdateReviewComment200JSONResponse(commentsResponse(projectRoot, head.ID, nil)), nil
}

// DeleteReviewComment discards a draft. Its number stays retired.
func (s *Server) DeleteReviewComment(ctx context.Context, request api.DeleteReviewCommentRequestObject) (api.DeleteReviewCommentResponseObject, error) {
	projectRoot, head, errResp := s.reviewThreadHead(ctx, request.ProjectId, request.Id)
	if errResp != nil {
		return api.DeleteReviewComment404JSONResponse(*errResp), nil
	}
	if err := reviewstore.DeleteDraft(projectRoot, head.ID, request.Number); err != nil {
		return deleteCommentBadRequest(commentWriteError(err)), nil
	}
	return api.DeleteReviewComment200JSONResponse(commentsResponse(projectRoot, head.ID, nil)), nil
}

// PublishReviewComments publishes drafts and notifies the head's agent by id.
func (s *Server) PublishReviewComments(ctx context.Context, request api.PublishReviewCommentsRequestObject) (api.PublishReviewCommentsResponseObject, error) {
	projectRoot, head, errResp := s.reviewThreadHead(ctx, request.ProjectId, request.Id)
	if errResp != nil {
		return api.PublishReviewComments404JSONResponse(*errResp), nil
	}
	var numbers []int
	if request.Body != nil && request.Body.Numbers != nil {
		numbers = *request.Body.Numbers
	}
	published, err := reviewstore.PublishDrafts(projectRoot, head.ID, numbers)
	if err != nil {
		return publishCommentsBadRequest(fmt.Sprintf("the comments could not be published: %v", err)), nil
	}
	if len(published) == 0 {
		return publishCommentsBadRequest("there is nothing to publish"), nil
	}
	notified := s.notifyComments(ctx, projectRoot, *head, published)
	s.notifyAgentsChanged(projectRoot, false)
	return api.PublishReviewComments200JSONResponse(commentsResponse(projectRoot, head.ID, notified)), nil
}

// notifyComments tells the head's agent that comments landed, and returns the
// line it was told (empty when there was no one to tell).
//
// Batched by construction: "Submit review" with six comments is one notification,
// not six. A head with no live session is not an error - the comments are durable,
// so the agent can read them whenever it next runs; losing the nudge is not losing
// the comment, which is the whole reason this stopped being an injected blob.
func (s *Server) notifyComments(ctx context.Context, projectRoot string, head heads.Head, published []reviewstore.Comment) *string {
	line := reviewstore.NotifyLine(published)
	if line == "" {
		return nil
	}
	if _, err := s.SendAgentInput(ctx, api.SendAgentInputRequestObject{
		ProjectId: projectRoot,
		Id:        head.ID,
		Body:      &api.SendAgentInputJSONRequestBody{Text: line},
	}); err != nil {
		return nil
	}
	return &line
}

func commentsResponse(projectRoot, headID string, notified *string) api.ReviewCommentsResponse {
	stored := reviewstore.LoadComments(projectRoot, headID)
	out := api.ReviewCommentsResponse{
		Comments: make([]api.ReviewComment, 0, len(stored)),
		Notified: notified,
	}
	for _, c := range stored {
		ac := api.ReviewComment{
			Number:    c.Number,
			Status:    api.ReviewCommentStatus(c.Status),
			Author:    c.Author,
			Body:      c.Body,
			CreatedAt: c.CreatedAt,
		}
		setIf(&ac.ReplyTo, c.ReplyTo, c.ReplyTo > 0)
		setIf(&ac.Path, c.Path, c.Path != "")
		setIf(&ac.Line, c.Line, c.Line > 0)
		setIf(&ac.OldSide, c.OldSide, c.OldSide)
		setIf(&ac.Commit, c.Commit, c.Commit != "")
		setIf(&ac.Diff, c.Diff, c.Diff != "")
		setIf(&ac.Context, c.Context, c.Context != "")
		setIf(&ac.HunkHash, c.HunkHash, c.HunkHash != "")
		setIf(&ac.PublishedAt, c.PublishedAt, c.PublishedAt != "")
		out.Comments = append(out.Comments, ac)
	}
	return out
}

// commentWriteError turns the store's sentinel errors into something a user can
// act on, rather than leaking "no such comment" as a 500.
func commentWriteError(err error) string {
	switch {
	case errors.Is(err, reviewstore.ErrNotDraft):
		return "that comment has already been published, and published comments cannot be changed"
	case errors.Is(err, reviewstore.ErrNoComment):
		return "no such comment"
	default:
		return err.Error()
	}
}

func setIf[T any](dst **T, v T, ok bool) {
	if ok {
		*dst = &v
	}
}

func derefOr[T any](p *T, def T) T {
	if p == nil {
		return def
	}
	return *p
}

func commentBadRequest(detail string) api.AddReviewComment400JSONResponse {
	return api.AddReviewComment400JSONResponse{Code: 400, Error: api.ErrorResponseErrorBadRequest, Details: detail}
}

func updateCommentBadRequest(detail string) api.UpdateReviewComment400JSONResponse {
	return api.UpdateReviewComment400JSONResponse{Code: 400, Error: api.ErrorResponseErrorBadRequest, Details: detail}
}

func deleteCommentBadRequest(detail string) api.DeleteReviewComment400JSONResponse {
	return api.DeleteReviewComment400JSONResponse{Code: 400, Error: api.ErrorResponseErrorBadRequest, Details: detail}
}

func publishCommentsBadRequest(detail string) api.PublishReviewComments400JSONResponse {
	return api.PublishReviewComments400JSONResponse{Code: 400, Error: api.ErrorResponseErrorBadRequest, Details: detail}
}
