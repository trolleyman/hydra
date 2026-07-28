package http

import (
	"testing"

	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/forge"
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

	got := mergeLocalNotes(threads, notes)
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
