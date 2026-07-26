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
