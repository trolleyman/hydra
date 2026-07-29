package chat

import (
	"encoding/json"
	"os"
	"strings"
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
	if p.Through != 5 || p.Head != "abc" || p.Subagents["sub"].Status != "running" || p.Queue["m2"].Id != "m2" {
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

func TestSubagentEventsReturnsOnlyThatSubsSteps(t *testing.T) {
	root := t.TempDir()
	s, err := Open(root, "head")
	if err != nil {
		t.Fatal(err)
	}
	s.now = func() time.Time { return time.Unix(123, 0) }
	mustAppend := func(kind string, payload any) {
		if _, err := s.Append(kind, payload); err != nil {
			t.Fatal(err)
		}
	}
	// A main-flow message, both sub-agents' lifecycle (keyed by id, not agent_id)
	// and their interleaved sidechain steps, plus a stream-only sidechain delta.
	mustAppend("user_message", map[string]any{"id": "m1", "text": "go"})
	mustAppend("subagent_started", map[string]any{"id": "subA", "status": "running"})
	mustAppend("tool_started", map[string]any{"id": "t1", "name": "Read", "agent_id": "subA", "sidechain": true})
	mustAppend("subagent_started", map[string]any{"id": "subB", "status": "running"})
	mustAppend("tool_started", map[string]any{"id": "t2", "name": "Grep", "agent_id": "subB", "sidechain": true})
	mustAppend("assistant_delta", map[string]any{"text": "part", "agent_id": "subA", "sidechain": true})
	mustAppend("assistant_message", map[string]any{"text": "done", "agent_id": "subA", "sidechain": true})
	mustAppend("assistant_message", map[string]any{"text": "main reply"})

	got := s.SubagentEvents("subA")
	if len(got) != 2 {
		t.Fatalf("subA events = %+v (want 2: t1 tool_started + assistant_message; no delta, no subB, no main)", got)
	}
	if got[0].Type != "tool_started" || got[1].Type != "assistant_message" {
		t.Fatalf("subA events out of order / wrong types: %+v", got)
	}
	if got[0].Seq >= got[1].Seq {
		t.Fatalf("subA events not oldest-first: %+v", got)
	}
	if len(s.SubagentEvents("subB")) != 1 {
		t.Fatalf("subB events = %+v (want just t2)", s.SubagentEvents("subB"))
	}
	if s.SubagentEvents("") != nil || len(s.SubagentEvents("missing")) != 0 {
		t.Fatalf("empty/unknown sub-agent should yield no events")
	}
}

func TestPendingStreamAndHistorySkipDeltas(t *testing.T) {
	root := t.TempDir()
	s, err := Open(root, "head")
	if err != nil {
		t.Fatal(err)
	}
	s.now = func() time.Time { return time.Unix(123, 0) }
	mustAppend := func(kind string, payload any) {
		if _, err := s.Append(kind, payload); err != nil {
			t.Fatal(err)
		}
	}
	// A settled message, then a response still streaming its text block.
	mustAppend("user_message", map[string]any{"id": "m1", "content": "hi"})
	mustAppend("content_stream_started", map[string]any{"kind": "text"})
	mustAppend("assistant_delta", map[string]any{"text": "Hello "})
	mustAppend("usage_updated", map[string]any{"usage": map[string]any{"output_tokens": 3}})
	mustAppend("assistant_delta", map[string]any{"text": "there"})

	snap, _, cancel := s.Watch()
	cancel()
	if snap.Stream == nil || snap.Stream.Kind != "text" || snap.Stream.Text != "Hello there" {
		t.Fatalf("pending stream = %+v", snap.Stream)
	}

	// History must not leak the stream-only delta/boundary events.
	page, _, done, err := s.Before("", 100)
	if err != nil {
		t.Fatal(err)
	}
	if !done {
		t.Fatalf("expected fully-paged history, done=%v", done)
	}
	for _, ev := range page {
		if streamOnly(ev.Type) {
			t.Fatalf("history leaked stream-only event %q: %+v", ev.Type, page)
		}
	}

	// Once the block settles, nothing is pending.
	if _, err := s.Append("assistant_message", map[string]any{"text": "Hello there"}); err != nil {
		t.Fatal(err)
	}
	snap, _, cancel = s.Watch()
	cancel()
	if snap.Stream != nil {
		t.Fatalf("expected no pending stream after settle, got %+v", snap.Stream)
	}
}

func TestEventUsesSequenceAsSoleWireIdentity(t *testing.T) {
	event := Event{Seq: 7, Type: "notice", Timestamp: time.Unix(123, 0), Payload: json.RawMessage(`{"text":"hi"}`)}
	raw, err := json.Marshal(event)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), `"id":`) || !strings.Contains(string(raw), `"seq":7`) {
		t.Fatalf("event identity = %s", raw)
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

func TestLateSubagentStartDoesNotReopenCompletion(t *testing.T) {
	p := Projection{Version: ProjectionVersion, Subagents: map[string]SubagentState{}, Queue: map[string]QueuedState{}}
	apply(&p, Event{Seq: 1, Type: "subagent_completed", Payload: json.RawMessage(`{"id":"sub","status":"completed"}`)})
	apply(&p, Event{Seq: 2, Type: "subagent_started", Payload: json.RawMessage(`{"id":"sub","status":"running","description":"late sidecar"}`)})
	if got := p.Subagents["sub"]; got.Status != "completed" || got.Description != "late sidecar" {
		t.Fatalf("subagent projection = %+v", got)
	}
}

func TestProjectionKeepsInterruptedTurnOverProtocolFailure(t *testing.T) {
	p := Projection{Version: ProjectionVersion, Subagents: map[string]SubagentState{}, Queue: map[string]QueuedState{}}
	apply(&p, Event{Seq: 1, Type: "turn_interrupted", Payload: json.RawMessage(`{"id":"turn","status":"interrupted"}`)})
	apply(&p, Event{Seq: 2, Type: "turn_failed", Payload: json.RawMessage(`{"id":"turn","status":"failed"}`)})
	if p.Turn == nil || p.Turn.Status != "interrupted" || p.Through != 2 {
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
