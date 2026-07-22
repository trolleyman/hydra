package chat

import (
	"encoding/json"
	"testing"
)

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

func TestNormalizeCodexTodoList(t *testing.T) {
	got := normalizeCodex([]byte(`{"method":"item/completed","params":{"item":{"id":"p1","type":"todoList","items":[{"text":"inspect","completed":true},{"text":"fix","completed":false}]}}}`))
	if len(got) != 1 || got[0].eventType != "plan_updated" {
		t.Fatalf("todo = %+v", got)
	}
	raw, _ := json.Marshal(got[0].payload)
	var payload struct {
		Plan []struct {
			Content string `json:"content"`
			Status  string `json:"status"`
		} `json:"plan"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil || len(payload.Plan) != 2 || payload.Plan[0].Status != "completed" || payload.Plan[1].Content != "fix" {
		t.Fatalf("payload = %s (%v)", raw, err)
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
