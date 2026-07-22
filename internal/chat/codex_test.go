package chat

import "testing"

func TestNormalizeCodexTurnAndItems(t *testing.T) {
	tests := []struct{ line, kind string }{
		{`{"method":"turn/started","params":{"turn":{"id":"t1"}}}`, "turn_started"},
		{`{"method":"item/started","params":{"item":{"id":"i1","type":"command_execution","command":"go test"}}}`, "tool_started"},
		{`{"method":"item/completed","params":{"item":{"id":"i1","type":"command_execution","status":"completed"}}}`, "tool_completed"},
		{`{"method":"item/completed","params":{"item":{"id":"m1","type":"agent_message","text":"done"}}}`, "assistant_message"},
		{`{"method":"turn/completed","params":{"turn":{"id":"t1","status":"completed"}}}`, "turn_completed"},
	}
	for _, tc := range tests {
		got := normalizeCodex([]byte(tc.line))
		if len(got) != 1 || got[0].eventType != tc.kind {
			t.Errorf("%s => %+v, want %s", tc.line, got, tc.kind)
		}
	}
}

func TestNormalizeCodexDeltaAndRequest(t *testing.T) {
	got := normalizeCodex([]byte(`{"method":"item/agentMessage/delta","params":{"itemId":"m1","delta":"hi"}}`))
	if len(got) != 1 || got[0].eventType != "assistant_delta" {
		t.Fatalf("delta = %+v", got)
	}
	got = normalizeCodex([]byte(`{"id":9,"method":"item/commandExecution/requestApproval","params":{"reason":"why"}}`))
	if len(got) != 1 || got[0].eventType != "interaction_requested" {
		t.Fatalf("request = %+v", got)
	}
}
