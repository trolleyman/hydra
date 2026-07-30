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
	"log"
	"strings"
	"time"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/claudestream"
	"github.com/trolleyman/hydra/internal/heads"
	"github.com/trolleyman/hydra/internal/reviewstore"
)

// GetReviewComments returns every comment on a head, drafts included. Only the
// browser reaches this; the agent-facing read is reviewstore.PublishedComments.
func (s *Server) GetReviewComments(ctx context.Context, request api.GetReviewCommentsRequestObject) (api.GetReviewCommentsResponseObject, error) {
	projectRoot, head, errResp := s.reviewThreadHead(ctx, request.ProjectId, request.AgentId)
	if errResp != nil {
		return api.GetReviewComments404JSONResponse(*errResp), nil
	}
	return api.GetReviewComments200JSONResponse(commentsResponse(projectRoot, head.ID, nil)), nil
}

// AddReviewComment stores a comment - a draft by default, published straight away
// for the one-shot "Comment to agent" path.
func (s *Server) AddReviewComment(ctx context.Context, request api.AddReviewCommentRequestObject) (api.AddReviewCommentResponseObject, error) {
	projectRoot, head, errResp := s.reviewThreadHead(ctx, request.ProjectId, request.AgentId)
	if errResp != nil {
		return api.AddReviewComment404JSONResponse(*errResp), nil
	}
	body := strings.TrimSpace(request.Body.Body)
	attachments := derefOr(request.Body.Attachments, nil)
	// A comment carrying only an attachment is a real comment - a screenshot of the
	// thing being pointed at often says more than a sentence about it would.
	if body == "" && len(attachments) == 0 {
		return commentBadRequest("the comment is empty"), nil
	}
	image, err := imageAnchorFromAPI(request.Body.Image)
	if err != nil {
		return commentBadRequest(err.Error()), nil
	}
	c := reviewstore.Comment{
		Body:        body,
		Author:      reviewstore.AuthorUser,
		Path:        derefOr(request.Body.Path, ""),
		Line:        derefOr(request.Body.Line, 0),
		OldSide:     derefOr(request.Body.OldSide, false),
		Commit:      derefOr(request.Body.Commit, ""),
		Diff:        derefOr(request.Body.Diff, ""),
		Context:     derefOr(request.Body.Context, ""),
		HunkHash:    derefOr(request.Body.HunkHash, ""),
		ReplyTo:     derefOr(request.Body.ReplyTo, 0),
		Attachments: attachments,
		Image:       image,
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
		notified, toReviewer := s.notifyComments(ctx, projectRoot, *head, published)
		resp = commentsResponse(projectRoot, head.ID, notified)
		resp.NotifiedReviewer = ptr(toReviewer)
	}
	s.notifyAgentsChanged(projectRoot, false)
	return api.AddReviewComment200JSONResponse(resp), nil
}

// UpdateReviewComment edits a draft's body.
func (s *Server) UpdateReviewComment(ctx context.Context, request api.UpdateReviewCommentRequestObject) (api.UpdateReviewCommentResponseObject, error) {
	projectRoot, head, errResp := s.reviewThreadHead(ctx, request.ProjectId, request.AgentId)
	if errResp != nil {
		return api.UpdateReviewComment404JSONResponse(*errResp), nil
	}
	body := strings.TrimSpace(request.Body.Body)
	attachments := derefOr(request.Body.Attachments, nil)
	if body == "" && len(attachments) == 0 {
		return updateCommentBadRequest("the comment is empty"), nil
	}
	// nil (the field omitted) leaves the draft's attachments as they were; an empty
	// list clears them, which is what removing the last chip has to do. So the
	// pointer's nil-ness is carried through rather than flattened by derefOr above.
	if request.Body.Attachments != nil && attachments == nil {
		attachments = []string{}
	}
	if _, err := reviewstore.UpdateDraft(projectRoot, head.ID, request.Number, body, attachments); err != nil {
		return updateCommentBadRequest(commentWriteError(err)), nil
	}
	return api.UpdateReviewComment200JSONResponse(commentsResponse(projectRoot, head.ID, nil)), nil
}

// DeleteReviewComment discards a draft. Its number stays retired.
func (s *Server) DeleteReviewComment(ctx context.Context, request api.DeleteReviewCommentRequestObject) (api.DeleteReviewCommentResponseObject, error) {
	projectRoot, head, errResp := s.reviewThreadHead(ctx, request.ProjectId, request.AgentId)
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
	projectRoot, head, errResp := s.reviewThreadHead(ctx, request.ProjectId, request.AgentId)
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
	notified, toReviewer := s.notifyComments(ctx, projectRoot, *head, published)
	s.notifyAgentsChanged(projectRoot, false)
	resp := commentsResponse(projectRoot, head.ID, notified)
	resp.NotifiedReviewer = ptr(toReviewer)
	return api.PublishReviewComments200JSONResponse(resp), nil
}

// notifyComments tells whoever a batch of published comments was addressed to,
// and returns the line the HEAD was told (empty when it was not told anything).
//
// Addressed to whom is the mention system (reviewstore.Mentions): no mention means
// the head, as it always has; `@review` sends it to the reviewer instead; naming
// both sends it to both. So one "Submit review" can produce two messages - one per
// audience - and never more, because each is batched over its own recipients.
//
// notifyAlways for the head: this is something the user just did on purpose and
// expects to land, and a chat head steers a mid-turn message in at its next step
// boundary rather than having it corrupt the turn. Waiting for idle here would
// mean commenting on a working agent did nothing until it stopped.
func (s *Server) notifyComments(ctx context.Context, projectRoot string, head heads.Head, published []reviewstore.Comment) (*string, bool) {
	var forHead, forReviewer []reviewstore.Comment
	for _, c := range published {
		// An agent's own comment never routes. Without this rule one "@review this"
		// in a reply becomes a chain of agents summoning each other, which is an
		// unbounded bill and nobody's idea of a review.
		if c.Author != reviewstore.AuthorUser {
			continue
		}
		m := reviewstore.ParseMentions(c.Body)
		if m.Head {
			forHead = append(forHead, c)
		}
		if m.Reviewer {
			forReviewer = append(forReviewer, c)
		}
	}
	toReviewer := false
	if line := reviewstore.NotifyLine(forReviewer); line != "" {
		s.notifyReviewer(projectRoot, head, line)
		toReviewer = true
	}
	line := reviewstore.NotifyLine(forHead)
	if line == "" {
		return nil, toReviewer
	}
	if !s.notifyHead(ctx, projectRoot, head.ID, notifyAlways, reasonReviewComments, line) {
		return nil, toReviewer
	}
	return &line, toReviewer
}

// notifyReviewer delivers a line to the head's review slot, STARTING one if it is
// not already running.
//
// Starting it was the open question, and the answer turned on what a mention
// actually is. An accidental spawn would be indefensible - a slot costs a
// checkout, a sandbox and a model session - but `@review` is not an accident: it
// is a person typing the reviewer's name to address it, which is the same
// intent as clicking the Review tab and should not do less. (An AGENT's comment
// still never routes, so no agent can spawn one by writing the word.)
//
// The start is asynchronous. Spawning a sandbox takes seconds and the caller is
// answering an HTTP request, so the publish returns immediately and the message
// follows when the session is up. A failure is logged and dropped: the comment is
// durable either way, and the reviewer reads it with get_review_comments the
// moment it is next opened.
func (s *Server) notifyReviewer(projectRoot string, head heads.Head, line string) {
	slot := heads.ReviewSessionID(head.ID)
	if s.Sessions.IsLive(slot) {
		if !s.sendReviewerNotice(projectRoot, slot, line) {
			log.Printf("warn: notify reviewer %s: not delivered", slot)
		}
		return
	}
	go func() {
		rows, cols := heads.LoadResumeSize(s.DB, projectRoot, head.ID)
		if _, err := heads.StartReviewSession(s.Sessions, projectRoot, head, rows, cols); err != nil {
			log.Printf("warn: @review could not start a reviewer for %s: %v", head.ID, err)
			return
		}
		// A just-started Claude is not ready for stdin the instant Start returns;
		// it has to come up and read its system prompt first. Retry briefly rather
		// than writing into a pipe nobody is reading yet.
		for range 20 {
			if s.sendReviewerNotice(projectRoot, slot, line) {
				return
			}
			time.Sleep(500 * time.Millisecond)
		}
		log.Printf("warn: @review started a reviewer for %s but could not deliver the notice", head.ID)
	}()
}

// sendReviewerNotice delivers one automated line to a review slot as a user turn,
// through the same chat queue a typed message goes through.
//
// Not a bare SendChatUser, which is what this was and which got two things wrong
// at once. The queue APPENDS THE CHAT EVENT as it writes, so the bubble lands at
// the point in the transcript where it was sent; writing straight to stdin left
// the transcript to learn about the message from the CLI's own echo, which arrives
// whenever the CLI next takes a turn - so notices sent to an idle reviewer all
// surfaced in a clump at the bottom, in the wrong order and long after the fact.
// And the queue carries the ORIGIN, which is what makes the bubble render as
// Hydra's (the sky-dashed "Sent by Hydra" marker) rather than as something the
// user typed. The `[Hydra]` text prefix stays for the model, which never sees
// metadata.
func (s *Server) sendReviewerNotice(projectRoot, slot, line string) bool {
	content := claudestream.TextUserContent(autoPrefix + line)
	if s.ChatQueues == nil {
		return s.Sessions.SendChatUser(slot, content) == nil
	}
	// Never queued: a reviewer mid-turn takes the message at its next step
	// boundary, and holding it would strand it if that turn is the last one.
	return s.ChatQueues.Submit(projectRoot, slot, heads.QueuedMessage{
		ID:      fmt.Sprintf("hydra-input-%d", agentInputSeq.Add(1)),
		Content: content,
		Origin:  string(reasonReviewMention),
	}, false)
}

// ResolveReviewComment marks a comment dealt with, whichever origin it came from.
//
// One endpoint for both because the numbering is one sequence: from the user's
// side "#7 is handled" is the same action whether #7 was left in Hydra or on the
// PR, and making them two buttons in one gutter would put the storage layout in
// front of the person using it.
func (s *Server) ResolveReviewComment(ctx context.Context, request api.ResolveReviewCommentRequestObject) (api.ResolveReviewCommentResponseObject, error) {
	projectRoot, head, errResp := s.reviewThreadHead(ctx, request.ProjectId, request.AgentId)
	if errResp != nil {
		return api.ResolveReviewComment404JSONResponse(*errResp), nil
	}
	resolved := request.Body.Resolved
	if _, err := reviewstore.SetResolved(projectRoot, head.ID, request.Number, resolved); err == nil {
		s.notifyAgentsChanged(projectRoot, false)
		return api.ResolveReviewComment200JSONResponse(commentsResponse(projectRoot, head.ID, nil)), nil
	} else if !errors.Is(err, reviewstore.ErrNoComment) {
		return resolveCommentBadRequest(err.Error()), nil
	}
	// Not one of ours: the number may name a forge note, in which case what gets
	// resolved is the THREAD it belongs to - a single note is not a unit anyone
	// resolves.
	_, ref, ok := reviewstore.ForgeRef(projectRoot, head.ID, request.Number)
	if !ok || ref.Thread == "" {
		return resolveCommentBadRequest("no comment or thread has that number"), nil
	}
	if err := reviewstore.SetThreadResolved(projectRoot, head.ID, ref.Thread, resolved, time.Now().Format(time.RFC3339)); err != nil {
		return resolveCommentBadRequest(err.Error()), nil
	}
	s.notifyAgentsChanged(projectRoot, false)
	return api.ResolveReviewComment200JSONResponse(commentsResponse(projectRoot, head.ID, nil)), nil
}

// MarkReviewCommentsRead records what the user has seen.
func (s *Server) MarkReviewCommentsRead(ctx context.Context, request api.MarkReviewCommentsReadRequestObject) (api.MarkReviewCommentsReadResponseObject, error) {
	projectRoot, head, errResp := s.reviewThreadHead(ctx, request.ProjectId, request.AgentId)
	if errResp != nil {
		return api.MarkReviewCommentsRead404JSONResponse(*errResp), nil
	}
	var numbers []int
	if request.Body != nil && request.Body.Numbers != nil {
		numbers = *request.Body.Numbers
	}
	if len(numbers) == 0 {
		// "Mark everything read" covers the forge notes too, which are not in our
		// store - so it has to come from the numbering, not from the comment list.
		for _, c := range reviewstore.LoadComments(projectRoot, head.ID) {
			numbers = append(numbers, c.Number)
		}
		numbers = append(numbers, reviewstore.AllNumbers(projectRoot, head.ID)...)
	}
	read := request.Body == nil || request.Body.Unread == nil || !*request.Body.Unread
	if err := reviewstore.MarkRead(projectRoot, head.ID, numbers, read); err != nil {
		log.Printf("warn: review comments: mark read for %s: %v", head.ID, err)
	}
	s.notifyAgentsChanged(projectRoot, false)
	return api.MarkReviewCommentsRead200JSONResponse(commentsResponse(projectRoot, head.ID, nil)), nil
}

// Resolving does NOT notify the head, deliberately, and it used to.
//
// The argument for it was narrow and turned out to be wrong in practice: "you
// are working on #3 right now and I have just cancelled it" is worth a turn, so
// a resolve fired a notice at a WORKING head. But the far commoner resolver is
// now the head itself - an agent that finished #3 calls resolve_review_comments
// (see resolveHydraComments) - and a head is always "working" while it is doing
// that, so the notice was a message the agent had just caused itself to receive,
// arriving mid-turn, telling it to stop doing the thing it had already finished.
// A user resolving by hand hits the same path and is rarely doing it to
// interrupt.
//
// Nothing is lost by dropping it: the resolve is durable the moment it is
// written, and reviewstore.OpenComments filters resolved ones out - so the next
// time the agent reads its comments, for any reason, #3 is simply not there.

func commentsResponse(projectRoot, headID string, notified *string) api.ReviewCommentsResponse {
	stored := reviewstore.LoadComments(projectRoot, headID)
	read := reviewstore.ReadSet(projectRoot, headID)
	out := api.ReviewCommentsResponse{
		Comments: make([]api.ReviewComment, 0, len(stored)),
		Notified: notified,
	}
	// Hydra has no accounts, so "you" is whoever git says you are. It is the only
	// name available for a comment that never went near a forge, and it is the
	// right one - it is the name your commits already carry.
	if who := gitConfigVal(projectRoot, "user.name"); who != "" {
		out.You = &who
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
		ac.Image = imageAnchorToAPI(c.Image)
		setIf(&ac.PublishedAt, c.PublishedAt, c.PublishedAt != "")
		setIf(&ac.Resolved, c.Resolved, c.Resolved)
		setIf(&ac.ResolvedAt, c.ResolvedAt, c.ResolvedAt != "")
		setIf(&ac.Attachments, c.Attachments, len(c.Attachments) > 0)
		// A comment you wrote yourself is born read; anything an agent or a
		// reviewer left is not, which is what the unread dot is for.
		setIf(&ac.Read, true, read[c.Number] || c.Author == reviewstore.AuthorUser)
		out.Comments = append(out.Comments, ac)
	}
	return out
}

// imageAnchorFromAPI validates and converts a pin as it arrives from a browser.
//
// Strict rather than forgiving: a pin outside the picture, or one naming no file,
// is a client bug, and storing it would produce a comment that points at nothing
// and cannot be fixed later (published comments are immutable). Failing the write
// puts the mistake where it can be seen.
func imageAnchorFromAPI(in *api.ReviewImageAnchor) (*reviewstore.ImageAnchor, error) {
	if in == nil {
		return nil, nil
	}
	if strings.TrimSpace(in.File) == "" {
		return nil, errtrace.Wrap(fmt.Errorf("the pin names no file"))
	}
	out := &reviewstore.ImageAnchor{
		Script:   derefOr(in.Script, ""),
		Key:      derefOr(in.Key, ""),
		Side:     string(derefOr(in.Side, "")),
		File:     in.File,
		X:        float64(in.X),
		Y:        float64(in.Y),
		W:        float64(derefOr(in.W, 0)),
		H:        float64(derefOr(in.H, 0)),
		NaturalW: derefOr(in.NaturalW, 0),
		NaturalH: derefOr(in.NaturalH, 0),
		T:        float64(derefOr(in.T, 0)),
		Hash:     derefOr(in.Hash, ""),
	}
	// A slice, not a map: two bad coordinates should always name the same one
	// first, or the same mistake reports differently each time it is made.
	for _, f := range []struct {
		name string
		v    float64
	}{{"x", out.X}, {"y", out.Y}, {"w", out.W}, {"h", out.H}} {
		if f.v < 0 || f.v > 1 {
			return nil, errtrace.Wrap(fmt.Errorf("the pin's %s is %g, which is outside the picture (positions are fractions of it)", f.name, f.v))
		}
	}
	return out, nil
}

// imageAnchorToAPI is the way back out, for the diff viewer to draw the pin.
func imageAnchorToAPI(in *reviewstore.ImageAnchor) *api.ReviewImageAnchor {
	if in == nil {
		return nil
	}
	out := &api.ReviewImageAnchor{File: in.File, X: float32(in.X), Y: float32(in.Y)}
	setIf(&out.Script, in.Script, in.Script != "")
	setIf(&out.Key, in.Key, in.Key != "")
	setIf(&out.Side, api.ReviewImageAnchorSide(in.Side), in.Side != "")
	setIf(&out.W, float32(in.W), in.W > 0)
	setIf(&out.H, float32(in.H), in.H > 0)
	setIf(&out.NaturalW, in.NaturalW, in.NaturalW > 0)
	setIf(&out.NaturalH, in.NaturalH, in.NaturalH > 0)
	setIf(&out.T, float32(in.T), in.T > 0)
	setIf(&out.Hash, in.Hash, in.Hash != "")
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

func resolveCommentBadRequest(detail string) api.ResolveReviewComment400JSONResponse {
	return api.ResolveReviewComment400JSONResponse{Code: 400, Error: api.ErrorResponseErrorBadRequest, Details: detail}
}

func publishCommentsBadRequest(detail string) api.PublishReviewComments400JSONResponse {
	return api.PublishReviewComments400JSONResponse{Code: 400, Error: api.ErrorResponseErrorBadRequest, Details: detail}
}

// unreadCommentCount is how many review comments on a head the user has not seen,
// for the badge on its card. Nil when there are none, so the field is absent
// rather than a zero the client has to special-case.
//
// It covers BOTH origins - a forge reviewer's remark is as much news as an
// agent's - which is why it counts from the numbering rather than from the comment
// store alone. Cheap enough for the agent-list poll: two small reads, and only for
// heads that have ever been commented on (the sidecar is absent otherwise).
func unreadCommentCount(projectRoot, headID string) *int {
	if projectRoot == "" || headID == "" {
		return nil
	}
	read := reviewstore.ReadSet(projectRoot, headID)
	n := 0
	for _, c := range reviewstore.PublishedComments(projectRoot, headID) {
		// Your own comments are never news to you.
		if c.Author != reviewstore.AuthorUser && !read[c.Number] {
			n++
		}
	}
	for _, number := range reviewstore.AllNumbers(projectRoot, headID) {
		if !read[number] {
			n++
		}
	}
	if n == 0 {
		return nil
	}
	return &n
}

// openCommentCount is how much of the review is still OUTSTANDING on a head -
// unresolved comments across both origins - for the count on its card. Nil when
// there are none, like the unread count beside it.
//
// A different question from unread, and worth its own number precisely because
// the two disagree in both directions: a comment you have read is still work, and
// a comment you left yourself was never unread but is certainly outstanding. The
// unread badge alone therefore said "nothing new" on a head with six open remarks
// on it, which reads as "nothing to do".
//
// A REPLY is not counted. A thread is one piece of work however long the
// conversation under it gets, and counting replies would make an argument look
// like a backlog.
func openCommentCount(projectRoot, headID string) *int {
	if projectRoot == "" || headID == "" {
		return nil
	}
	n := 0
	for _, c := range reviewstore.OpenComments(projectRoot, headID) {
		if c.ReplyTo == 0 {
			n++
		}
	}
	// The forge notes live in the sidecar rather than the comment store, and
	// resolve by THREAD - so count threads, not notes, and only the ones Hydra's
	// local overlay has not marked done.
	seen := map[string]bool{}
	for _, ref := range reviewstore.ForgeThreads(projectRoot, headID) {
		if ref == "" || seen[ref] {
			continue
		}
		seen[ref] = true
		if !reviewstore.ThreadResolved(projectRoot, headID, ref) {
			n++
		}
	}
	if n == 0 {
		return nil
	}
	return &n
}
