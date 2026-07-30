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
	"math"
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

	// Image pins the comment to a point on a PICTURE instead of a line of a diff.
	// Set for a comment left on an artifact in the lightbox; nil for every comment
	// on code, which is why it is a pointer rather than a zero value to test.
	Image *ImageAnchor `json:"image,omitempty"`

	CreatedAt   string `json:"created_at"`
	PublishedAt string `json:"published_at,omitempty"`

	// Resolved is a state change, not an edit of content, so it does not break the
	// append-only rule: the body stays exactly as written and a reader can still
	// see what was said. It is what turns a long review from a wall into a
	// worklist - and what the next/previous navigation steps through.
	Resolved   bool   `json:"resolved,omitempty"`
	ResolvedAt string `json:"resolved_at,omitempty"`
}

// ImageAnchor pins a comment to a point - or a box - on a generated artifact,
// the way Path/Line pin one to a diff. "The button is 3px off" is a remark about
// a place in a picture, and a comment that can only say which FILE it is about
// makes the reader hunt for what was meant.
//
// Three things about the shape are load-bearing:
//
//   - The position is stored NORMALIZED (0..1 of the image's width and height),
//     because the same picture is laid out at different sizes and pixel densities
//     depending on the pane it is in, and a fraction is the only form that
//     survives that. NaturalW/NaturalH are kept alongside so real pixels can be
//     recovered exactly - which is the form an agent should be told, because a
//     model reasons about "514,697" far better than about "34%,71%".
//   - Key is the artifact cache key of the SIDE the pin is on, verbatim from
//     internal/artifacts: "commit/<sha>" or "worktree/<content-hash>". It answers
//     "which commit was this?" - the question that decides whether an observation
//     still stands - and it answers it honestly, because the diff viewer routinely
//     renders one side from the UNCOMMITTED working tree, where reporting a sha
//     would send a reader to code that is not what they are looking at. It doubles
//     as the entry's path on disk, so the same field also locates the file.
//   - Hash is the file's content hash when the pin was placed, so a regenerated
//     artifact can be detected as having moved under the comment - the picture's
//     HunkHash.
type ImageAnchor struct {
	// Script is the [artifacts.<name>] table the picture came from, File the
	// output's name within it ("home-dark.png"), and Side which half of the
	// comparison was pinned ("left" or "right").
	Script string `json:"script,omitempty"`
	Key    string `json:"key,omitempty"`
	Side   string `json:"side,omitempty"`
	File   string `json:"file"`

	// X and Y are the pin, as fractions of the image's width and height. W and H
	// make it a box instead of a point when both are above zero - a click places a
	// point, a drag places a box, and most remarks are one or the other.
	X float64 `json:"x"`
	Y float64 `json:"y"`
	W float64 `json:"w,omitempty"`
	H float64 `json:"h,omitempty"`

	// NaturalW and NaturalH are the picture's own pixel dimensions, so the
	// fractions above can be turned back into the pixels a person (or a model)
	// would measure. Zero when they could not be determined, in which case the
	// pixel forms are simply left out rather than guessed.
	NaturalW int `json:"natural_w,omitempty"`
	NaturalH int `json:"natural_h,omitempty"`

	// T is the moment in a VIDEO artifact the pin was placed at, in seconds from
	// the start. A recording has a time axis as well as two spatial ones, and
	// "the button flashes here" is about a frame, not about the whole clip - so a
	// pin without it would send the reader to hunt through the run. Zero (and
	// absent) for a still picture, which is why it is a plain float rather than a
	// pointer: second zero of a clip is the first frame, and a pin there is
	// indistinguishable from no timestamp only for a still, where the field is
	// meaningless anyway.
	T float64 `json:"t,omitempty"`

	Hash string `json:"hash,omitempty"`
}

// Artifact cache-key kinds, mirroring internal/artifacts.versionKey. Duplicated
// rather than imported: this package is a leaf that the artifact manager itself
// has no business depending on, and the two constants are part of the on-disk
// format either way.
const (
	keyKindCommit   = "commit"
	keyKindWorktree = "worktree"
)

// IsBox reports whether the anchor covers a region rather than naming a point.
func (a ImageAnchor) IsBox() bool { return a.W > 0 && a.H > 0 }

// Pixels converts the normalized anchor back to the picture's own pixels, and
// reports false when the natural size is unknown - in which case there is no
// honest pixel answer and callers should show the percentages instead.
func (a ImageAnchor) Pixels() (x, y, w, h int, ok bool) {
	if a.NaturalW <= 0 || a.NaturalH <= 0 {
		return 0, 0, 0, 0, false
	}
	return int(math.Round(a.X * float64(a.NaturalW))), int(math.Round(a.Y * float64(a.NaturalH))),
		int(math.Round(a.W * float64(a.NaturalW))), int(math.Round(a.H * float64(a.NaturalH))), true
}

// Where is the anchor's short form, as it appears in a notification: the file and
// the spot, and nothing else. Kept short on purpose - NotifyLine's whole reason
// for existing is that six comments cost one line.
func (a ImageAnchor) Where() string {
	if a.T > 0 {
		return fmt.Sprintf("%s @ %.0f%%,%.0f%% at %s", a.File, a.X*100, a.Y*100, FormatTimecode(a.T))
	}
	return fmt.Sprintf("%s @ %.0f%%,%.0f%%", a.File, a.X*100, a.Y*100)
}

// FormatTimecode renders a moment in a clip as m:ss.t - short enough for a
// notification line, precise enough to scrub to. Deliberately not h:mm:ss: these
// are UI recordings of a few seconds, and padding every one of them with an hour
// field would cost more than the rare long clip saves.
func FormatTimecode(sec float64) string {
	if sec < 0 {
		sec = 0
	}
	// Round to tenths FIRST, then split. Splitting first and rounding the seconds
	// afterwards lets the rounding carry past 60 without the minute ever seeing
	// it, so 59.96s renders as "0:60.0" instead of "1:00.0".
	tenths := int(math.Round(sec * 10))
	return fmt.Sprintf("%d:%02d.%d", tenths/600, tenths%600/10, tenths%10)
}

// Position is the precise form, for a reader who has already decided to look:
// pixels when the natural size is known, with the box's size when it is a box.
func (a ImageAnchor) Position() string {
	x, y, w, h, ok := a.Pixels()
	if !ok {
		if a.IsBox() {
			return fmt.Sprintf("%.1f%%,%.1f%%, %.1f%% x %.1f%%", a.X*100, a.Y*100, a.W*100, a.H*100)
		}
		return fmt.Sprintf("%.1f%%,%.1f%%", a.X*100, a.Y*100)
	}
	if a.IsBox() {
		return fmt.Sprintf("%d,%d px, %dx%d px, in a %dx%d image", x, y, w, h, a.NaturalW, a.NaturalH)
	}
	return fmt.Sprintf("%d,%d px, in a %dx%d image", x, y, a.NaturalW, a.NaturalH)
}

// Version says which state of the tree the picture was rendered from, in the
// words that tell a reader what they may do with it.
//
// A commit is named, because it can be checked out and diffed against. A working
// tree is NOT given a sha - it never had one - and saying so plainly is the point:
// an agent told "abc1234" for a picture rendered from uncommitted changes will
// reason confidently about code that was never what it saw. The state hash is
// included so two working-tree renders can at least be told apart.
func (a ImageAnchor) Version() string {
	kind, id, found := strings.Cut(a.Key, "/")
	if !found {
		return a.Key
	}
	if len(id) > 12 {
		id = id[:12]
	}
	switch kind {
	case keyKindCommit:
		return id
	case keyKindWorktree:
		return fmt.Sprintf("the uncommitted working tree (state %s)", id)
	}
	return a.Key
}

// IsCommitted reports whether the picture came from a commit, and so whether
// git can be used to reason about what has changed since.
func (a ImageAnchor) IsCommitted() bool {
	kind, _, _ := strings.Cut(a.Key, "/")
	return kind == keyKindCommit
}

// IsDraft reports whether a comment is still invisible to agents.
func (c Comment) IsDraft() bool { return c.Status != StatusPublished }

// Anchor renders a comment's location the way it is quoted to an agent:
// "web/src/DiffViewer.tsx:1204", "home-dark.png @ 34%,71%" for a pin on a
// picture, or "" for a comment anchored to nothing.
func (c Comment) Anchor() string {
	if c.Image != nil {
		return c.Image.Where()
	}
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

// OpenComments is PublishedComments minus what has been resolved - the default
// agent-facing read, because "what is still being asked of me" is almost always
// the question, and a review that has been worked through should get cheaper to
// re-read, not more expensive.
func OpenComments(projectRoot, id string) []Comment {
	all := PublishedComments(projectRoot, id)
	out := make([]Comment, 0, len(all))
	for _, c := range all {
		if !c.Resolved {
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
	// The sequence is shared with the forge notes (see sidecar.go), so a head has
	// ONE numbering across every origin and "fix #3" is unambiguous. Raise the
	// counter past anything already in the list first, so a sidecar that was lost
	// or a store copied in from elsewhere cannot reissue a number in use.
	for _, existing := range all {
		noteHighWater(projectRoot, id, existing.Number)
	}
	next, err := allocNumber(projectRoot, id)
	if err != nil {
		return Comment{}, errtrace.Wrap(err)
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

// SetResolved marks a comment's whole thread resolved (or reopens it). A native
// thread is its root comment plus every reply descended from it; resolution is a
// property of that conversation, not of one message inside it. Accepting any
// member's number also keeps permalinks and agent tool calls unsurprising.
//
// Allowed on a PUBLISHED comment - and only meaningful there - because it is a
// state change rather than an edit of content: every body stays exactly as
// written and a reader can still see both what was said and that it was handled.
func SetResolved(projectRoot, id string, n int, resolved bool) (Comment, error) {
	all := LoadComments(projectRoot, id)
	byNumber := make(map[int]Comment, len(all))
	for _, c := range all {
		byNumber[c.Number] = c
	}
	target, ok := byNumber[n]
	if !ok {
		return Comment{}, errtrace.Wrap(ErrNoComment)
	}

	rootNumber := target.Number
	seen := map[int]bool{}
	for target.ReplyTo > 0 && !seen[target.Number] {
		seen[target.Number] = true
		parent, exists := byNumber[target.ReplyTo]
		if !exists {
			break
		}
		target = parent
		rootNumber = parent.Number
	}

	now := ""
	if resolved {
		now = time.Now().Format(time.RFC3339)
	}
	inThread := map[int]bool{rootNumber: true}
	changed := true
	for changed {
		changed = false
		for _, c := range all {
			if c.ReplyTo > 0 && inThread[c.ReplyTo] && !inThread[c.Number] {
				inThread[c.Number] = true
				changed = true
			}
		}
	}
	for i := range all {
		if !inThread[all[i].Number] {
			continue
		}
		all[i].Resolved = resolved
		all[i].ResolvedAt = now
	}
	if err := saveComments(projectRoot, id, all); err != nil {
		return Comment{}, errtrace.Wrap(err)
	}
	for _, c := range all {
		if c.Number == n {
			return c, nil
		}
	}
	return Comment{}, errtrace.Wrap(ErrNoComment)
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

// ArtifactPin names one artifact cache entry a review comment is anchored to.
type ArtifactPin struct {
	Script string
	Key    string
}

// PinnedArtifacts returns every artifact cache entry this project's review
// comments point at.
//
// It exists because a pin's whole value is that you can go back and look at what
// was pinned. The cache is pruned by age and size, so without this an artifact
// referenced by a comment is reclaimed like any other and the comment degrades to
// coordinates into a picture nobody can retrieve.
//
// Scans the comments DIRECTORY rather than taking a head list: comments outlive
// their head (an archived one keeps its store), and a caller that had to
// enumerate heads first would silently stop pinning the moment one was missed.
func PinnedArtifacts(projectRoot string) []ArtifactPin {
	entries, err := os.ReadDir(paths.GetReviewCommentsDir(projectRoot))
	if err != nil {
		return nil
	}
	seen := map[ArtifactPin]bool{}
	var out []ArtifactPin
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		id := strings.TrimSuffix(e.Name(), ".json")
		for _, c := range LoadComments(projectRoot, id) {
			if c.Image == nil || c.Image.Script == "" || c.Image.Key == "" {
				continue
			}
			p := ArtifactPin{Script: c.Image.Script, Key: c.Image.Key}
			if !seen[p] {
				seen[p] = true
				out = append(out, p)
			}
		}
	}
	return out
}

func saveComments(projectRoot, id string, all []Comment) error {
	sort.SliceStable(all, func(i, j int) bool { return all[i].Number < all[j].Number })
	data, err := json.Marshal(all)
	if err != nil {
		return errtrace.Wrap(err)
	}
	return errtrace.Wrap(writeJSON(paths.GetReviewCommentsJson(projectRoot, id), data))
}

// ImagePathFunc resolves an image comment to two absolute paths on this machine:
// the full picture it was pinned on, and the frozen close-up of what the pin
// points at. Either may be "" when it cannot be located - the artifact cache was
// cleared, or the comment predates crops.
//
// It takes the whole Comment rather than just the anchor because the crop is
// keyed by the comment's NUMBER, not by anything in the anchor. And it is a
// parameter rather than something this package works out for itself so that
// reviewstore stays a leaf: the layout belongs to internal/artifacts and
// internal/paths, and the caller that renders for an agent already has both.
type ImagePathFunc func(Comment) (picture, crop string)

// RenderForAgent formats comments the way an agent reads them from a tool: the
// handle, where it points, who wrote it, the body, and the frozen diff context.
// Deliberately the same shape whether one comment or twenty came back, so a model
// never has to parse two layouts.
//
// imagePath may be nil, in which case a pin on a picture still renders its
// position - just without telling the agent where to go and look at it.
func RenderForAgent(comments []Comment, withContext bool, imagePath ImagePathFunc) string {
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
		if c.Resolved {
			b.WriteString(" [resolved]")
		}
		fmt.Fprintf(&b, " - %s", c.Author)
		if c.Diff != "" {
			fmt.Fprintf(&b, ", on %s", c.Diff)
		}
		b.WriteString("\n")
		// A pin's detail is always included, unlike a diff block: two short lines,
		// and without them the comment says only which picture it was about, which
		// is the thing the anchor exists to improve on.
		if c.Image != nil {
			writeImageAnchor(&b, c, imagePath)
		}
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

// writeImageAnchor renders the detail lines under an image comment: where the
// picture is, where in it the pin was placed, and the close-up of that spot.
func writeImageAnchor(b *strings.Builder, c Comment, imagePath ImagePathFunc) {
	a := *c.Image
	where := a.File
	var crop string
	if imagePath != nil {
		picture, cr := imagePath(c)
		if picture != "" {
			where = picture
		}
		crop = cr
	}
	b.WriteString("image: ")
	b.WriteString(where)
	var about []string
	if a.Side != "" && a.Script != "" {
		about = append(about, fmt.Sprintf("%s side of the %s artifact", a.Side, a.Script))
	} else if a.Script != "" {
		about = append(about, "from the "+a.Script+" artifact")
	}
	if v := a.Version(); v != "" {
		about = append(about, "rendered from "+v)
	}
	if len(about) > 0 {
		fmt.Fprintf(b, " (%s)", strings.Join(about, ", "))
	}
	b.WriteString("\n")
	noun := "point"
	if a.IsBox() {
		noun = "box"
	}
	fmt.Fprintf(b, "%s: %s", noun, a.Position())
	// A recording's timestamp goes on the same line as the position, because
	// together they ARE the location - "34%,71%" in a clip means nothing without
	// the moment it is 34%,71% of.
	if a.T > 0 {
		fmt.Fprintf(b, ", at %s into the recording", FormatTimecode(a.T))
	}
	b.WriteString("\n")
	// The close-up is named SECOND and described as the cheaper read, because it
	// is: it shows the spot alone, at a few KB, where the full picture is a whole
	// screenshot the pin is one dot in. An agent that opens only one should open
	// this one.
	if crop != "" {
		fmt.Fprintf(b, "close-up of that spot: %s\n", crop)
	}
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
			parts = append(parts, fmt.Sprintf("%s [%s](%s)", c.Label(), anchor, anchor))
		} else {
			parts = append(parts, c.Label())
		}
	}
	noun := "comments"
	if len(comments) == 1 {
		noun = "comment"
	}
	return fmt.Sprintf("Review %s added: %s. Read them with the `mcp__hydra__get_review_comments` tool.",
		noun, strings.Join(parts, ", "))
}
