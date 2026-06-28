package heads

import (
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/db"
	"github.com/trolleyman/hydra/internal/events"
	"github.com/trolleyman/hydra/internal/paths"
)

// writeAgentStatusJSON writes a status.json for id under projectRoot with the
// given status, event and timestamp, matching what the agent's hooks emit.
func writeAgentStatusJSON(t *testing.T, projectRoot, id string, status api.AgentStatus, event, ts string) {
	t.Helper()
	if err := os.MkdirAll(paths.GetStatusDirFromProjectRoot(projectRoot), 0755); err != nil {
		t.Fatalf("mkdir status dir: %v", err)
	}
	info := api.AgentStatusInfo{Status: status, Timestamp: ts}
	if event != "" {
		info.Event = &event
	}
	data, err := json.Marshal(info)
	if err != nil {
		t.Fatalf("marshal status: %v", err)
	}
	if err := os.WriteFile(paths.GetStatusJsonFromProjectRoot(projectRoot, id), data, 0644); err != nil {
		t.Fatalf("write status json: %v", err)
	}
}

// hadAgentsEvent reports whether the subscription saw an agents_changed since it
// was last drained.
func hadAgentsEvent(sub *events.Subscription) bool {
	for _, ty := range sub.Drain() {
		if ty == events.AgentsChanged {
			return true
		}
	}
	return false
}

// TestPollerEventsOnlyOnRenderedChange locks in the traffic fix: while an agent
// stays "running" and merely rewrites status.json (advancing the timestamp on
// every tool call), the poller must persist the timestamp but NOT emit
// agents_changed — that identical AgentResponse would otherwise make every
// connected client refetch agents and push-status ~1×/s for no visible change.
// A real status-string transition (and an immediate user-input wait) must still
// emit.
func TestPollerEventsOnlyOnRenderedChange(t *testing.T) {
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

	// 1) First report: nil → running. A rendered change, so it must emit.
	writeAgentStatusJSON(t, root, id, api.Running, "SessionStart", base.Format(time.RFC3339Nano))
	pollJSONStatusOnce(store, root, deb, hub)
	if !hadAgentsEvent(sub) {
		t.Fatal("first running report did not emit agents_changed")
	}

	// 2) Still running, later timestamp (the hot path: a running agent's next
	// tool-call hook). The timestamp advances but the status string is unchanged,
	// so no event should fire — this is the bug we fixed.
	for i := 1; i <= 3; i++ {
		writeAgentStatusJSON(t, root, id, api.Running, "polling", base.Add(time.Duration(i)*time.Second).Format(time.RFC3339Nano))
		pollJSONStatusOnce(store, root, deb, hub)
		if hadAgentsEvent(sub) {
			t.Fatalf("timestamp-only advance #%d emitted agents_changed (should be silent)", i)
		}
	}

	// Confirm the advancing timestamp was still persisted, so statusTimeAfter keeps
	// working rather than re-firing the same record forever.
	agents, err := store.ListAgents(root)
	if err != nil {
		t.Fatalf("list agents: %v", err)
	}
	if got, want := agents[0].AgentStatusTime, base.Add(3*time.Second).Format(time.RFC3339Nano); got != want {
		t.Fatalf("timestamp not persisted: got %q want %q", got, want)
	}

	// 3) running → waiting via a user-input tool: a genuine transition that also
	// raises the unread flag immediately. Must emit.
	writeAgentStatusJSON(t, root, id, api.Waiting, "PreToolUse", base.Add(4*time.Second).Format(time.RFC3339Nano))
	pollJSONStatusOnce(store, root, deb, hub)
	if !hadAgentsEvent(sub) {
		t.Fatal("running→waiting transition did not emit agents_changed")
	}
}

// writeNotificationStatusJSON writes a status.json for a Notification hook,
// including the notification_type the poller keys its immediacy decision on.
func writeNotificationStatusJSON(t *testing.T, projectRoot, id string, status api.AgentStatus, notificationType, ts string) {
	t.Helper()
	if err := os.MkdirAll(paths.GetStatusDirFromProjectRoot(projectRoot), 0755); err != nil {
		t.Fatalf("mkdir status dir: %v", err)
	}
	event := "Notification"
	file := StatusFile{
		AgentStatusInfo:  api.AgentStatusInfo{Status: status, Event: &event, Timestamp: ts},
		NotificationType: notificationType,
	}
	data, err := json.Marshal(file)
	if err != nil {
		t.Fatalf("marshal status: %v", err)
	}
	if err := os.WriteFile(paths.GetStatusJsonFromProjectRoot(projectRoot, id), data, 0644); err != nil {
		t.Fatalf("write status json: %v", err)
	}
}

// TestPollerNotificationUnreadImmediacy covers the AskUserQuestion fix: a
// running→waiting transition driven by an explicit-prompt Notification
// (elicitation_dialog / permission_prompt) raises has_unread_changes on the very
// next poll, whereas the idle "gone quiet" nudge (idle_prompt) is deferred — it
// flips the status to waiting but does NOT raise the unread flag immediately
// (the debouncer holds it for graceUnread first).
func TestPollerNotificationUnreadImmediacy(t *testing.T) {
	cases := []struct {
		name             string
		notificationType string
		wantUnread       bool
	}{
		{"elicitation_dialog immediate", "elicitation_dialog", true},
		{"permission_prompt immediate", "permission_prompt", true},
		{"idle_prompt deferred", "idle_prompt", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
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
			deb := newUnreadDebouncer()
			base := time.Date(2026, 6, 24, 18, 0, 0, 0, time.UTC)

			// Establish the running baseline so the next poll sees a running→waiting
			// transition (the unread flag only fires on that edge).
			writeAgentStatusJSON(t, root, id, api.Running, "PostToolUse", base.Format(time.RFC3339Nano))
			pollJSONStatusOnce(store, root, deb, hub)

			// The notification arrives.
			writeNotificationStatusJSON(t, root, id, api.Waiting, c.notificationType, base.Add(time.Second).Format(time.RFC3339Nano))
			pollJSONStatusOnce(store, root, deb, hub)

			agents, err := store.ListAgents(root)
			if err != nil {
				t.Fatalf("list agents: %v", err)
			}
			if got := agents[0].AgentStatus; got == nil || *got != "waiting" {
				t.Fatalf("status = %v, want waiting", got)
			}
			if got := agents[0].HasUnreadChanges; got != c.wantUnread {
				t.Errorf("has_unread_changes = %v, want %v for notification_type %q", got, c.wantUnread, c.notificationType)
			}
		})
	}
}
