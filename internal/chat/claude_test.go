package chat

import "testing"

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
