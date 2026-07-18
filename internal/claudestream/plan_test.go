package claudestream

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writePlanTranscript(t *testing.T, lines ...string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "session.jsonl")
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func toolUse(name, id, input string) string {
	return `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"` + id + `","name":"` + name + `","input":` + input + `}]}}`
}

func toolResult(toolUseID, text string) string {
	return `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"` + toolUseID + `","content":"` + text + `"}]}}`
}

func reconstruct(t *testing.T, path string) []PlanEntry {
	t.Helper()
	raw := ReconstructPlan(path)
	if raw == "" {
		return nil
	}
	var entries []PlanEntry
	if err := json.Unmarshal([]byte(raw), &entries); err != nil {
		t.Fatalf("ReconstructPlan returned invalid JSON: %v", err)
	}
	return entries
}

func TestReconstructPlanTaskLifecycle(t *testing.T) {
	path := writePlanTranscript(t,
		toolUse("TaskCreate", "tu1", `{"subject":"First","description":"d1","activeForm":"Doing first"}`),
		toolResult("tu1", "Task #7 created successfully"),
		toolUse("TaskCreate", "tu2", `{"subject":"Second"}`),
		toolResult("tu2", "Task #8 created successfully"),
		toolUse("TaskUpdate", "tu3", `{"taskId":"7","status":"completed"}`),
		toolUse("TaskUpdate", "tu4", `{"taskId":"8","status":"in_progress","subject":"Second, renamed"}`),
		// An update for a task never created is dropped.
		toolUse("TaskUpdate", "tu5", `{"taskId":"99","status":"completed"}`),
	)
	entries := reconstruct(t, path)
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

func TestReconstructPlanDeleteAndErrorResult(t *testing.T) {
	path := writePlanTranscript(t,
		toolUse("TaskCreate", "tu1", `{"subject":"Kept"}`),
		toolResult("tu1", "Task #1 created"),
		toolUse("TaskCreate", "tu2", `{"subject":"Doomed"}`),
		toolResult("tu2", "Task #2 created"),
		toolUse("TaskUpdate", "tu3", `{"taskId":"2","status":"deleted"}`),
		// An errored create result must not settle the provisional entry.
		toolUse("TaskCreate", "tu4", `{"subject":"Failed"}`),
		`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu4","is_error":true,"content":"nope"}]}}`,
	)
	entries := reconstruct(t, path)
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

func TestReconstructPlanTodoWriteReplacesAndWins(t *testing.T) {
	path := writePlanTranscript(t,
		toolUse("TaskCreate", "tu1", `{"subject":"Old task plan"}`),
		toolResult("tu1", "Task #1 created"),
		toolUse("TodoWrite", "tu2", `{"todos":[{"content":"A","status":"completed","activeForm":"Doing A"},{"content":"B","status":"bogus"}]}`),
	)
	entries := reconstruct(t, path)
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

func TestReconstructPlanTaskAfterTodoClears(t *testing.T) {
	path := writePlanTranscript(t,
		toolUse("TodoWrite", "tu1", `{"todos":[{"content":"Old","status":"pending"}]}`),
		toolUse("TaskCreate", "tu2", `{"subject":"New"}`),
		toolResult("tu2", "Task #1 created"),
	)
	entries := reconstruct(t, path)
	if len(entries) != 1 || entries[0].Key != "1" || entries[0].Content != "New" {
		t.Fatalf("entries = %+v, want the Task* list only", entries)
	}
}

func TestReconstructPlanSkipsSidechainAndMissing(t *testing.T) {
	path := writePlanTranscript(t,
		`{"type":"assistant","isSidechain":true,"message":{"content":[{"type":"tool_use","id":"s1","name":"TaskCreate","input":{"subject":"Sub-agent task"}}]}}`,
	)
	if got := ReconstructPlan(path); got != "" {
		t.Errorf("sidechain-only transcript = %q, want empty", got)
	}
	if got := ReconstructPlan(filepath.Join(t.TempDir(), "missing.jsonl")); got != "" {
		t.Errorf("missing file = %q, want empty", got)
	}
	if got := ReconstructPlan(""); got != "" {
		t.Errorf("empty path = %q, want empty", got)
	}
}

func TestReconstructPlanNumericTaskIDAndNoResultFallback(t *testing.T) {
	path := writePlanTranscript(t,
		toolUse("TaskCreate", "tu1", `{"subject":"No result yet"}`),
		// A numeric taskId (the CLI sends strings, but mirror the client's
		// tolerance) addressing a task settled under its creation-order key.
		toolUse("TaskCreate", "tu2", `{"subject":"Second"}`),
		toolResult("tu2", "created without an id marker"),
		toolUse("TaskUpdate", "tu3", `{"taskId":2,"status":"completed"}`),
	)
	entries := reconstruct(t, path)
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
