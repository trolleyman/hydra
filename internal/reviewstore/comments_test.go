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
