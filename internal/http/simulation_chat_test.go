package http

import (
	"encoding/json"
	"strconv"
	"testing"

	"github.com/trolleyman/hydra/internal/api"
)

// The simulated chat's history has to page exactly like chat.Store.Before, or
// the sim stops being a fair test of the client's load-older path: each page
// oldest-first, next_cursor pointing at the batch before it, and done only when
// the log's start is reached. Walking the cursor must visit every event once,
// in order, with no gap or repeat at a page boundary.
func TestSimChatHistoryPagesTheWholeLog(t *testing.T) {
	const limit = 17 // deliberately not a divisor of the log length
	var seen []uint64
	cursor := 0
	for page := 0; ; page++ {
		if page > len(simChatLog) {
			t.Fatal("paging never reached the start of the log")
		}
		events, next, done := simChatHistoryPage(cursor, limit)
		var seqs []uint64
		for _, ev := range events {
			seqs = append(seqs, ev.Seq)
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
		if seq != uint64(i+1) {
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
	if last := events[len(events)-1].Seq; last != uint64(len(simChatLog)) {
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
		var payload struct {
			ID      string `json:"id"`
			AgentID string `json:"agent_id"`
		}
		if json.Unmarshal(ev.Payload, &payload) != nil {
			continue
		}
		if payload.AgentID != "" {
			steps[payload.AgentID]++
		}
	}
	for _, ev := range simChatLog {
		if ev.Type != "subagent_started" {
			continue
		}
		var payload struct {
			ID string `json:"id"`
		}
		if json.Unmarshal(ev.Payload, &payload) != nil {
			continue
		}
		id := payload.ID
		if steps[id] == 0 {
			t.Errorf("sub-agent %q has no steps in the log, so its tab would open empty", id)
		}
	}
}

func TestSimChatIncludesAttributedAgentMessage(t *testing.T) {
	for _, ev := range simChatLog {
		if ev.Type != "user_message" {
			continue
		}
		var payload struct {
			Origin        api.MessageOrigin `json:"origin"`
			SourceAgentID string            `json:"source_agent_id"`
		}
		if json.Unmarshal(ev.Payload, &payload) == nil &&
			payload.Origin == api.MessageOriginAgent && payload.SourceAgentID == "api-tests" {
			return
		}
	}
	t.Fatal("simulation chat has no attributed agent collaboration message")
}

// The snapshot is derived from the log, so a sub-agent that finished in the log
// must read as finished in the snapshot - including the resumed background one,
// whose completion is normalized BEFORE the event that introduces it.
func TestSimChatProjectionSettlesFinishedSubagents(t *testing.T) {
	subagents := simChatProjection().Subagents
	for _, id := range []string{"sim_sub_resumed_bg", "sim_sub_nest", "sim_sub_nest_child"} {
		state, ok := subagents[id]
		if !ok {
			t.Errorf("sub-agent %q missing from the snapshot", id)
			continue
		}
		if state.Status != "completed" {
			t.Errorf("sub-agent %q status = %v, want completed", id, state.Status)
		}
	}
}
