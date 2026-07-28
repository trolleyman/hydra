package chat

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestNormalizeClaudeAssistantBlocks(t *testing.T) {
	line := []byte(`{"type":"assistant","uuid":"u1","message":{"id":"m1","content":[{"type":"thinking","thinking":"hmm"},{"type":"tool_use","id":"tool1","name":"Bash","input":{"command":"git commit"}},{"type":"text","text":"done"}]}}`)
	got := normalizeClaude(line)
	if len(got) != 3 {
		t.Fatalf("events = %+v", got)
	}
	want := []string{"reasoning_completed", "tool_started", "assistant_message"}
	for i := range want {
		if got[i].eventType != want[i] || got[i].sourceID != "claude:u1:block:"+string(rune('0'+i)) {
			t.Errorf("event %d = %+v", i, got[i])
		}
	}
}

func TestNormalizeClaudeToolResultAndTurn(t *testing.T) {
	result := normalizeClaude([]byte(`{"type":"user","uuid":"u2","message":{"content":[{"type":"tool_result","tool_use_id":"tool1","content":"ok"}]}}`))
	if len(result) != 1 || result[0].eventType != "tool_completed" {
		t.Fatalf("tool result = %+v", result)
	}
	turn := normalizeClaude([]byte(`{"type":"result","session_id":"s1","is_error":false,"result":"done"}`))
	if len(turn) != 1 || turn[0].eventType != "turn_completed" || turn[0].sourceID != "" {
		t.Fatalf("turn = %+v", turn)
	}
}

// A tool event carries the whole entry the CLI wrote around the block, so the
// chat's Raw panel can show what was recorded rather than the fields something
// thought to copy across - and so the `cwd` (the only record of where a command
// ran, one shell being shared by the whole session) rides along with it. The
// message content is dropped: the payload already carries it, and a tool result
// can be a megabyte.
func TestNormalizeClaudeCarriesTheEntry(t *testing.T) {
	line := []byte(`{"type":"user","uuid":"u9","cwd":"/repo/wt/web","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tool1","content":"ok"}]}}`)
	got := normalizeClaude(line)
	if len(got) != 1 {
		t.Fatalf("events = %+v", got)
	}
	payload, ok := got[0].payload.(map[string]any)
	if !ok {
		t.Fatalf("payload = %T", got[0].payload)
	}
	entry, ok := payload["entry"].(map[string]any)
	if !ok {
		t.Fatalf("entry = %#v", payload["entry"])
	}
	if cwd, _ := entry["cwd"].(string); cwd != "/repo/wt/web" {
		t.Errorf("entry cwd = %q, want /repo/wt/web", cwd)
	}
	msg, ok := entry["message"].(map[string]any)
	if !ok {
		t.Fatalf("entry message = %#v", entry["message"])
	}
	if _, dup := msg["content"]; dup {
		t.Error("entry kept the message content, which the payload already carries")
	}
	if role, _ := msg["role"].(string); role != "user" {
		t.Errorf("entry message lost its other fields: %#v", msg)
	}
}

// An Edit's tool_completed carries the CLI's own structured patch (verbatim),
// so the chat can render the edit as a diff with the file's real line numbers.
// Both field spellings are read: stdout writes tool_use_result, the transcript
// toolUseResult.
func TestNormalizeClaudeEditPatch(t *testing.T) {
	patch := `[{"oldStart":10,"oldLines":3,"newStart":10,"newLines":3,"lines":[" a","-b","+B"," c"]}]`
	for _, field := range []string{"tool_use_result", "toolUseResult"} {
		line := `{"type":"user","uuid":"u9","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"updated"}]},"` +
			field + `":{"filePath":"f.go","oldString":"b","newString":"B","structuredPatch":` + patch + `}}`
		got := normalizeClaude([]byte(line))
		if len(got) != 1 {
			t.Fatalf("%s: events = %+v", field, got)
		}
		raw, ok := got[0].payload.(map[string]any)["patch"].(json.RawMessage)
		if !ok || string(raw) != patch {
			t.Fatalf("%s: patch = %v", field, got[0].payload)
		}
	}
}

// A Write result also carries a structuredPatch (the whole new file), but the
// card renders its content directly - carrying the patch would only duplicate
// the file into the event log. Only oldString+newString (an Edit) qualifies.
func TestNormalizeClaudeNonEditHasNoPatch(t *testing.T) {
	line := `{"type":"user","uuid":"u9","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"created"}]},` +
		`"tool_use_result":{"type":"create","filePath":"f.go","content":"x","structuredPatch":[{"oldStart":1,"newStart":1,"lines":["+x"]}]}}`
	got := normalizeClaude([]byte(line))
	if len(got) != 1 {
		t.Fatalf("events = %+v", got)
	}
	if _, ok := got[0].payload.(map[string]any)["patch"]; ok {
		t.Fatalf("payload carries a patch: %+v", got[0].payload)
	}
}

func TestNormalizeClaudeUserEchoIsIgnored(t *testing.T) {
	got := normalizeClaude([]byte(`{"type":"user","uuid":"u3","message":{"content":[{"type":"text","text":"hello"}]}}`))
	if len(got) != 0 {
		t.Fatalf("events = %+v", got)
	}
}

func TestNormalizeClaudeInterruptEcho(t *testing.T) {
	got := normalizeClaude([]byte(`{"type":"user","uuid":"interrupt","message":{"content":[{"type":"text","text":"[Request interrupted by user]"}]}}`))
	if len(got) != 1 || got[0].eventType != "turn_interrupted" {
		t.Fatalf("events = %+v", got)
	}
}

func TestNormalizeClaudeRichEvents(t *testing.T) {
	tests := []struct {
		line string
		want string
	}{
		{`{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}}`, "assistant_delta"},
		{`{"type":"hydra_thinking","message_id":"m1","duration_ms":1200}`, "reasoning_duration"},
		{`{"type":"system","subtype":"model_refusal_fallback","retractedMessageUuids":["u1"]}`, "messages_retracted"},
		{`{"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion"}}`, "interaction_requested"},
		{`{"type":"user","uuid":"meta","isMeta":true,"message":{"content":[{"type":"text","text":"context"}]}}`, "context_message"},
	}
	for _, tc := range tests {
		got := normalizeClaude([]byte(tc.line))
		if len(got) != 1 || got[0].eventType != tc.want {
			t.Errorf("%s => %+v, want %s", tc.line, got, tc.want)
		}
	}
}

func TestNormalizeClaudeHistoryIncludesPlainUser(t *testing.T) {
	got := normalizeClaudeHistory([]byte(`{"type":"user","uuid":"u3","message":{"content":[{"type":"text","text":"hello"}]}}`))
	if len(got) != 1 || got[0].eventType != "user_message" || got[0].sourceID != "claude:u3" {
		t.Fatalf("events = %+v", got)
	}
}

func TestNormalizeClaudeTaskNotificationSettlesSubagent(t *testing.T) {
	got := normalizeClaude([]byte(`{"type":"queue-operation","content":"<task-notification><task-id>agent-7</task-id><status>completed</status><summary>done</summary></task-notification>"}`))
	if len(got) != 1 || got[0].eventType != "subagent_completed" {
		t.Fatalf("events = %+v", got)
	}
	payload := got[0].payload.(map[string]any)
	if payload["id"] != "agent-7" || payload["status"] != "completed" {
		t.Fatalf("completion payload = %+v", payload)
	}
}

func TestNormalizeClaudeBackgroundCommandDoesNotCreateSubagent(t *testing.T) {
	got := normalizeClaude([]byte(`{"type":"queue-operation","content":"<task-notification><task-id>command-7</task-id><status>completed</status><summary>command done</summary><output-file>/tmp/command-7.log</output-file></task-notification>"}`))
	if len(got) != 1 || got[0].eventType != "notice" {
		t.Fatalf("events = %+v", got)
	}
}

func TestNormalizeClaudeAgentOutputFileStillSettlesSubagent(t *testing.T) {
	got := normalizeClaude([]byte(`{"type":"queue-operation","content":"<task-notification><task-id>agent-8</task-id><status>completed</status><summary>Agent &quot;Explore code&quot; finished</summary><output-file>/tmp/agent-8.output</output-file></task-notification>"}`))
	if len(got) != 1 || got[0].eventType != "subagent_completed" {
		t.Fatalf("events = %+v", got)
	}
}

// Claude records an agent's completion notification twice - the bookkeeping
// record AND the user turn that consumed it. Both must collapse to the same
// subagent_completed source id, or the history normalizer's plain-user fallback
// emits a second user_message the client renders as its own "finished" chip.
func TestNormalizeClaudeAgentNotificationUserTurnDedups(t *testing.T) {
	const notif = `<task-notification><task-id>agent-9</task-id><tool-use-id>toolu_1</tool-use-id><output-file>/tmp/agent-9.output</output-file><status>completed</status><summary>Agent &quot;Trace wiring&quot; finished</summary></task-notification>`
	record := normalizeClaude([]byte(`{"type":"queue-operation","content":"` + notif + `"}`))
	turn := normalizeClaudeHistory([]byte(`{"type":"user","uuid":"u9","message":{"content":` + mustJSON(notif) + `}}`))
	if len(record) != 1 || len(turn) != 1 {
		t.Fatalf("record = %+v, turn = %+v", record, turn)
	}
	if turn[0].eventType != "subagent_completed" || turn[0].sourceID != record[0].sourceID {
		t.Fatalf("turn = %+v, want same source as %+v", turn[0], record[0])
	}
}

func mustJSON(s string) string {
	b, err := json.Marshal(s)
	if err != nil {
		panic(err)
	}
	return string(b)
}

func TestNormalizeClaudeAgentResultDropsContinuationTrailer(t *testing.T) {
	got := normalizeClaude([]byte(`{"type":"user","uuid":"u4","message":{"content":[{"type":"tool_result","tool_use_id":"tool-1","content":[{"type":"text","text":"Useful report"},{"type":"text","text":"agentId: child-1 (use SendMessage...)\n<usage>subagent_tokens: 12</usage>"}]}]}}`))
	if len(got) != 1 || got[0].eventType != "tool_completed" {
		t.Fatalf("events = %+v", got)
	}
	payload := got[0].payload.(map[string]any)
	content, _ := payload["content"].(json.RawMessage)
	if strings.Contains(string(content), "agentId:") || !strings.Contains(string(content), "Useful report") {
		t.Fatalf("content = %s", content)
	}
}
