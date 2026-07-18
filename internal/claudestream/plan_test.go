package claudestream

import (
	"encoding/json"
	"strings"
	"testing"
)

func planTranscript(lines ...string) []byte {
	return []byte(strings.Join(lines, "\n") + "\n")
}

func toolUse(name, id, input string) string {
	return `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"` + id + `","name":"` + name + `","input":` + input + `}]}}`
}

func toolResult(toolUseID, text string) string {
	return `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"` + toolUseID + `","content":"` + text + `"}]}}`
}

func decodePlan(t *testing.T, raw string) []PlanEntry {
	t.Helper()
	if raw == "" {
		return nil
	}
	var entries []PlanEntry
	if err := json.Unmarshal([]byte(raw), &entries); err != nil {
		t.Fatalf("plan JSON invalid: %v", err)
	}
	return entries
}

func reconstruct(t *testing.T, transcript []byte) []PlanEntry {
	t.Helper()
	return decodePlan(t, ReconstructPlanFromTranscript(transcript))
}

func TestPlanTrackerTaskLifecycle(t *testing.T) {
	entries := reconstruct(t, planTranscript(
		toolUse("TaskCreate", "tu1", `{"subject":"First","description":"d1","activeForm":"Doing first"}`),
		toolResult("tu1", "Task #7 created successfully"),
		toolUse("TaskCreate", "tu2", `{"subject":"Second"}`),
		toolResult("tu2", "Task #8 created successfully"),
		toolUse("TaskUpdate", "tu3", `{"taskId":"7","status":"completed"}`),
		toolUse("TaskUpdate", "tu4", `{"taskId":"8","status":"in_progress","subject":"Second, renamed"}`),
		// An update for a task never created is dropped.
		toolUse("TaskUpdate", "tu5", `{"taskId":"99","status":"completed"}`),
	))
	if len(entries) != 2 {
		t.Fatalf("entries = %+v, want 2", entries)
	}
	if entries[0].Key != "7" || entries[0].Status != "completed" || entries[0].Content != "First" ||
		entries[0].Description != "d1" || entries[0].ActiveForm != "Doing first" || entries[0].Order != 1 {
		t.Errorf("first = %+v", entries[0])
	}
	if entries[1].Key != "8" || entries[1].Status != "in_progress" || entries[1].Content != "Second, renamed" || entries[1].Order != 2 {
		t.Errorf("second = %+v", entries[1])
	}
}

func TestPlanTrackerDeleteAndErrorResult(t *testing.T) {
	entries := reconstruct(t, planTranscript(
		toolUse("TaskCreate", "tu1", `{"subject":"Kept"}`),
		toolResult("tu1", "Task #1 created"),
		toolUse("TaskCreate", "tu2", `{"subject":"Doomed"}`),
		toolResult("tu2", "Task #2 created"),
		toolUse("TaskUpdate", "tu3", `{"taskId":"2","status":"deleted"}`),
		// An errored create result must not settle the provisional entry.
		toolUse("TaskCreate", "tu4", `{"subject":"Failed"}`),
		`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu4","is_error":true,"content":"nope"}]}}`,
	))
	if len(entries) != 2 {
		t.Fatalf("entries = %+v, want kept + provisional failed", entries)
	}
	if entries[0].Key != "1" || entries[0].Content != "Kept" {
		t.Errorf("first = %+v", entries[0])
	}
	// The errored create stays under its provisional key (mirrors the client,
	// which only re-keys on a non-error result).
	if entries[1].Key != "use:tu4" || entries[1].Content != "Failed" || entries[1].Status != "pending" {
		t.Errorf("second = %+v", entries[1])
	}
}

func TestPlanTrackerTodoWriteReplacesAndWins(t *testing.T) {
	entries := reconstruct(t, planTranscript(
		toolUse("TaskCreate", "tu1", `{"subject":"Old task plan"}`),
		toolResult("tu1", "Task #1 created"),
		toolUse("TodoWrite", "tu2", `{"todos":[{"content":"A","status":"completed","activeForm":"Doing A"},{"content":"B","status":"bogus"}]}`),
	))
	if len(entries) != 2 {
		t.Fatalf("entries = %+v, want the TodoWrite list", entries)
	}
	if entries[0].Key != "todo:0" || entries[0].Content != "A" || entries[0].Status != "completed" || entries[0].ActiveForm != "Doing A" {
		t.Errorf("first = %+v", entries[0])
	}
	if entries[1].Key != "todo:1" || entries[1].Status != "pending" {
		t.Errorf("second = %+v (bogus status must fall back to pending)", entries[1])
	}
}

func TestPlanTrackerTaskAfterTodoClears(t *testing.T) {
	entries := reconstruct(t, planTranscript(
		toolUse("TodoWrite", "tu1", `{"todos":[{"content":"Old","status":"pending"}]}`),
		toolUse("TaskCreate", "tu2", `{"subject":"New"}`),
		toolResult("tu2", "Task #1 created"),
	))
	if len(entries) != 1 || entries[0].Key != "1" || entries[0].Content != "New" {
		t.Fatalf("entries = %+v, want the Task* list only", entries)
	}
}

func TestPlanTrackerSkipsSidechain(t *testing.T) {
	// Transcript-style (isSidechain) and live-stdout-style (parent_tool_use_id)
	// sub-agent markers must both keep sub-agent tasks out of the main plan.
	if got := ReconstructPlanFromTranscript(planTranscript(
		`{"type":"assistant","isSidechain":true,"message":{"content":[{"type":"tool_use","id":"s1","name":"TaskCreate","input":{"subject":"Sub-agent task"}}]}}`,
		`{"type":"assistant","parent_tool_use_id":"toolu_parent","message":{"content":[{"type":"tool_use","id":"s2","name":"TaskCreate","input":{"subject":"Live sub-agent task"}}]}}`,
	)); got != "" {
		t.Errorf("sidechain-only transcript = %q, want empty", got)
	}
}

func TestPlanTrackerNumericTaskIDAndNoResultFallback(t *testing.T) {
	entries := reconstruct(t, planTranscript(
		toolUse("TaskCreate", "tu1", `{"subject":"No result yet"}`),
		// A numeric taskId (the CLI sends strings, but mirror the client's
		// tolerance) addressing a task settled under its creation-order key.
		toolUse("TaskCreate", "tu2", `{"subject":"Second"}`),
		toolResult("tu2", "created without an id marker"),
		toolUse("TaskUpdate", "tu3", `{"taskId":2,"status":"completed"}`),
	))
	if len(entries) != 2 {
		t.Fatalf("entries = %+v, want 2", entries)
	}
	// tu1 never got a result: stays provisional.
	if entries[0].Key != "use:tu1" || entries[0].Order != 1 {
		t.Errorf("first = %+v", entries[0])
	}
	// tu2's result carried no "#N": falls back to creation order ("2"), which
	// the numeric-id update then addresses.
	if entries[1].Key != "2" || entries[1].Status != "completed" {
		t.Errorf("second = %+v", entries[1])
	}
}

func TestPlanTrackerFeedChangeSignal(t *testing.T) {
	tr := NewPlanTracker()
	if tr.Feed([]byte(`{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}`)) {
		t.Error("unrelated line reported a change")
	}
	if !tr.Feed([]byte(toolUse("TaskCreate", "tu1", `{"subject":"A task"}`))) {
		t.Error("create did not report a change")
	}
	// Re-delivered create: no change (seenCreates guard).
	if tr.Feed([]byte(toolUse("TaskCreate", "tu1", `{"subject":"A task"}`))) {
		t.Error("re-delivered create reported a change")
	}
	if !tr.Feed([]byte(toolResult("tu1", "Task #3 created"))) {
		t.Error("re-keying result did not report a change")
	}
	// An update writing the value the task already has: JSON unchanged.
	tr.Feed([]byte(toolUse("TaskUpdate", "tu2", `{"taskId":"3","status":"completed"}`)))
	if tr.Feed([]byte(toolUse("TaskUpdate", "tu3", `{"taskId":"3","status":"completed"}`))) {
		t.Error("no-op update reported a change")
	}
	if got := len(decodePlan(t, tr.JSON())); got != 1 {
		t.Errorf("tracked %d entries, want 1", got)
	}
}

func TestPlanTrackerSeed(t *testing.T) {
	seedJSON := `[{"key":"4","content":"Seeded","status":"in_progress","order":4}]`
	tr := NewPlanTracker()
	tr.Seed(seedJSON)
	if tr.JSON() != seedJSON {
		t.Errorf("JSON after seed = %q, want the seed back", tr.JSON())
	}
	// An update for the seeded task (whose create this session never saw, e.g.
	// after a daemon restart) lands on it.
	if !tr.Feed([]byte(toolUse("TaskUpdate", "tu1", `{"taskId":"4","status":"completed"}`))) {
		t.Error("update on seeded task did not report a change")
	}
	entries := decodePlan(t, tr.JSON())
	if len(entries) != 1 || entries[0].Key != "4" || entries[0].Status != "completed" {
		t.Errorf("entries = %+v", entries)
	}
	// A new create continues the seeded order.
	tr.Feed([]byte(toolUse("TaskCreate", "tu2", `{"subject":"Next"}`)))
	tr.Feed([]byte(toolResult("tu2", "Task #5 created")))
	entries = decodePlan(t, tr.JSON())
	if len(entries) != 2 || entries[1].Key != "5" || entries[1].Order != 5 {
		t.Errorf("entries = %+v, want the new task at order 5", entries)
	}
}

func TestPlanTrackerSeedTolerantOfGarbage(t *testing.T) {
	for _, seed := range []string{"", "not json", "[]", "{}"} {
		tr := NewPlanTracker()
		tr.Seed(seed)
		if tr.JSON() != "" {
			t.Errorf("Seed(%q) left plan %q, want empty", seed, tr.JSON())
		}
	}
}
