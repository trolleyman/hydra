package reviewstore

import (
	"errors"
	"strings"
	"testing"
)

func TestCommentNumbersAreSequentialAndNeverReused(t *testing.T) {
	root := t.TempDir()
	for i := range 3 {
		if _, err := AppendComment(root, "h", Comment{Body: "x", Path: "a.go", Line: i + 1}); err != nil {
			t.Fatalf("append: %v", err)
		}
	}
	got := LoadComments(root, "h")
	if len(got) != 3 {
		t.Fatalf("got %d comments, want 3", len(got))
	}
	for i, c := range got {
		if c.Number != i+1 {
			t.Fatalf("comment %d numbered %d, want %d", i, c.Number, i+1)
		}
	}

	// Deleting the last draft must NOT free its number: "#3" has to mean one
	// thing forever, including after the comment it named is gone.
	if err := DeleteDraft(root, "h", 3); err != nil {
		t.Fatalf("delete draft: %v", err)
	}
	next, err := AppendComment(root, "h", Comment{Body: "y"})
	if err != nil {
		t.Fatalf("append after delete: %v", err)
	}
	if next.Number != 4 {
		t.Fatalf("number %d reused a retired one; want 4", next.Number)
	}
}

func TestDraftsAreInvisibleToAgentsUntilPublished(t *testing.T) {
	root := t.TempDir()
	if _, err := AppendComment(root, "h", Comment{Body: "half a thought", Path: "a.go", Line: 4}); err != nil {
		t.Fatal(err)
	}
	if _, err := AppendComment(root, "h", Comment{Body: "another", Path: "b.go", Line: 9}); err != nil {
		t.Fatal(err)
	}
	if got := PublishedComments(root, "h"); len(got) != 0 {
		t.Fatalf("drafts leaked to the agent-facing read: %+v", got)
	}

	published, err := PublishDrafts(root, "h", nil)
	if err != nil {
		t.Fatalf("publish: %v", err)
	}
	if len(published) != 2 {
		t.Fatalf("published %d, want 2", len(published))
	}
	if got := PublishedComments(root, "h"); len(got) != 2 {
		t.Fatalf("agent-facing read returned %d, want 2", len(got))
	}
	for _, c := range published {
		if c.PublishedAt == "" {
			t.Errorf("%s published with no timestamp", c.Label())
		}
	}
	// Publishing again is the same request twice, not an error - and must not
	// re-publish (or re-notify) what already went out.
	again, err := PublishDrafts(root, "h", nil)
	if err != nil || len(again) != 0 {
		t.Fatalf("second publish returned (%v, %v), want (nil, nil)", again, err)
	}
}

func TestPublishedCommentsAreImmutable(t *testing.T) {
	root := t.TempDir()
	c, err := AppendComment(root, "h", Comment{Body: "before"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := UpdateDraft(root, "h", c.Number, "edited"); err != nil {
		t.Fatalf("a draft must be editable: %v", err)
	}
	if _, err := PublishDrafts(root, "h", []int{c.Number}); err != nil {
		t.Fatal(err)
	}
	if _, err := UpdateDraft(root, "h", c.Number, "rewritten"); !errors.Is(err, ErrNotDraft) {
		t.Errorf("editing a published comment returned %v, want ErrNotDraft", err)
	}
	if err := DeleteDraft(root, "h", c.Number); !errors.Is(err, ErrNotDraft) {
		t.Errorf("deleting a published comment returned %v, want ErrNotDraft", err)
	}
	if got, _ := FindComment(root, "h", c.Number); got.Body != "edited" {
		t.Errorf("body is %q; the failed edits must not have landed", got.Body)
	}
}

func TestPublishOnlyTheNamedDrafts(t *testing.T) {
	root := t.TempDir()
	for _, body := range []string{"one", "two", "three"} {
		if _, err := AppendComment(root, "h", Comment{Body: body}); err != nil {
			t.Fatal(err)
		}
	}
	published, err := PublishDrafts(root, "h", []int{2})
	if err != nil {
		t.Fatal(err)
	}
	if len(published) != 1 || published[0].Number != 2 {
		t.Fatalf("published %+v, want only #2", published)
	}
	if got := PublishedComments(root, "h"); len(got) != 1 {
		t.Fatalf("agent sees %d comments, want 1", len(got))
	}
}

// An empty draft is not a comment - publishing must not turn a stray empty box
// into a notification the agent has to go and read.
func TestPublishSkipsEmptyDrafts(t *testing.T) {
	root := t.TempDir()
	if _, err := AppendComment(root, "h", Comment{Body: "   "}); err != nil {
		t.Fatal(err)
	}
	published, err := PublishDrafts(root, "h", nil)
	if err != nil || len(published) != 0 {
		t.Fatalf("published %+v (err %v), want nothing", published, err)
	}
}

func TestNotifyLineIsOneShortLine(t *testing.T) {
	comments := []Comment{
		{Number: 4, Path: "web/src/DiffViewer.tsx", Line: 1204, Body: "a long body that must not appear"},
		{Number: 5, Path: "internal/tests/manager.go", Line: 88, Body: "nor this one"},
	}
	line := NotifyLine(comments)
	for _, want := range []string{"#4 (web/src/DiffViewer.tsx:1204)", "#5 (internal/tests/manager.go:88)"} {
		if !strings.Contains(line, want) {
			t.Errorf("notification missing %q: %s", want, line)
		}
	}
	if strings.Contains(line, "must not appear") || strings.Contains(line, "nor this one") {
		t.Errorf("notification carries comment bodies - the whole point is that it does not:\n%s", line)
	}
	if strings.Contains(line, "\n") {
		t.Errorf("notification is more than one line:\n%s", line)
	}
	if NotifyLine(nil) != "" {
		t.Error("no comments should produce no notification")
	}
}

func TestRenderForAgentCarriesAnchorsAndContext(t *testing.T) {
	comments := []Comment{
		{Number: 3, Path: "a.go", Line: 12, Author: AuthorUser, Body: "this leaks", Context: "```diff\n+ leak()\n```", Diff: "main -> abc1234"},
		{Number: 4, Author: AuthorReviewer, Body: "agreed", ReplyTo: 3},
	}
	out := RenderForAgent(comments, true, nil)
	for _, want := range []string{"#3 a.go:12", "main -> abc1234", "+ leak()", "this leaks", "#4", "reply to #3", "agreed"} {
		if !strings.Contains(out, want) {
			t.Errorf("rendering missing %q:\n%s", want, out)
		}
	}
	if strings.Contains(RenderForAgent(comments, false, nil), "+ leak()") {
		t.Error("withContext=false still emitted the diff block")
	}
	if got := RenderForAgent(nil, true, nil); !strings.Contains(got, "No review comments") {
		t.Errorf("empty rendering is unhelpful: %q", got)
	}
}

// A pin on a picture has to reach an agent as PIXELS. The store keeps fractions
// so the anchor survives being laid out at another size, but "34%,71%" is not
// something a model can act on, and the conversion is the whole point of keeping
// the natural size alongside.
func TestImageAnchorRendersPixelsAndFindsThePicture(t *testing.T) {
	a := ImageAnchor{
		Script: "screenshots", Key: "commit/abc1234def0567", Side: "right", File: "home-dark.png",
		X: 0.34, Y: 0.71, NaturalW: 1512, NaturalH: 982,
	}
	if x, y, _, _, ok := a.Pixels(); !ok || x != 514 || y != 697 {
		t.Errorf("Pixels() = %d,%d (ok=%v), want 514,697", x, y, ok)
	}
	if got := a.Where(); got != "home-dark.png @ 34%,71%" {
		t.Errorf("Where() = %q", got)
	}
	if got := a.Position(); !strings.Contains(got, "514,697 px") || !strings.Contains(got, "1512x982") {
		t.Errorf("Position() = %q, want the pixels and the image size", got)
	}
	c := Comment{Number: 9, Author: AuthorUser, Body: "this is 3px low", Image: &a}
	out := RenderForAgent([]Comment{c}, true, func(Comment) (string, string) { return "/tmp/out/home-dark.png", "/tmp/crops/9.png" })
	for _, want := range []string{"#9 home-dark.png @ 34%,71%", "/tmp/out/home-dark.png", "right side of the screenshots artifact", "abc1234def05", "point: 514,697 px", "close-up of that spot: /tmp/crops/9.png"} {
		if !strings.Contains(out, want) {
			t.Errorf("rendering missing %q:\n%s", want, out)
		}
	}
	// A drag makes it a box, and the box's SIZE is what the remark is about.
	a.W, a.H = 0.1, 0.05
	if got := a.Position(); !strings.Contains(got, "151x49 px") {
		t.Errorf("box Position() = %q, want the box size in pixels", got)
	}
	if out := RenderForAgent([]Comment{{Number: 1, Image: &a}}, true, nil); !strings.Contains(out, "box: ") {
		t.Errorf("a box should not be rendered as a point:\n%s", out)
	}
	// No natural size: percentages, never invented pixels.
	bare := ImageAnchor{File: "x.png", X: 0.5, Y: 0.5}
	if got := bare.Position(); strings.Contains(got, "px") {
		t.Errorf("Position() invented pixels with no natural size: %q", got)
	}
}

// The version a picture was rendered from decides what may be done with it, and a
// working-tree render must never be reported as a commit: an agent told a sha
// will confidently reason about code that was never what it was looking at.
func TestImageAnchorNeverCallsAWorktreeRenderACommit(t *testing.T) {
	commit := ImageAnchor{Key: "commit/abc1234def0567890"}
	if got := commit.Version(); got != "abc1234def05" {
		t.Errorf("Version() = %q, want the shortened sha", got)
	}
	if !commit.IsCommitted() {
		t.Error("a commit key should report as committed")
	}
	wt := ImageAnchor{Key: "worktree/9f3a1b2c"}
	// It must say what it is and carry the state hash, so two working-tree renders
	// can be told apart - but the hash must never read as something git can resolve.
	if got := wt.Version(); !strings.Contains(got, "uncommitted working tree") || !strings.Contains(got, "9f3a1b2c") {
		t.Errorf("Version() = %q, want it named as uncommitted, with its state hash", got)
	}
	if wt.IsCommitted() {
		t.Error("a worktree render must not report as committed - git cannot be used on it")
	}
}

// One sequence across every origin is the whole point of the numbering: a UI with
// two schemes in one gutter is worse than none, and "fix #3" has to be
// unambiguous whether #3 was left in Hydra or on the PR.
func TestForgeNotesShareTheNumberingSequence(t *testing.T) {
	root := t.TempDir()
	first, err := AppendComment(root, "h", Comment{Body: "mine"})
	if err != nil {
		t.Fatal(err)
	}
	forge := NumberForForgeNote(root, "h", "note-701", "thread-701")
	second, err := AppendComment(root, "h", Comment{Body: "mine again"})
	if err != nil {
		t.Fatal(err)
	}
	if first.Number != 1 || forge != 2 || second.Number != 3 {
		t.Fatalf("numbers %d, %d, %d - want one interleaved sequence 1, 2, 3", first.Number, forge, second.Number)
	}
	// Idempotent: the diff viewer numbers forge notes on EVERY render, so a repeat
	// must not burn a number.
	if again := NumberForForgeNote(root, "h", "note-701", "thread-701"); again != forge {
		t.Fatalf("re-numbering the same note gave %d, want %d", again, forge)
	}
	if third, _ := AppendComment(root, "h", Comment{Body: "third"}); third.Number != 4 {
		t.Fatalf("next number %d, want 4 - a repeat lookup consumed one", third.Number)
	}

	// And a number resolves back to the note (and its thread), which is what lets
	// an agent reply to "#2" without a second forge lookup.
	noteID, ref, ok := ForgeRef(root, "h", forge)
	if !ok || noteID != "note-701" || ref.Thread != "thread-701" {
		t.Fatalf("ForgeRef(%d) = (%q, %+v, %v), want note-701/thread-701", forge, noteID, ref, ok)
	}
	if _, _, ok := ForgeRef(root, "h", first.Number); ok {
		t.Error("a native comment's number resolved as a forge ref")
	}
}

// Resolving is a state change, not an edit, so it is allowed on a published
// comment - and it is what OpenComments filters on.
func TestResolveHidesAcommentFromTheOpenRead(t *testing.T) {
	root := t.TempDir()
	c, _ := AppendComment(root, "h", Comment{Body: "please fix", Path: "a.go", Line: 3})
	if _, err := PublishDrafts(root, "h", nil); err != nil {
		t.Fatal(err)
	}
	if len(OpenComments(root, "h")) != 1 {
		t.Fatal("a published comment should start open")
	}
	got, err := SetResolved(root, "h", c.Number, true)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if !got.Resolved || got.ResolvedAt == "" {
		t.Errorf("resolve did not stamp the comment: %+v", got)
	}
	if len(OpenComments(root, "h")) != 0 {
		t.Error("a resolved comment is still in the open read")
	}
	if len(PublishedComments(root, "h")) != 1 {
		t.Error("resolving deleted the comment; it must stay readable")
	}
	if got.Body != "please fix" {
		t.Error("resolving changed the body - it is a state change, not an edit")
	}
	if _, err := SetResolved(root, "h", c.Number, false); err != nil {
		t.Fatalf("reopen: %v", err)
	}
	if len(OpenComments(root, "h")) != 1 {
		t.Error("reopening did not put the comment back")
	}
}

// A forge thread's resolve mark is Hydra-local, and must not be mistaken for the
// forge's own.
func TestThreadResolutionIsLocalAndReversible(t *testing.T) {
	root := t.TempDir()
	if ThreadResolved(root, "h", "t1") {
		t.Fatal("an unknown thread reads as resolved")
	}
	if err := SetThreadResolved(root, "h", "t1", true, "2026-01-01T00:00:00Z"); err != nil {
		t.Fatal(err)
	}
	if !ThreadResolved(root, "h", "t1") {
		t.Error("thread did not stay resolved")
	}
	if err := SetThreadResolved(root, "h", "t1", false, ""); err != nil {
		t.Fatal(err)
	}
	if ThreadResolved(root, "h", "t1") {
		t.Error("thread did not reopen")
	}
}

// Read state is per-number and only ever set explicitly - nothing becomes read by
// the passage of time.
func TestReadStateIsExplicitAndPerNumber(t *testing.T) {
	root := t.TempDir()
	if IsRead(root, "h", 3) {
		t.Fatal("a comment nobody has seen reads as read")
	}
	if err := MarkRead(root, "h", []int{3, 5}, true); err != nil {
		t.Fatal(err)
	}
	if !IsRead(root, "h", 3) || !IsRead(root, "h", 5) || IsRead(root, "h", 4) {
		t.Errorf("read set is wrong: %v", ReadSet(root, "h"))
	}
	if err := MarkRead(root, "h", []int{3}, true); err != nil {
		t.Fatalf("marking read twice must be idempotent: %v", err)
	}
	if got := ReadSet(root, "h"); len(got) != 2 {
		t.Errorf("read set has %d entries, want 2", len(got))
	}
	// And back again - "seen it, come back to it" is the only way a comment
	// becomes new again.
	if err := MarkRead(root, "h", []int{3}, false); err != nil {
		t.Fatal(err)
	}
	if IsRead(root, "h", 3) || !IsRead(root, "h", 5) {
		t.Errorf("marking unread hit the wrong numbers: %v", ReadSet(root, "h"))
	}
}

// A recording has a time axis as well as two spatial ones. Without the moment,
// "34%,71%" sends the reader hunting through the whole clip for the frame it was
// 34%,71% of.
func TestVideoPinCarriesItsMoment(t *testing.T) {
	a := ImageAnchor{Script: "screenshots", Key: "commit/abc1234", File: "loader.webm", X: 0.5, Y: 0.5, NaturalW: 800, NaturalH: 600, T: 12.44}
	if got := a.Where(); !strings.Contains(got, "0:12.4") {
		t.Errorf("Where() = %q, want the moment in it", got)
	}
	out := RenderForAgent([]Comment{{Number: 2, Image: &a, Body: "the spinner stalls"}}, true, nil)
	if !strings.Contains(out, "at 0:12.4 into the recording") {
		t.Errorf("rendering does not say when:\n%s", out)
	}
	// A still has no time axis, so saying "at 0:00.0" would be noise claiming to
	// be information.
	still := ImageAnchor{File: "home.png", X: 0.5, Y: 0.5}
	if got := still.Where(); strings.Contains(got, "0:00") {
		t.Errorf("Where() = %q, want no timecode on a still", got)
	}
}

func TestFormatTimecode(t *testing.T) {
	for _, tc := range []struct {
		in   float64
		want string
	}{{0, "0:00.0"}, {9.28, "0:09.3"}, {75.52, "1:15.5"}, {-3, "0:00.0"}} {
		if got := FormatTimecode(tc.in); got != tc.want {
			t.Errorf("FormatTimecode(%v) = %q, want %q", tc.in, got, tc.want)
		}
	}
}
