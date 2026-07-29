package http

import (
	"strconv"
	"testing"
)

// The simulated chat's history has to page exactly like chat.Store.Before, or
// the sim stops being a fair test of the client's load-older path: each page
// oldest-first, next_cursor pointing at the batch before it, and done only when
// the log's start is reached. Walking the cursor must visit every event once,
// in order, with no gap or repeat at a page boundary.
func TestSimChatHistoryPagesTheWholeLog(t *testing.T) {
	const limit = 17 // deliberately not a divisor of the log length
	var seen []int
	cursor := 0
	for page := 0; ; page++ {
		if page > len(simChatLog) {
			t.Fatal("paging never reached the start of the log")
		}
		events, next, done := simChatHistoryPage(cursor, limit)
		var seqs []int
		for _, ev := range events {
			seqs = append(seqs, ev["seq"].(int))
		}
		seen = append(seqs, seen...)
		if done {
			break
		}
		if next == "" {
			t.Fatal("page is not done but offers no cursor to continue from")
		}
		var err error
		if cursor, err = strconv.Atoi(next); err != nil {
			t.Fatalf("next_cursor %q is not a cursor: %v", next, err)
		}
	}
	if len(seen) != len(simChatLog) {
		t.Fatalf("paged %d events, want the whole log (%d)", len(seen), len(simChatLog))
	}
	for i, seq := range seen {
		if seq != i+1 {
			t.Fatalf("event %d has seq %d, want the log walked in order with no gaps", i, seq)
		}
	}
}

// The initial window is the NEWEST events - the conversation opens at its end,
// not its beginning - and says there is more to page in.
func TestSimChatHistoryOpensOnTheNewestEvents(t *testing.T) {
	events, next, done := simChatHistoryPage(0, simChatWindow)
	if len(events) != simChatWindow {
		t.Fatalf("initial window holds %d events, want %d", len(events), simChatWindow)
	}
	if last := events[len(events)-1]["seq"].(int); last != len(simChatLog) {
		t.Fatalf("initial window ends at seq %d, want the newest event (%d)", last, len(simChatLog))
	}
	if done {
		t.Fatal("initial window reports done, but older history exists to page in")
	}
	if next == "" {
		t.Fatal("initial window offers no cursor to page older history with")
	}
}

// Every sub-agent the log introduces must have steps to show when its tab is
// opened - an empty tab is the bug load_subagent exists to prevent.
func TestSimChatEverySubagentHasSteps(t *testing.T) {
	steps := map[string]int{}
	for _, ev := range simChatLog {
		payload, _ := ev["payload"].(map[string]any)
		if agentID, _ := payload["agent_id"].(string); agentID != "" {
			steps[agentID]++
		}
	}
	for _, ev := range simChatLog {
		if ev["type"] != "subagent_started" {
			continue
		}
		payload, _ := ev["payload"].(map[string]any)
		id, _ := payload["id"].(string)
		if steps[id] == 0 {
			t.Errorf("sub-agent %q has no steps in the log, so its tab would open empty", id)
		}
	}
}

// The snapshot is derived from the log, so a sub-agent that finished in the log
// must read as finished in the snapshot - including the resumed background one,
// whose completion is normalized BEFORE the event that introduces it.
func TestSimChatProjectionSettlesFinishedSubagents(t *testing.T) {
	subagents, _ := simChatProjection()["subagents"].(map[string]any)
	for _, id := range []string{"sim_sub_resumed_bg", "sim_sub_nest", "sim_sub_nest_child"} {
		state, ok := subagents[id].(map[string]any)
		if !ok {
			t.Errorf("sub-agent %q missing from the snapshot", id)
			continue
		}
		if state["status"] != "completed" {
			t.Errorf("sub-agent %q status = %v, want completed", id, state["status"])
		}
	}
}
