package chat

import (
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/trolleyman/hydra/internal/paths"
)

func TestStoreAppendProjectAndPage(t *testing.T) {
	root := t.TempDir()
	s, err := Open(root, "head")
	if err != nil {
		t.Fatal(err)
	}
	s.now = func() time.Time { return time.Unix(123, 0) }
	appendEvent := func(kind string, payload any) Event {
		ev, err := s.Append(kind, payload)
		if err != nil {
			t.Fatal(err)
		}
		return ev
	}
	appendEvent("user_message", map[string]any{"id": "m1", "text": "hello"})
	appendEvent("plan_updated", map[string]any{"plan": []map[string]any{{"id": "1", "status": "pending"}}})
	appendEvent("subagent_started", map[string]any{"id": "sub", "status": "running"})
	appendEvent("queued_message", map[string]any{"id": "m2", "status": "queued", "content": []map[string]string{{"type": "text", "text": "later"}}})
	appendEvent("commit_created", map[string]any{"head": "abc", "sha": "abc"})

	p := s.Snapshot()
	if p.Through != 5 || p.Head != "abc" || p.Subagents["sub"].Status != "running" || p.Queue["m2"].ID != "m2" {
		t.Fatalf("unexpected projection: %+v", p)
	}
	var plan []map[string]any
	if json.Unmarshal(p.Plan, &plan) != nil || len(plan) != 1 {
		t.Fatalf("plan = %s", p.Plan)
	}

	page, next, done, err := s.Before("", 2)
	if err != nil {
		t.Fatal(err)
	}
	if done || next != "4" || len(page) != 2 || page[0].Seq != 4 || page[1].Seq != 5 {
		t.Fatalf("last page = %+v, next=%q done=%v", page, next, done)
	}
	page, _, done, err = s.Before(next, 10)
	if err != nil {
		t.Fatal(err)
	}
	if !done || len(page) != 3 || page[0].Seq != 1 || page[2].Seq != 3 {
		t.Fatalf("older page = %+v, done=%v", page, done)
	}
}

func TestStoreRecoversFromCheckpointLagAndPartialTail(t *testing.T) {
	root := t.TempDir()
	s, err := Open(root, "head")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Append("model_changed", map[string]string{"model": "first"}); err != nil {
		t.Fatal(err)
	}
	checkpoint := paths.GetChatStateJSONFromProjectRoot(root, "head")
	stale, err := os.ReadFile(checkpoint)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Append("model_changed", map[string]string{"model": "second"}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(checkpoint, stale, 0o644); err != nil {
		t.Fatal(err)
	}
	events := paths.GetChatEventsJSONLFromProjectRoot(root, "head")
	f, err := os.OpenFile(events, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString(`{"seq":3`); err != nil {
		t.Fatal(err)
	}
	_ = f.Close()

	reopened, err := Open(root, "head")
	if err != nil {
		t.Fatal(err)
	}
	if got := reopened.Snapshot(); got.Through != 2 || got.Model != "second" {
		t.Fatalf("recovered projection = %+v", got)
	}
	if _, err := reopened.Append("model_changed", map[string]string{"model": "third"}); err != nil {
		t.Fatal(err)
	}
	page, _, _, err := reopened.Before("", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(page) != 3 || page[2].Seq != 3 {
		t.Fatalf("events after repair = %+v", page)
	}
}

func TestApplyIsIdempotent(t *testing.T) {
	p := Projection{Version: ProjectionVersion, Subagents: map[string]SubagentState{}, Queue: map[string]QueuedState{}}
	ev := Event{Seq: 1, Type: "queued_message", Payload: json.RawMessage(`{"id":"m","status":"queued","content":[]}`)}
	apply(&p, ev)
	apply(&p, ev)
	if p.Through != 1 || len(p.Queue) != 1 {
		t.Fatalf("projection = %+v", p)
	}
}

func TestAppendSourceDeduplicatesProviderReplay(t *testing.T) {
	root := t.TempDir()
	s, err := Open(root, "head")
	if err != nil {
		t.Fatal(err)
	}
	first, appended, err := s.AppendSource("claude:u1:block:0", "assistant_message", map[string]string{"text": "hi"})
	if err != nil || !appended {
		t.Fatalf("first append: appended=%v err=%v", appended, err)
	}
	again, appended, err := s.AppendSource("claude:u1:block:0", "assistant_message", map[string]string{"text": "duplicate"})
	if err != nil || appended || again.Seq != first.Seq {
		t.Fatalf("duplicate append: event=%+v appended=%v err=%v", again, appended, err)
	}
	reopened, err := Open(root, "head")
	if err != nil {
		t.Fatal(err)
	}
	_, appended, err = reopened.AppendSource("claude:u1:block:0", "assistant_message", map[string]string{"text": "after restart"})
	if err != nil || appended {
		t.Fatalf("restart duplicate: appended=%v err=%v", appended, err)
	}
}
