package http

import (
	"testing"
	"time"

	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/heads"
)

func TestRelayReviewSlotStatusForwardsChangesWithoutDuplicates(t *testing.T) {
	root := t.TempDir()
	headID := "reviewed-head"
	if err := heads.WriteAgentStatus(root, heads.ReviewSessionID(headID), &api.AgentStatusInfo{Status: api.Waiting}); err != nil {
		t.Fatal(err)
	}

	stop := make(chan struct{})
	ticks := make(chan time.Time)
	got := make(chan string, 2)
	go relayReviewSlotStatus(stop, ticks, root, headID, "waiting", func(status string) { got <- status })
	t.Cleanup(func() { close(stop) })

	// Re-reading the same status must not produce repeated socket frames.
	ticks <- time.Now()
	select {
	case status := <-got:
		t.Fatalf("unchanged status emitted as %q", status)
	default:
	}

	if err := heads.WriteAgentStatus(root, heads.ReviewSessionID(headID), &api.AgentStatusInfo{Status: api.Running}); err != nil {
		t.Fatal(err)
	}
	ticks <- time.Now()
	select {
	case status := <-got:
		if status != "running" {
			t.Fatalf("emitted status = %q, want running", status)
		}
	case <-time.After(time.Second):
		t.Fatal("review status change was not emitted")
	}
}
