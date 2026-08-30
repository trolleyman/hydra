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
		ev, err := s.Append(rawPayload{kind, payload})
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
		if _, err := s.Append(rawPayload{kind, payload}); err != nil {
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
		if _, err := s.Append(rawPayload{kind, payload}); err != nil {
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
	if _, err := s.Append(rawPayload{"assistant_message", map[string]any{"text": "Hello there"}}); err != nil {
		t.Fatal(err)
	}
	snap, _, cancel = s.Watch()
	cancel()
	if snap.Stream != nil {
		t.Fatalf("expected no pending stream after settle, got %+v", snap.Stream)
	}
}

func TestHasCompletedViewImageRequiresSuccessfulExactPath(t *testing.T) {
	s, err := Open(t.TempDir(), "head")
	if err != nil {
		t.Fatal(err)
	}
	started := ToolStarted{}
	started.Id, started.Name, started.Input, started.Status = "v1", "View Image", json.RawMessage(`{"path":"/home/user/shot.png"}`), "in_progress"
	if _, err := s.Append(started); err != nil {
		t.Fatal(err)
	}
	if s.HasCompletedViewImage("/home/user/shot.png") {
		t.Fatal("an in-progress image view must not authorize host file serving")
	}

	completed := ToolCompleted{}
	completed.Id, completed.Name, completed.Input, completed.Status = "v1", "View Image", started.Input, "completed"
	if _, err := s.Append(completed); err != nil {
		t.Fatal(err)
	}
	if !s.HasCompletedViewImage("/home/user/shot.png") {
		t.Fatal("completed image view was not found")
	}
	if s.HasCompletedViewImage("/home/user/other.png") {
		t.Fatal("a different path must not inherit authorization")
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
	if _, err := s.Append(rawPayload{"model_changed", map[string]string{"model": "first"}}); err != nil {
		t.Fatal(err)
	}
	checkpoint := paths.GetChatStateJSONFromProjectRoot(root, "head")
	stale, err := os.ReadFile(checkpoint)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Append(rawPayload{"model_changed", map[string]string{"model": "second"}}); err != nil {
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
	if _, err := reopened.Append(rawPayload{"model_changed", map[string]string{"model": "third"}}); err != nil {
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

// The projection is written WHOLE on each checkpoint, so doing it per append
// cost its size times the event count - measured at ~130MB of rewrites against
// 77MB of real log across this machine's heads. It is a checkpoint, not the
// record: what a lagging one loses, Open's replay puts back (see
// TestStoreRecoversFromCheckpointLagAndPartialTail), and Snapshot reads the
// in-memory fold, so no client ever sees the lag.
func TestStoreCoalescesProjectionCheckpoints(t *testing.T) {
	root := t.TempDir()
	s, err := Open(root, "head")
	if err != nil {
		t.Fatal(err)
	}
	clock := time.Unix(1000, 0)
	s.now = func() time.Time { return clock }
	checkpoint := paths.GetChatStateJSONFromProjectRoot(root, "head")
	through := func() uint64 {
		data, err := os.ReadFile(checkpoint)
		if err != nil {
			return 0
		}
		var p Projection
		if json.Unmarshal(data, &p) != nil {
			return 0
		}
		return p.Through
	}
	appendOne := func(model string) {
		changed := ModelChanged{}
		changed.Model = model
		if _, err := s.Append(changed); err != nil {
			t.Fatal(err)
		}
	}

	appendOne("first") // lastCheckpoint is zero, so this one writes
	if got := through(); got != 1 {
		t.Fatalf("checkpoint through = %d after the first append, want 1", got)
	}
	for i := 0; i < 50; i++ {
		clock = clock.Add(10 * time.Millisecond) // 500ms total, under the interval
		appendOne("burst")
	}
	if got := through(); got != 1 {
		t.Errorf("checkpoint through = %d during a 500ms burst, want it to stay at 1", got)
	}
	// The fold itself is current the whole time - only the file lags.
	if got := s.Snapshot().Through; got != 51 {
		t.Errorf("in-memory projection through = %d, want 51", got)
	}

	clock = clock.Add(checkpointInterval)
	appendOne("after the interval")
	if got := through(); got != 52 {
		t.Errorf("checkpoint through = %d after passing checkpointInterval, want 52", got)
	}

	// A quiet point puts the lagging fold down without waiting for an append.
	clock = clock.Add(10 * time.Millisecond)
	appendOne("lagging")
	if got := through(); got != 52 {
		t.Fatalf("checkpoint through = %d, want the append to have been coalesced", got)
	}
	s.Checkpoint()
	if got := through(); got != 53 {
		t.Errorf("checkpoint through = %d after an explicit Checkpoint, want 53", got)
	}

	// And a reopen agrees, whatever the file said.
	reopened, err := Open(root, "head")
	if err != nil {
		t.Fatal(err)
	}
	if got := reopened.Snapshot(); got.Through != 53 || got.Model != "lagging" {
		t.Errorf("reopened projection = %+v", got)
	}
}

// A store holds its head's whole event log to page from, so a killed head went
// on costing that memory for the life of the daemon - its files deleted, its log
// still resident. Discard resets it to exactly a freshly opened store, which is
// also what an id taken over by a forced respawn needs.
func TestStoreDiscardReleasesTheLogAndStaysUsable(t *testing.T) {
	root := t.TempDir()
	s, err := Open(root, "head")
	if err != nil {
		t.Fatal(err)
	}
	for _, model := range []string{"first", "second"} {
		changed := ModelChanged{}
		changed.Model = model
		if _, _, err := s.AppendSource("model:"+model, changed); err != nil {
			t.Fatal(err)
		}
	}
	if got := len(s.Events()); got != 2 {
		t.Fatalf("events = %d, want 2", got)
	}

	// What kill does: the files go, then the store is told.
	for _, p := range []string{
		paths.GetChatEventsJSONLFromProjectRoot(root, "head"),
		paths.GetChatStateJSONFromProjectRoot(root, "head"),
	} {
		if err := os.Remove(p); err != nil {
			t.Fatal(err)
		}
	}
	s.Discard()

	if got := len(s.Events()); got != 0 {
		t.Errorf("events after Discard = %d, want the log released", got)
	}
	if got := s.Snapshot(); got.Through != 0 || got.Model != "" {
		t.Errorf("projection after Discard = %+v, want an empty one", got)
	}
	// The dedup index is per event and outlives the events themselves, so it has
	// to go too - it is a fifth of what a long head holds. (Asserted directly: a
	// stale entry is harmless to CORRECTNESS, since the lookup that follows it
	// searches an empty log and appends anyway, so only the memory shows it.)
	if got := len(s.sourceIDs); got != 0 {
		t.Errorf("source ids after Discard = %d, want the index released", got)
	}
	// The same source id must not be deduped against the log that is gone.
	changed := ModelChanged{}
	changed.Model = "first"
	ev, appended, err := s.AppendSource("model:first", changed)
	if err != nil || !appended || ev.Seq != 1 {
		t.Fatalf("append after Discard = (%+v, %v, %v), want a fresh seq 1", ev, appended, err)
	}
	if _, err := os.Stat(paths.GetChatEventsJSONLFromProjectRoot(root, "head")); err != nil {
		t.Errorf("append after Discard did not recreate the log: %v", err)
	}
}

// The timeline is overwhelmingly tool OUTPUT (81-88% of the bytes, measured), so
// a scan for the handful of user messages must not copy - and then parse - all
// of it. This is the shape reconcileClaudeUserEcho runs on every user turn.
func TestStoreEventsOfTypeReturnsOnlyWhatWasAsked(t *testing.T) {
	s, err := Open(t.TempDir(), "head")
	if err != nil {
		t.Fatal(err)
	}
	msg := UserMessage{}
	msg.Id, msg.Content = "u1", json.RawMessage(`[{"type":"text","text":"hi"}]`)
	if _, err := s.Append(msg); err != nil {
		t.Fatal(err)
	}
	tool := ToolCompleted{}
	tool.Id, tool.Output = "t1", json.RawMessage(`"a megabyte of output"`)
	if _, err := s.Append(tool); err != nil {
		t.Fatal(err)
	}
	echo := UserMessageEchoed{}
	echo.UserSeq, echo.Content = 1, msg.Content
	if _, err := s.Append(echo); err != nil {
		t.Fatal(err)
	}

	got := s.EventsOfType("user_message", "user_message_echoed")
	if len(got) != 2 || got[0].Type != "user_message" || got[1].Type != "user_message_echoed" {
		t.Fatalf("EventsOfType = %+v", got)
	}
	if len(s.EventsOfType("user_message")) != 1 {
		t.Errorf("EventsOfType(user_message) = %+v", s.EventsOfType("user_message"))
	}
	if got := s.EventsOfType("nothing_of_the_sort"); got != nil {
		t.Errorf("EventsOfType(unknown) = %+v, want none", got)
	}
	// Detached: mutating what a caller was handed cannot reach the store.
	got[0].Payload[0] = 'X'
	if again := s.EventsOfType("user_message"); again[0].Payload[0] == 'X' {
		t.Error("EventsOfType handed out the store's own payload")
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

func TestProjectionRetainsRunningTurnStartTime(t *testing.T) {
	p := Projection{Version: ProjectionVersion, Subagents: map[string]SubagentState{}, Queue: map[string]QueuedState{}}
	started := time.Date(2026, time.August, 30, 12, 0, 0, 0, time.UTC)
	apply(&p, Event{Seq: 1, Type: "turn_started", Timestamp: started, Payload: json.RawMessage(`{"id":"turn","status":"running"}`)})
	if p.Turn == nil || p.Turn.StartedAt == nil || !p.Turn.StartedAt.Equal(started) {
		t.Fatalf("turn start = %+v, want %s", p.Turn, started)
	}

	apply(&p, Event{Seq: 2, Type: "turn_completed", Timestamp: started.Add(time.Second), Payload: json.RawMessage(`{"id":"turn","status":"completed"}`)})
	if p.Turn == nil || p.Turn.StartedAt != nil {
		t.Fatalf("settled turn retained running start = %+v", p.Turn)
	}
}

func TestAppendSourceDeduplicatesProviderReplay(t *testing.T) {
	root := t.TempDir()
	s, err := Open(root, "head")
	if err != nil {
		t.Fatal(err)
	}
	first, appended, err := s.AppendSource("claude:u1:block:0", rawPayload{"assistant_message", map[string]string{"text": "hi"}})
	if err != nil || !appended {
		t.Fatalf("first append: appended=%v err=%v", appended, err)
	}
	again, appended, err := s.AppendSource("claude:u1:block:0", rawPayload{"assistant_message", map[string]string{"text": "duplicate"}})
	if err != nil || appended || again.Seq != first.Seq {
		t.Fatalf("duplicate append: event=%+v appended=%v err=%v", again, appended, err)
	}
	reopened, err := Open(root, "head")
	if err != nil {
		t.Fatal(err)
	}
	_, appended, err = reopened.AppendSource("claude:u1:block:0", rawPayload{"assistant_message", map[string]string{"text": "after restart"}})
	if err != nil || appended {
		t.Fatalf("restart duplicate: appended=%v err=%v", appended, err)
	}
}

// A busy chat head emits thousands of events, and every append used to fsync -
// one device flush each. On ext4 an fsync forces a journal commit that unrelated
// writers queue behind, so this made the daemon the largest source of fsyncs on
// the machine while it wrote barely 1.3 MB/s. Appends now flush at most once per
// syncInterval; every event is still written immediately, only the flush is
// coalesced.
func TestStoreCoalescesFsyncs(t *testing.T) {
	s, err := Open(t.TempDir(), "head")
	if err != nil {
		t.Fatal(err)
	}
	clock := time.Unix(1000, 0)
	s.now = func() time.Time { return clock }

	synced := 0
	// Count flushes by watching lastSync advance - it moves only when we fsync.
	appendOne := func(text string) {
		before := s.lastSync
		msg := AssistantMessage{}
		msg.Text = text
		if _, err := s.Append(msg); err != nil {
			t.Fatal(err)
		}
		if !s.lastSync.Equal(before) {
			synced++
		}
	}

	appendOne("first") // lastSync is zero, so this one flushes
	for i := 0; i < 50; i++ {
		clock = clock.Add(10 * time.Millisecond) // 500ms total, under the interval
		appendOne("burst")
	}
	if synced != 1 {
		t.Errorf("flushes during a 500ms burst of 51 events = %d, want 1", synced)
	}

	clock = clock.Add(syncInterval)
	appendOne("after the interval")
	if synced != 2 {
		t.Errorf("flushes after passing syncInterval = %d, want 2", synced)
	}

	// Every event is still in the log regardless of when it was flushed.
	if got := len(s.Events()); got != 52 {
		t.Errorf("events = %d, want 52", got)
	}
}
