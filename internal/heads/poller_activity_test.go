package heads

import (
	"testing"
	"time"

	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/db"
	"github.com/trolleyman/hydra/internal/events"
)

// statusPayloads drains the subscription and returns the AgentStatusChanged
// payloads seen (there is at most one per agent per drain thanks to coalescing).
func statusPayloads(sub *events.Subscription) []AgentStatusPayload {
	var out []AgentStatusPayload
	for _, ev := range sub.Drain() {
		if ev.Type == events.AgentStatusChanged {
			if p, ok := ev.Payload.(AgentStatusPayload); ok {
				out = append(out, p)
			}
		}
	}
	return out
}

// TestPollerPersistsActivityAndEmitsStatusEvent locks in the live-activity
// pipeline: the poller derives activity + last message from status_log.jsonl,
// persists them to the agent row (so GET /agents serves them without re-tailing
// the log and they survive a restart), and pushes a keyed agent_status_changed
// event so clients patch the row in place. Activity is cleared at rest while the
// last message is kept.
func TestPollerPersistsActivityAndEmitsStatusEvent(t *testing.T) {
	root := t.TempDir()
	store, err := db.Open(root)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	const id = "agent1"
	if err := store.UpsertAgent(&db.Agent{ID: id, ProjectPath: root, AgentType: "claude", SessionStatus: "running"}); err != nil {
		t.Fatalf("upsert agent: %v", err)
	}

	hub := events.NewHub()
	sub := hub.Subscribe(root)
	t.Cleanup(sub.Close)
	deb := newUnreadDebouncer()
	base := time.Date(2026, 6, 24, 18, 0, 0, 0, time.UTC)

	// 1) Running with a tool in flight: activity is derived from the log tail and
	// persisted, and the keyed event carries it.
	writeStatusLog(t, root, id,
		`{"hook":{"hook_event_name":"PreToolUse","tool_name":"Edit","tool_input":{"file_path":"/repo/main.go"}}}`,
	)
	writeAgentStatusJSON(t, root, id, api.Running, "PreToolUse", base.Format(time.RFC3339Nano))
	pollJSONStatusOnce(store, root, deb, hub, nil)

	agents, err := store.ListAgents(root)
	if err != nil {
		t.Fatalf("list agents: %v", err)
	}
	if got := agents[0].Activity; got != "Editing main.go" {
		t.Fatalf("persisted activity = %q, want %q", got, "Editing main.go")
	}
	payloads := statusPayloads(sub)
	if len(payloads) != 1 || payloads[0].Activity != "Editing main.go" || payloads[0].Status != "running" {
		t.Fatalf("status event = %+v, want one running/Editing main.go", payloads)
	}

	// 2) Turn ends: the Stop hook carries the closing message; activity clears but
	// the last message is persisted and kept.
	writeStatusLog(t, root, id,
		`{"hook":{"hook_event_name":"PreToolUse","tool_name":"Edit","tool_input":{"file_path":"/repo/main.go"}}}`,
		`{"hook":{"hook_event_name":"Stop","last_assistant_message":"All done."}}`,
	)
	writeAgentStatusJSON(t, root, id, api.Finished, "Stop", base.Add(time.Second).Format(time.RFC3339Nano))
	pollJSONStatusOnce(store, root, deb, hub, nil)

	agents, err = store.ListAgents(root)
	if err != nil {
		t.Fatalf("list agents: %v", err)
	}
	if got := agents[0].Activity; got != "" {
		t.Fatalf("activity = %q, want cleared at rest", got)
	}
	if got := agents[0].LastMessage; got != "All done." {
		t.Fatalf("last message = %q, want %q", got, "All done.")
	}
	payloads = statusPayloads(sub)
	if len(payloads) != 1 || payloads[0].Activity != "" || payloads[0].LastMessage != "All done." || payloads[0].Status != "finished" {
		t.Fatalf("status event = %+v, want one finished/cleared-activity/All done.", payloads)
	}

	// 3) A no-op re-poll (same status.json timestamp) must not re-emit.
	pollJSONStatusOnce(store, root, deb, hub, nil)
	if p := statusPayloads(sub); len(p) != 0 {
		t.Fatalf("no-op re-poll emitted %d status events, want 0", len(p))
	}
}

func TestPollerPersistsProviderNativeLatestThing(t *testing.T) {
	root := t.TempDir()
	store, err := db.Open(root)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	const id = "codex1"
	if err := store.UpsertAgent(&db.Agent{ID: id, ProjectPath: root, AgentType: "codex", SessionStatus: "running"}); err != nil {
		t.Fatalf("upsert agent: %v", err)
	}

	hub := events.NewHub()
	sub := hub.Subscribe(root)
	t.Cleanup(sub.Close)
	base := time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC)
	detail := "# Run backend tests"
	notSuggested := false
	if err := WriteAgentStatus(root, id, &api.AgentStatusInfo{
		Status: api.Running, Timestamp: base.Format(time.RFC3339Nano),
		Activity: &detail, LastMessage: &detail, LastMessageIsSuggestedNextMessage: &notSuggested,
	}); err != nil {
		t.Fatalf("write running status: %v", err)
	}
	pollJSONStatusOnce(store, root, newUnreadDebouncer(), hub, nil)

	agents, err := store.ListAgents(root)
	if err != nil {
		t.Fatalf("list agents: %v", err)
	}
	if agents[0].Activity != detail || agents[0].LastMessage != detail {
		t.Fatalf("running latest thing = activity %q, message %q; want %q", agents[0].Activity, agents[0].LastMessage, detail)
	}
	if agents[0].LastMessageIsSuggested {
		t.Fatal("tool description was marked as a suggested next message")
	}
	if payloads := statusPayloads(sub); len(payloads) != 1 || payloads[0].Activity != detail || payloads[0].LastMessage != detail {
		t.Fatalf("running status event = %+v", payloads)
	}

	// The turn-end snapshot carries the same latest item as LastMessage. At rest
	// activity clears, while the completed tool remains the visible detail.
	if err := WriteAgentStatus(root, id, &api.AgentStatusInfo{
		Status: api.Finished, Timestamp: base.Add(time.Second).Format(time.RFC3339Nano),
		Activity: &detail, LastMessage: &detail, LastMessageIsSuggestedNextMessage: &notSuggested,
	}); err != nil {
		t.Fatalf("write finished status: %v", err)
	}
	pollJSONStatusOnce(store, root, newUnreadDebouncer(), hub, nil)
	agents, err = store.ListAgents(root)
	if err != nil {
		t.Fatalf("list agents: %v", err)
	}
	if agents[0].Activity != "" || agents[0].LastMessage != detail {
		t.Fatalf("finished latest thing = activity %q, message %q; want empty/%q", agents[0].Activity, agents[0].LastMessage, detail)
	}
}

// TestPollerSelfSchedulesUnreadRecheck locks in the self-scheduling of the unread
// debounce: arming a deferred running->finished flag schedules a one-shot re-poll
// of that project, so a cleanly finished head (which writes nothing more, and so
// never pokes the fs watcher) has its flag confirmed at the grace boundary instead
// of waiting out the next backstop tick.
func TestPollerSelfSchedulesUnreadRecheck(t *testing.T) {
	root := t.TempDir()
	store, err := db.Open(root)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	const id = "agent1"
	if err := store.UpsertAgent(&db.Agent{ID: id, ProjectPath: root, AgentType: "claude", SessionStatus: "running"}); err != nil {
		t.Fatalf("upsert agent: %v", err)
	}

	deb := newUnreadDebouncer()
	fixed := time.Date(2026, 6, 24, 18, 0, 0, 0, time.UTC)
	deb.now = func() time.Time { return fixed }
	var scheduled []string
	deb.scheduleRepoll = func(r string) { scheduled = append(scheduled, r) }

	unreadRaised := func() bool {
		agents, err := store.ListAgents(root)
		if err != nil {
			t.Fatalf("list agents: %v", err)
		}
		return agents[0].HasUnreadChanges
	}

	// running, then running -> finished: arms the deferred flag and schedules one
	// re-poll of this project. The flag is NOT raised yet (still within grace).
	writeAgentStatusJSON(t, root, id, api.Running, "SessionStart", fixed.Format(time.RFC3339Nano))
	pollJSONStatusOnce(store, root, deb, nil, nil)
	writeAgentStatusJSON(t, root, id, api.Finished, "Stop", fixed.Add(time.Second).Format(time.RFC3339Nano))
	pollJSONStatusOnce(store, root, deb, nil, nil)
	if len(scheduled) != 1 || scheduled[0] != root {
		t.Fatalf("scheduleRepoll calls = %v, want one for %q", scheduled, root)
	}
	if unreadRaised() {
		t.Fatal("unread raised within the grace window")
	}

	// The scheduled re-poll fires ~graceUnread later (the AfterFunc pokes the poll):
	// simulate it by advancing the clock past the window and re-polling. The flag
	// now matures - without needing a status.json write to trigger it.
	fixed = fixed.Add(time.Second + graceUnread)
	pollJSONStatusOnce(store, root, deb, nil, nil)
	if !unreadRaised() {
		t.Fatal("unread not raised after the grace window elapsed")
	}
	// And no second re-poll was scheduled (arm is idempotent within a window).
	if len(scheduled) != 1 {
		t.Fatalf("scheduleRepoll called %d times, want 1", len(scheduled))
	}
}
