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
