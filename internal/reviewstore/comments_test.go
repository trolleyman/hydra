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
	// The anchor is a markdown link, so the chat renders it clickable rather than
	// as a bare path the reader has to go and find (see NotifyLine).
	for _, want := range []string{
		"#4 [web/src/DiffViewer.tsx:1204](web/src/DiffViewer.tsx:1204)",
		"#5 [internal/tests/manager.go:88](internal/tests/manager.go:88)",
	} {
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
	out := RenderForAgent(comments, true)
	for _, want := range []string{"#3 a.go:12", "main -> abc1234", "+ leak()", "this leaks", "#4", "reply to #3", "agreed"} {
		if !strings.Contains(out, want) {
			t.Errorf("rendering missing %q:\n%s", want, out)
		}
	}
	if strings.Contains(RenderForAgent(comments, false), "+ leak()") {
		t.Error("withContext=false still emitted the diff block")
	}
	if got := RenderForAgent(nil, true); !strings.Contains(got, "No review comments") {
		t.Errorf("empty rendering is unhelpful: %q", got)
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

func TestResolveAppliesToTheWholeNativeThread(t *testing.T) {
	root := t.TempDir()
	first, _ := AppendComment(root, "h", Comment{Body: "please fix", Status: StatusPublished})
	reply, _ := AppendComment(root, "h", Comment{Body: "fixed", Status: StatusPublished, ReplyTo: first.Number})
	nested, _ := AppendComment(root, "h", Comment{Body: "confirmed", Status: StatusPublished, ReplyTo: reply.Number})
	other, _ := AppendComment(root, "h", Comment{Body: "separate", Status: StatusPublished})

	if _, err := SetResolved(root, "h", reply.Number, true); err != nil {
		t.Fatalf("resolve reply: %v", err)
	}
	for _, number := range []int{first.Number, reply.Number, nested.Number} {
		got, _ := FindComment(root, "h", number)
		if !got.Resolved || got.ResolvedAt == "" {
			t.Errorf("thread comment #%d was not resolved: %+v", number, got)
		}
	}
	if got, _ := FindComment(root, "h", other.Number); got.Resolved {
		t.Errorf("unrelated comment was resolved: %+v", got)
	}

	if _, err := SetResolved(root, "h", nested.Number, false); err != nil {
		t.Fatalf("reopen nested reply: %v", err)
	}
	for _, number := range []int{first.Number, reply.Number, nested.Number} {
		got, _ := FindComment(root, "h", number)
		if got.Resolved || got.ResolvedAt != "" {
			t.Errorf("thread comment #%d was not reopened: %+v", number, got)
		}
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
