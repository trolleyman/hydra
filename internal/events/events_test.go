package events

import (
	"sort"
	"testing"
	"time"
)

func drainTypes(s *Subscription) []Type {
	evs := s.Drain()
	ts := make([]Type, 0, len(evs))
	for _, ev := range evs {
		ts = append(ts, ev.Type)
	}
	sort.Slice(ts, func(i, j int) bool { return ts[i] < ts[j] })
	return ts
}

func TestHubScopingAndBroadcast(t *testing.T) {
	h := NewHub()
	a := h.Subscribe("/proj/a")
	defer a.Close()
	b := h.Subscribe("/proj/b")
	defer b.Close()

	h.AgentsChanged("/proj/a")   // only a
	h.ProjectsChanged()          // both (broadcast)
	h.ServicesChanged("/proj/b") // only b

	gotA := drainTypes(a)
	if len(gotA) != 2 || gotA[0] != AgentsChanged || gotA[1] != ProjectsChanged {
		t.Errorf("a pending = %v, want [agents_changed projects_changed]", gotA)
	}
	gotB := drainTypes(b)
	if len(gotB) != 2 || gotB[0] != ProjectsChanged || gotB[1] != ServicesChanged {
		t.Errorf("b pending = %v, want [projects_changed services_changed]", gotB)
	}
}

func TestHubCoalesces(t *testing.T) {
	h := NewHub()
	s := h.Subscribe("/p")
	defer s.Close()

	for i := 0; i < 100; i++ {
		h.AgentsChanged("/p")
	}
	got := s.Drain()
	if len(got) != 1 || got[0].Type != AgentsChanged {
		t.Fatalf("coalesced pending = %v, want a single agents_changed", got)
	}
	// One wake-up should be queued (capacity 1), and Drain cleared the set.
	if extra := s.Drain(); extra != nil {
		t.Errorf("second drain = %v, want nil", extra)
	}
}

// Payload events coalesce per (Type, Key) with the latest payload winning, and
// ride alongside plain type-level events.
func TestHubPayloadCoalescesPerKey(t *testing.T) {
	h := NewHub()
	s := h.Subscribe("/p")
	defer s.Close()

	for i := 0; i < 50; i++ {
		h.AgentTestsChanged("/p", "agent-1", i)
	}
	h.AgentTestsChanged("/p", "agent-2", "x")
	h.AgentsChanged("/p")

	got := s.Drain()
	if len(got) != 3 {
		t.Fatalf("drained %d events, want 3 (agents_changed + one per agent key): %v", len(got), got)
	}
	byKey := map[string]Event{}
	for _, ev := range got {
		byKey[ev.Key] = ev
	}
	if byKey[""].Type != AgentsChanged {
		t.Errorf("plain event = %+v, want agents_changed", byKey[""])
	}
	if ev := byKey["agent-1"]; ev.Type != AgentTestsChanged || ev.Payload != 49 {
		t.Errorf("agent-1 event = %+v, want latest payload 49", ev)
	}
	if ev := byKey["agent-2"]; ev.Payload != "x" {
		t.Errorf("agent-2 event = %+v, want payload x", ev)
	}
	if extra := s.Drain(); extra != nil {
		t.Errorf("second drain = %v, want nil", extra)
	}
}

func TestHubWakesReader(t *testing.T) {
	h := NewHub()
	s := h.Subscribe("/p")
	defer s.Close()

	select {
	case <-s.C():
		t.Fatal("woke before any event")
	default:
	}

	h.AgentsChanged("/p")
	select {
	case <-s.C():
		// ok
	case <-time.After(time.Second):
		t.Fatal("reader not woken after publish")
	}
}

func TestHubAfterCloseAndNilSafe(t *testing.T) {
	h := NewHub()
	s := h.Subscribe("/p")
	s.Close()
	h.AgentsChanged("/p") // must not panic or deliver
	if got := s.Drain(); got != nil {
		t.Errorf("closed subscriber drained %v, want nil", got)
	}

	var nilHub *Hub
	nilHub.AgentsChanged("/p") // nil-safe: no panic
	nilHub.ProjectsChanged()
}
