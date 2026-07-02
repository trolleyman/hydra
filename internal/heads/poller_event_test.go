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

// drainSet drains the subscription once and returns the set of event types seen,
// for tests that assert on more than one type from a single poll (Drain clears
// everything, so they cannot call hadAgentsEvent twice).
func drainSet(sub *events.Subscription) map[events.Type]bool {
	m := map[events.Type]bool{}
	for _, ty := range sub.Drain() {
		m[ty] = true
	}
	return m
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
	pollJSONStatusOnce(store, root, deb, hub, nil)
	if !hadAgentsEvent(sub) {
		t.Fatal("first running report did not emit agents_changed")
	}

	// 2) Still running, later timestamp (the hot path: a running agent's next
	// tool-call hook). The timestamp advances but the status string is unchanged,
	// so no event should fire — this is the bug we fixed.
	for i := 1; i <= 3; i++ {
		writeAgentStatusJSON(t, root, id, api.Running, "polling", base.Add(time.Duration(i)*time.Second).Format(time.RFC3339Nano))
		pollJSONStatusOnce(store, root, deb, hub, nil)
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

	// 3) running → needs_input: a genuine transition that also raises the unread
	// flag immediately (the agent is explicitly blocked on the user). Must emit.
	writeAgentStatusJSON(t, root, id, api.NeedsInput, "PermissionRequest", base.Add(4*time.Second).Format(time.RFC3339Nano))
	pollJSONStatusOnce(store, root, deb, hub, nil)
	if !hadAgentsEvent(sub) {
		t.Fatal("running→needs_input transition did not emit agents_changed")
	}
}

// TestPollerSettleHookFiresOnRestingTransition locks in the artifact-prefetch
// trigger: onSettle must fire exactly on a genuine transition into a resting
// status (finished / waiting / needs_input) — the "agent stopped editing" signal
// the prefetcher uses to pre-generate artifacts at once — and must stay silent
// for running, starting and timestamp-only rewrites (which would otherwise kick
// heavy builds on every tool call).
func TestPollerSettleHookFiresOnRestingTransition(t *testing.T) {
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
	var settled []string
	onSettle := func(projectRoot, headID string) {
		if projectRoot != root {
			t.Errorf("onSettle got project %q, want %q", projectRoot, root)
		}
		settled = append(settled, headID)
	}

	base := time.Date(2026, 6, 24, 18, 0, 0, 0, time.UTC)
	// (status written, whether onSettle should have fired by the end of this step)
	steps := []struct {
		status   api.AgentStatus
		wantFire bool
	}{
		{api.Running, false},   // nil → running: not resting
		{api.Running, false},   // running → running (timestamp-only): no transition
		{api.Finished, true},   // running → finished: resting, fires
		{api.Finished, false},  // finished → finished: no transition
		{api.Running, false},   // finished → running: back to work
		{api.Waiting, true},    // running → waiting: resting, fires
		{api.NeedsInput, true}, // waiting → needs_input: resting, fires
		{api.Running, false},   // needs_input → running
	}
	want := 0
	for i, step := range steps {
		ts := base.Add(time.Duration(i) * time.Second).Format(time.RFC3339Nano)
		writeAgentStatusJSON(t, root, id, step.status, "poll", ts)
		before := len(settled)
		pollJSONStatusOnce(store, root, deb, nil, onSettle)
		fired := len(settled) > before
		if fired != step.wantFire {
			t.Fatalf("step %d (%s): onSettle fired=%v, want %v", i, step.status, fired, step.wantFire)
		}
		if step.wantFire {
			want++
		}
	}
	if len(settled) != want {
		t.Fatalf("onSettle fired %d times, want %d", len(settled), want)
	}
	for _, gotID := range settled {
		if gotID != id {
			t.Fatalf("onSettle got head %q, want %q", gotID, id)
		}
	}
}

// TestPollerRaisesUnreadOnSessionExit locks in the fix for an agent that finishes
// and then exits before the grace window elapses: the deferred unread flag, armed
// on running→finished, would otherwise be dropped when the next poll sees the
// session gone. The session ending is definitive proof of a real finish (a
// subagent blip keeps the same session alive), so the flag must be raised — and
// because it moves the cross-project unread total, a broadcast projects_changed
// must fire alongside the in-project agents_changed.
func TestPollerRaisesUnreadOnSessionExit(t *testing.T) {
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

	// Establish the running baseline, then running→finished arms the deferred
	// unread without raising it yet.
	writeAgentStatusJSON(t, root, id, api.Running, "PostToolUse", base.Format(time.RFC3339Nano))
	pollJSONStatusOnce(store, root, deb, hub, nil)
	sub.Drain()
	writeAgentStatusJSON(t, root, id, api.Finished, "Stop", base.Add(time.Second).Format(time.RFC3339Nano))
	pollJSONStatusOnce(store, root, deb, hub, nil)
	if agents, err := store.ListAgents(root); err != nil {
		t.Fatalf("list agents: %v", err)
	} else if agents[0].HasUnreadChanges {
		t.Fatal("unread raised immediately on running→finished; it should defer for the grace window")
	}
	sub.Drain()

	// The agent process exits before graceUnread elapses: its session stops. The
	// next poll must raise the pending unread rather than forget it.
	if err := store.UpdateSessionInfo(id, 0, "stopped"); err != nil {
		t.Fatalf("mark session stopped: %v", err)
	}
	pollJSONStatusOnce(store, root, deb, hub, nil)

	agents, err := store.ListAgents(root)
	if err != nil {
		t.Fatalf("list agents: %v", err)
	}
	if !agents[0].HasUnreadChanges {
		t.Fatal("unread not raised when the session exited with a deferred finish pending")
	}
	ev := drainSet(sub)
	if !ev[events.AgentsChanged] {
		t.Error("no agents_changed after raising unread on session exit")
	}
	if !ev[events.ProjectsChanged] {
		t.Error("no projects_changed broadcast after raising unread (the cross-project total moved)")
	}
}

// TestPollerBroadcastsProjectsChangedOnlyOnUnread verifies the cross-project push
// is scoped to unread raises: a timestamp-only advance (the hot path) emits
// neither event, while a running→needs_input transition that raises the unread
// flag emits both the in-project agents_changed and the broadcast projects_changed
// that updates other-project unread totals (and the browser-tab dot).
func TestPollerBroadcastsProjectsChangedOnlyOnUnread(t *testing.T) {
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

	writeAgentStatusJSON(t, root, id, api.Running, "SessionStart", base.Format(time.RFC3339Nano))
	pollJSONStatusOnce(store, root, deb, hub, nil)
	sub.Drain()

	// Timestamp-only advance while still running: no broadcast on the hot path.
	writeAgentStatusJSON(t, root, id, api.Running, "polling", base.Add(time.Second).Format(time.RFC3339Nano))
	pollJSONStatusOnce(store, root, deb, hub, nil)
	if ev := drainSet(sub); ev[events.ProjectsChanged] {
		t.Error("timestamp-only advance broadcast projects_changed; it must stay off the cross-project path")
	}

	// running→needs_input raises the unread flag → both events fire.
	writeAgentStatusJSON(t, root, id, api.NeedsInput, "PermissionRequest", base.Add(2*time.Second).Format(time.RFC3339Nano))
	pollJSONStatusOnce(store, root, deb, hub, nil)
	ev := drainSet(sub)
	if !ev[events.AgentsChanged] {
		t.Error("needs_input did not emit agents_changed")
	}
	if !ev[events.ProjectsChanged] {
		t.Error("needs_input raised unread but did not broadcast projects_changed")
	}
}

// TestPollerNeedsInputUnreadImmediacy covers the AskUserQuestion fix: a
// running→needs_input transition (the explicit "the agent needs you now" state)
// raises has_unread_changes on the very next poll, whereas the idle "gone quiet"
// nudge (running→waiting) is deferred — it flips the status but does NOT raise
// the unread flag immediately (the debouncer holds it for graceUnread first).
func TestPollerNeedsInputUnreadImmediacy(t *testing.T) {
	cases := []struct {
		name       string
		status     api.AgentStatus
		wantStatus string
		wantUnread bool
	}{
		{"needs_input immediate", api.NeedsInput, "needs_input", true},
		{"waiting deferred", api.Waiting, "waiting", false},
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

			// Establish the running baseline so the next poll sees a transition off
			// "running" (the unread flag only fires on that edge).
			writeAgentStatusJSON(t, root, id, api.Running, "PostToolUse", base.Format(time.RFC3339Nano))
			pollJSONStatusOnce(store, root, deb, hub, nil)

			// The wait arrives.
			writeAgentStatusJSON(t, root, id, c.status, "Notification", base.Add(time.Second).Format(time.RFC3339Nano))
			pollJSONStatusOnce(store, root, deb, hub, nil)

			agents, err := store.ListAgents(root)
			if err != nil {
				t.Fatalf("list agents: %v", err)
			}
			if got := agents[0].AgentStatus; got == nil || *got != c.wantStatus {
				t.Fatalf("status = %v, want %s", got, c.wantStatus)
			}
			if got := agents[0].HasUnreadChanges; got != c.wantUnread {
				t.Errorf("has_unread_changes = %v, want %v for status %q", got, c.wantUnread, c.wantStatus)
			}
		})
	}
}
