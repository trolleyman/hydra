package http

// One way to tell a head something.
//
// The sources keep multiplying - review comments published, a comment resolved,
// a test run gone red - and each one arrived wanting its own debounce, its own
// "is it busy?" check and its own wording. They do not need their own anything:
// they need the same four rules, applied in one place, so the fifth source cannot
// get them subtly wrong.
//
//  1. Fire on a TRANSITION, never on a poll tick. That is the caller's job, and
//     it is why every caller here dedupes before it gets this far.
//  2. BATCH. A run of clicks is one message, not one model turn each.
//  3. Respect what the head is DOING - see notifyWhen, which is the part that is
//     not obvious.
//  4. Send ONE SHORT LINE and let the agent pull the detail with a tool it already
//     has. The comment, the log, the diff are canonical; the message is a pointer
//     to them. Six comments cost one line, not six excerpts, and a line survives a
//     compaction that a pasted blob does not.
//
// Rule 3 reads like "never interrupt", and that is nearly right: new information
// waits until the head is idle so it never lands mid-thought, while something the
// user just did on purpose goes now and joins the running turn.
//
// There used to be a third mode, notifyWorking - send ONLY while the head is
// busy, for a cancellation ("stop, #3 is dealt with"). It had exactly one caller,
// the review-resolve notice, and it is gone: the commonest resolver turned out to
// be the head itself, so the notice was a message an agent had just caused itself
// to receive, telling it to stop doing what it had already finished (see
// review_comments.go). Re-add the mode if a real cancellation source ever turns
// up; do not re-add it for bookkeeping the agent can read from the store.

import (
	"context"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/heads"
)

// notifyWhen gates a notice on what the head is doing.
type notifyWhen int

const (
	// notifyAlways: send it now whatever the head is up to. For something the USER
	// just did on purpose and expects to land - publishing review comments. A
	// chat head steers a mid-turn message in at its next step boundary, so this
	// does not corrupt a running turn; it joins it.
	notifyAlways notifyWhen = iota
	// notifyIdle: new information the head did not ask for (a test went red).
	// Waits until it is not mid-turn, so it never interrupts.
	notifyIdle
)

// notifyReason is the machine tag that rides with a notice to the UI, so the chat
// can say WHY a message it did not type appeared. Kept short and stable; the
// human wording lives in the client.
type notifyReason string

const (
	reasonReviewComments notifyReason = "review_comments"
	reasonTestsFailed    notifyReason = "tests_failed"
	// The reviewer's own: someone typed @review in a comment. A separate tag from
	// review_comments because it lands in a different transcript and answers a
	// different "why is this here?" - the reviewer was addressed by name.
	reasonReviewMention notifyReason = "review_mention"
)

// autoPrefix marks a message as Hydra's rather than the user's, in the TEXT.
//
// The UI gets a metadata field for this, but an agent never sees metadata - it
// sees a user turn and nothing else - so without a prefix it cannot tell a
// notification from something the user typed. Both, therefore: the prefix is for
// the model, the metadata is for you.
const autoPrefix = "`[Hydra]` "

// notifyHead delivers one line to a head, subject to its gate. Reports whether it
// was sent, which the callers use only for logging - a notice that was gated out
// is not a failure, it is the design.
func (s *Server) notifyHead(ctx context.Context, projectRoot, headID string, when notifyWhen, reason notifyReason, text string) bool {
	if strings.TrimSpace(text) == "" {
		return false
	}
	working := s.headIsWorking(projectRoot, headID)
	if when == notifyIdle && working {
		return false
	}
	// By ROOT, not by project id: this is the one place every automated notice
	// funnels through, and it holds a root. Going through the HTTP handler instead
	// meant putting a path in the id field, which resolved to nothing and made
	// every notice a logged 404 - see sendAgentInput.
	if err := s.sendAgentInput(ctx, projectRoot, headID, autoPrefix+text, string(reason)); err != nil {
		log.Printf("warn: notify %s (%s): %v", headID, reason, err)
		return false
	}
	return true
}

// headIsWorking reports whether a head is mid-turn, read from the status its own
// hooks write.
func (s *Server) headIsWorking(projectRoot, headID string) bool {
	info := heads.ReadAgentStatus(projectRoot, headID)
	return info != nil && (info.Status == api.Running || info.Status == api.Starting)
}

// notifyBatcher collects notices per head for a short window so a burst of user
// actions costs one message. Rule 2, made reusable: every source that can fire
// several times in a row needs it, and each one hand-rolling a timer is how they
// drift apart.
type notifyBatcher struct {
	mu      sync.Mutex
	pending map[string][]string
	timer   map[string]*time.Timer
	delay   time.Duration
}

func newNotifyBatcher(delay time.Duration) *notifyBatcher {
	return &notifyBatcher{pending: map[string][]string{}, timer: map[string]*time.Timer{}, delay: delay}
}

// add queues one item for a head and (re)arms the window. When it closes, flush
// gets every item collected, and is responsible for re-checking the gate - a head
// that finished while we were batching must not be sent a cancellation.
func (b *notifyBatcher) add(headID, item string, flush func(items []string)) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.pending[headID] = append(b.pending[headID], item)
	if t := b.timer[headID]; t != nil {
		t.Stop()
	}
	b.timer[headID] = time.AfterFunc(b.delay, func() {
		b.mu.Lock()
		items := b.pending[headID]
		delete(b.pending, headID)
		delete(b.timer, headID)
		b.mu.Unlock()
		if len(items) > 0 {
			flush(items)
		}
	})
}

// plural renders "1 comment" / "3 comments" without a helper per call site.
func plural(n int, one, many string) string {
	if n == 1 {
		return fmt.Sprintf("%d %s", n, one)
	}
	return fmt.Sprintf("%d %s", n, many)
}
