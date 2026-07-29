package reviewstore

// Hydra's own review comments: durable, numbered, anchored to a line of a head's
// diff, and readable by agents through tools rather than pasted into their
// context (docs/review-agent.md).
//
// This is the half the "Comment to agent" flow was missing. Before it, a comment
// was formatted into a markdown blob and injected into the agent's transcript,
// where it could not be re-read, re-anchored, or survive a compaction - and the
// unsent batch lived in localStorage, so it died on a reload and never left the
// browser it was typed in.
//
// Four properties are load-bearing:
//
//   - A number, not a UUID. These ids are read and typed back by a language
//     model, and said aloud by a person ("fix #3"). `#3` is one token and hard to
//     corrupt; a 36-character UUID is neither. Numbers are per-head, assigned in
//     order, and NEVER reused - a retired number stays retired, because "#3" has
//     to mean one thing forever.
//   - Draft or published, as a field rather than a second store. Publishing is
//     then a state transition instead of a copy between systems, and there is
//     exactly one thing to query. A draft is invisible to every agent-facing
//     read: half-written thoughts are not instructions.
//   - Published is append-only. A thread becomes an audit log rather than
//     something an agent (or a later edit) can quietly rewrite, and there is no
//     conflict resolution to get wrong. Drafts stay freely editable - that is
//     what a draft is - and immutability starts at publish.
//   - The anchor is frozen at write time (commit, path, line, side, hunk hash,
//     context block). The diff moves; a comment that re-derived its context would
//     silently start describing different code.
//
// The store is a single JSON array per head, rewritten whole. That is sound here
// for the same reason the notes file is: every writer goes through the daemon (the
// browser over HTTP, agents over reviewq), so there is one process appending.

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/paths"
)

// Comment status. A comment is exactly one of these; there is no third state and
// no way back from published.
const (
	StatusDraft     = "draft"
	StatusPublished = "published"
)

// Who wrote a comment. AuthorAgent is shared with the local-note store above; a
// reviewer writes as AuthorReviewer so the UI can tell "your reviewer said this"
// from "the head said this", which are very different claims.
const (
	AuthorUser     = "user"
	AuthorReviewer = "reviewer"
)

// Comment is one durable review comment on a head.
//
// Number is the handle everything else uses (`#4`); ReplyTo makes a comment a
// reply to another, which is how a thread forms without a separate thread object.
type Comment struct {
	Number  int    `json:"number"`
	Status  string `json:"status"`
	Author  string `json:"author"`
	Body    string `json:"body"`
	ReplyTo int    `json:"reply_to,omitempty"`

	// The anchor, frozen when the comment was written. Line is on the new side
	// unless OldSide is set, matching how the diff viewer numbers its gutters.
	Path    string `json:"path,omitempty"`
	Line    int    `json:"line,omitempty"`
	OldSide bool   `json:"old_side,omitempty"`
	// Commit is the head commit the comment was written against, and Diff is the
	// human-readable comparison it was written on ("main -> abc1234"). Both are
	// recorded so a later reader can tell WHEN the observation was true.
	Commit string `json:"commit,omitempty"`
	Diff   string `json:"diff,omitempty"`
	// Context is the fenced ```diff block of the surrounding lines, and HunkHash
	// the hash of the anchoring hunk, so staleness is detectable without the
	// original diff still existing.
	Context  string `json:"context,omitempty"`
	HunkHash string `json:"hunk_hash,omitempty"`

	CreatedAt   string `json:"created_at"`
	PublishedAt string `json:"published_at,omitempty"`
}

// IsDraft reports whether a comment is still invisible to agents.
func (c Comment) IsDraft() bool { return c.Status != StatusPublished }

// Anchor renders a comment's location the way it is quoted to an agent:
// "web/src/DiffViewer.tsx:1204", or "" for a comment anchored to nothing.
func (c Comment) Anchor() string {
	if c.Path == "" {
		return ""
	}
	if c.Line <= 0 {
		return c.Path
	}
	return fmt.Sprintf("%s:%d", c.Path, c.Line)
}

// Label is a comment's handle as it is written for a human or a model: "#4".
func (c Comment) Label() string { return fmt.Sprintf("#%d", c.Number) }

// LoadComments returns a head's comments, oldest first. A missing store is not an
// error - it means nobody has commented yet.
func LoadComments(projectRoot, id string) []Comment {
	data, err := os.ReadFile(paths.GetReviewCommentsJson(projectRoot, id))
	if err != nil {
		return nil
	}
	var out []Comment
	if err := json.Unmarshal(data, &out); err != nil {
		return nil
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Number < out[j].Number })
	return out
}

// PublishedComments returns only what an agent may see. Every agent-facing read
// goes through this rather than filtering at the call site, so a new caller
// cannot leak drafts by forgetting to.
func PublishedComments(projectRoot, id string) []Comment {
	all := LoadComments(projectRoot, id)
	out := make([]Comment, 0, len(all))
	for _, c := range all {
		if !c.IsDraft() {
			out = append(out, c)
		}
	}
	return out
}

// FindComment returns the comment numbered n, if it exists.
func FindComment(projectRoot, id string, n int) (Comment, bool) {
	for _, c := range LoadComments(projectRoot, id) {
		if c.Number == n {
			return c, true
		}
	}
	return Comment{}, false
}

// AppendComment stores a new comment, assigning its number and timestamps, and
// returns it as stored.
//
// The number is one past the highest EVER used, not one past the current count,
// so deleting a draft cannot hand its number to a different comment later.
func AppendComment(projectRoot, id string, c Comment) (Comment, error) {
	all := LoadComments(projectRoot, id)
	next := 1
	for _, existing := range all {
		if existing.Number >= next {
			next = existing.Number + 1
		}
	}
	// A number is retired the moment it is handed out, so a deleted draft's number
	// must not come back. The high-water mark records that independently of what
	// the list still contains.
	if hw := loadHighWater(projectRoot, id); hw >= next {
		next = hw + 1
	}
	now := time.Now().Format(time.RFC3339)
	c.Number = next
	if c.Status != StatusPublished {
		c.Status = StatusDraft
	} else if c.PublishedAt == "" {
		c.PublishedAt = now
	}
	if c.Author == "" {
		c.Author = AuthorUser
	}
	c.CreatedAt = now
	c.Body = strings.TrimSpace(c.Body)
	if err := saveComments(projectRoot, id, append(all, c)); err != nil {
		return Comment{}, errtrace.Wrap(err)
	}
	if err := saveHighWater(projectRoot, id, next); err != nil {
		return Comment{}, errtrace.Wrap(err)
	}
	return c, nil
}

// ErrNotDraft is returned when a caller tries to change a published comment.
// Published is immutable on purpose: it is what makes a thread an audit log
// rather than something that can be rewritten after the fact.
var ErrNotDraft = fmt.Errorf("a published comment cannot be edited or deleted")

// ErrNoComment is returned for a number that names nothing.
var ErrNoComment = fmt.Errorf("no such comment")

// UpdateDraft replaces a draft's body. Published comments are refused.
func UpdateDraft(projectRoot, id string, n int, body string) (Comment, error) {
	all := LoadComments(projectRoot, id)
	for i, c := range all {
		if c.Number != n {
			continue
		}
		if !c.IsDraft() {
			return Comment{}, errtrace.Wrap(ErrNotDraft)
		}
		all[i].Body = strings.TrimSpace(body)
		if err := saveComments(projectRoot, id, all); err != nil {
			return Comment{}, errtrace.Wrap(err)
		}
		return all[i], nil
	}
	return Comment{}, errtrace.Wrap(ErrNoComment)
}

// DeleteDraft drops an unpublished comment. Its number is not reused.
func DeleteDraft(projectRoot, id string, n int) error {
	all := LoadComments(projectRoot, id)
	for i, c := range all {
		if c.Number != n {
			continue
		}
		if !c.IsDraft() {
			return errtrace.Wrap(ErrNotDraft)
		}
		return errtrace.Wrap(saveComments(projectRoot, id, append(all[:i:i], all[i+1:]...)))
	}
	return errtrace.Wrap(ErrNoComment)
}

// PublishDrafts flips the named drafts (or every draft, when numbers is empty) to
// published, and returns them in number order. Already-published comments named
// explicitly are skipped rather than erroring - publishing twice is the same
// request made twice, not a mistake.
func PublishDrafts(projectRoot, id string, numbers []int) ([]Comment, error) {
	want := map[int]bool{}
	for _, n := range numbers {
		want[n] = true
	}
	all := LoadComments(projectRoot, id)
	now := time.Now().Format(time.RFC3339)
	var published []Comment
	for i, c := range all {
		if !c.IsDraft() || (len(want) > 0 && !want[c.Number]) {
			continue
		}
		if c.Body == "" {
			continue // an empty draft is not a comment
		}
		all[i].Status = StatusPublished
		all[i].PublishedAt = now
		published = append(published, all[i])
	}
	if len(published) == 0 {
		return nil, nil
	}
	if err := saveComments(projectRoot, id, all); err != nil {
		return nil, errtrace.Wrap(err)
	}
	return published, nil
}

func saveComments(projectRoot, id string, all []Comment) error {
	sort.SliceStable(all, func(i, j int) bool { return all[i].Number < all[j].Number })
	data, err := json.Marshal(all)
	if err != nil {
		return errtrace.Wrap(err)
	}
	return errtrace.Wrap(writeJSON(paths.GetReviewCommentsJson(projectRoot, id), data))
}

// The high-water mark of numbers handed out for a head, kept beside the store so
// a deleted draft's number stays retired. A tiny file rather than a field on the
// list because the list is the thing that loses the evidence.
type highWater struct {
	Last int `json:"last"`
}

func highWaterPath(projectRoot, id string) string {
	return paths.GetReviewCommentsJson(projectRoot, id+".seq")
}

func loadHighWater(projectRoot, id string) int {
	data, err := os.ReadFile(highWaterPath(projectRoot, id))
	if err != nil {
		return 0
	}
	var hw highWater
	if err := json.Unmarshal(data, &hw); err != nil {
		return 0
	}
	return hw.Last
}

func saveHighWater(projectRoot, id string, n int) error {
	data, err := json.Marshal(highWater{Last: n})
	if err != nil {
		return errtrace.Wrap(err)
	}
	return errtrace.Wrap(writeJSON(highWaterPath(projectRoot, id), data))
}

// RenderForAgent formats comments the way an agent reads them from a tool: the
// handle, where it points, who wrote it, the body, and the frozen diff context.
// Deliberately the same shape whether one comment or twenty came back, so a model
// never has to parse two layouts.
func RenderForAgent(comments []Comment, withContext bool) string {
	if len(comments) == 0 {
		return "No review comments on this head yet."
	}
	var b strings.Builder
	for i, c := range comments {
		if i > 0 {
			b.WriteString("\n")
		}
		fmt.Fprintf(&b, "%s", c.Label())
		if anchor := c.Anchor(); anchor != "" {
			fmt.Fprintf(&b, " %s", anchor)
		}
		if c.ReplyTo > 0 {
			fmt.Fprintf(&b, " (reply to #%d)", c.ReplyTo)
		}
		fmt.Fprintf(&b, " - %s", c.Author)
		if c.Diff != "" {
			fmt.Fprintf(&b, ", on %s", c.Diff)
		}
		b.WriteString("\n")
		if withContext && c.Context != "" {
			b.WriteString(c.Context)
			if !strings.HasSuffix(c.Context, "\n") {
				b.WriteString("\n")
			}
		}
		b.WriteString(c.Body)
		b.WriteString("\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

// NotifyLine is the one short line an agent is told when comments are published:
// the handles and where they point, and nothing else. This is the whole point of
// numbering - six comments cost one line instead of six diff excerpts, the
// transcript holds a pointer that cannot drift from the comment, and an id
// survives a compaction where an injected blob does not.
//
// The path:line is redundant with the fetch and included anyway: it is nearly
// free, and it lets the agent decide whether a comment is worth fetching at all.
func NotifyLine(comments []Comment) string {
	if len(comments) == 0 {
		return ""
	}
	parts := make([]string, 0, len(comments))
	for _, c := range comments {
		if anchor := c.Anchor(); anchor != "" {
			parts = append(parts, fmt.Sprintf("%s (%s)", c.Label(), anchor))
		} else {
			parts = append(parts, c.Label())
		}
	}
	noun := "comments"
	if len(comments) == 1 {
		noun = "comment"
	}
	return fmt.Sprintf("Review %s added: %s. Read them with the get_review_comments tool (they are not repeated here).",
		noun, strings.Join(parts, ", "))
}
