package http

import (
	"testing"

	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/forge"
	"github.com/trolleyman/hydra/internal/reviewq"
	"github.com/trolleyman/hydra/internal/reviewstore"
)

func TestMergeLocalNotes(t *testing.T) {
	threads := []forge.Thread{
		{ID: "t1", Path: "a.go", Line: 12, URL: "https://x/t1", Notes: []forge.Note{
			{ID: "1", Author: "alice", Body: "rename this", CreatedAt: "2026-07-28T09:00:00Z"},
		}},
		{ID: "t2", Path: "b.go", Line: 3, Resolved: true, Notes: []forge.Note{
			{ID: "2", Author: "bob", Body: "settled"},
		}},
	}
	notes := []reviewstore.LocalNote{
		// Deliberately out of order, and one for a thread the forge no longer has.
		{ID: "n2", ThreadID: "t1", Author: "agent", Body: "second", CreatedAt: "2026-07-28T10:00:00Z"},
		{ID: "n1", ThreadID: "t1", Author: "agent", Body: "first", CreatedAt: "2026-07-28T09:30:00Z"},
		{ID: "n3", ThreadID: "gone", Author: "agent", Body: "orphan", CreatedAt: "2026-07-28T09:40:00Z"},
	}

	root := t.TempDir()
	srv := &Server{}
	got := srv.mergeLocalNotes(root, "h1", threads, notes)
	if len(got) != 2 {
		t.Fatalf("got %d threads, want 2", len(got))
	}
	first := got[0]
	if len(first.Notes) != 3 {
		t.Fatalf("thread t1 has %d notes, want 3 (1 forge + 2 local)", len(first.Notes))
	}
	// Forge notes first, then local notes oldest-first: the thread reads in time
	// order and the origin is never guessed from position.
	if first.Notes[0].Origin != api.Forge || first.Notes[1].Origin != api.LocalOnly {
		t.Errorf("origins wrong: %+v", first.Notes)
	}
	if first.Notes[1].Body != "first" || first.Notes[2].Body != "second" {
		t.Errorf("local notes out of order: %+v", first.Notes)
	}
	// A note whose thread has vanished is dropped, not shown as its own thread.
	for _, th := range got {
		for _, n := range th.Notes {
			if n.Body == "orphan" {
				t.Error("orphaned local note should not be rendered")
			}
		}
	}
	if !*got[1].Resolved {
		t.Error("resolved thread lost its flag")
	}

	// Every note is numbered from the head's ONE sequence, so a number names a
	// comment regardless of which side of the fence it lives on - and numbering is
	// idempotent, because this runs on every render.
	seen := map[int]bool{}
	for _, th := range got {
		for _, n := range th.Notes {
			if n.Number == nil || *n.Number == 0 {
				t.Fatalf("note %q was not numbered", n.Id)
			}
			if seen[*n.Number] {
				t.Fatalf("number %d handed out twice", *n.Number)
			}
			seen[*n.Number] = true
		}
	}
	again := srv.mergeLocalNotes(root, "h1", threads, notes)
	if *again[0].Notes[0].Number != *got[0].Notes[0].Number {
		t.Error("re-rendering renumbered the notes; the sequence would run away")
	}

	// Hydra's local resolve mark reads as resolved, and says it is local so the UI
	// can be honest that the forge still shows the thread open.
	if err := reviewstore.SetThreadResolved(root, "h1", "t1", true, "2026-07-29T00:00:00Z"); err != nil {
		t.Fatal(err)
	}
	marked := srv.mergeLocalNotes(root, "h1", threads, notes)
	if !*marked[0].Resolved || !*marked[0].ResolvedLocally {
		t.Errorf("local resolve mark not applied: %+v", marked[0])
	}
	if marked[1].ResolvedLocally != nil && *marked[1].ResolvedLocally {
		t.Error("a forge-resolved thread was reported as locally resolved")
	}
}

func TestReviewStoreRoundTrip(t *testing.T) {
	root := t.TempDir()

	if notes := reviewstore.LoadNotes(root, "h1"); len(notes) != 0 {
		t.Fatalf("fresh head should have no notes, got %v", notes)
	}
	n, err := reviewstore.AppendNote(root, "h1", reviewstore.LocalNote{ThreadID: "t1", Author: reviewstore.AuthorAgent, Body: "fixed in abc123"})
	if err != nil {
		t.Fatalf("AppendNote: %v", err)
	}
	if n.ID == "" || n.CreatedAt == "" {
		t.Errorf("stored note missing id/time: %+v", n)
	}
	if _, err := reviewstore.AppendNote(root, "h1", reviewstore.LocalNote{ThreadID: "t1", Body: "and a note to self"}); err != nil {
		t.Fatalf("AppendNote: %v", err)
	}
	notes := reviewstore.LoadNotes(root, "h1")
	if len(notes) != 2 || notes[0].Body != "fixed in abc123" {
		t.Fatalf("notes = %+v, want both in append order", notes)
	}
	// Notes are per-head.
	if other := reviewstore.LoadNotes(root, "h2"); len(other) != 0 {
		t.Errorf("notes leaked to another head: %v", other)
	}

	// The thread cache is what a failed live read falls back to.
	if threads, at := reviewstore.LoadThreads(root, "h1"); threads != nil || at != "" {
		t.Errorf("empty cache should read as nothing, got %v %q", threads, at)
	}
	if err := reviewstore.SaveThreads(root, "h1", []forge.Thread{{ID: "t1", Path: "a.go"}}); err != nil {
		t.Fatalf("SaveThreads: %v", err)
	}
	threads, at := reviewstore.LoadThreads(root, "h1")
	if len(threads) != 1 || threads[0].ID != "t1" || at == "" {
		t.Errorf("cache round trip wrong: %v %q", threads, at)
	}
}

// An agent replies by NUMBER, and the number decides where the reply lands: one
// of Hydra's own comments gets a threaded comment, a forge note gets a local note
// on its thread. Neither ever reaches the forge.
func TestAgentRepliesRouteByNumber(t *testing.T) {
	root := t.TempDir()
	srv := &Server{}

	// A published Hydra comment, and a numbered forge note.
	mine, err := reviewstore.AppendComment(root, "h", reviewstore.Comment{
		Body: "this leaks", Path: "a.go", Line: 12,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := reviewstore.PublishDrafts(root, "h", nil); err != nil {
		t.Fatal(err)
	}
	forgeNum := reviewstore.NumberForForgeNote(root, "h", "note-9", "thread-9")

	res := srv.recordLocalNote(root, "h", reviewq.Request{ReplyTo: mine.Number, Body: "fixed in abc123"})
	if !res.OK {
		t.Fatalf("reply to a Hydra comment failed: %s", res.Message)
	}
	var reply reviewstore.Comment
	for _, c := range reviewstore.PublishedComments(root, "h") {
		if c.ReplyTo == mine.Number {
			reply = c
		}
	}
	if reply.Number == 0 {
		t.Fatal("no threaded reply was stored")
	}
	if reply.Author != reviewstore.AuthorAgent {
		t.Errorf("reply author %q, want %q", reply.Author, reviewstore.AuthorAgent)
	}
	if reply.Path != "a.go" || reply.Line != 12 {
		t.Errorf("reply did not inherit its parent's anchor: %+v", reply)
	}

	res = srv.recordLocalNote(root, "h", reviewq.Request{ReplyTo: forgeNum, Body: "disagree"})
	if !res.OK {
		t.Fatalf("reply to a forge note failed: %s", res.Message)
	}
	notes := reviewstore.LoadNotes(root, "h")
	if len(notes) != 1 || notes[0].ThreadID != "thread-9" {
		t.Fatalf("forge reply did not land on the right thread: %+v", notes)
	}
	if notes[0].Author != reviewstore.AuthorAgent {
		t.Errorf("note author %q, want the agent", notes[0].Author)
	}

	// A number nobody has, and an empty body, both fail with something the agent
	// can act on rather than silently doing nothing.
	if res := srv.recordLocalNote(root, "h", reviewq.Request{ReplyTo: 999, Body: "hello"}); res.OK {
		t.Error("replying to an unknown number reported success")
	}
	if res := srv.recordLocalNote(root, "h", reviewq.Request{ReplyTo: mine.Number, Body: "  "}); res.OK {
		t.Error("an empty reply reported success")
	}

	// A DRAFT is not repliable: an agent must not be able to answer something the
	// user has not said yet.
	draft, _ := reviewstore.AppendComment(root, "h", reviewstore.Comment{Body: "still thinking"})
	if res := srv.recordLocalNote(root, "h", reviewq.Request{ReplyTo: draft.Number, Body: "?"}); res.OK {
		t.Error("an agent replied to an unpublished draft")
	}
}
