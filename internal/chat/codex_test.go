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

func TestNormalizeCodexRichItems(t *testing.T) {
	tests := []struct{ line, kind string }{
		{`{"method":"item/completed","params":{"item":{"id":"f1","type":"fileChange","status":"completed","changes":[{"path":"x.go","kind":"update"}]}}}`, "tool_completed"},
		{`{"method":"item/completed","params":{"item":{"id":"m1","type":"mcpToolCall","server":"docs","tool":"search","status":"completed","result":{"content":[]}}}}`, "tool_completed"},
		{`{"method":"item/commandExecution/outputDelta","params":{"itemId":"c1","delta":"ok"}}`, "tool_delta"},
		{`{"method":"error","params":{"error":{"message":"nope"}}}`, "turn_error"},
	}
	for _, tc := range tests {
		got := normalizeCodex([]byte(tc.line))
		if len(got) != 1 || got[0].eventType != tc.kind {
			t.Errorf("%s => %+v, want %s", tc.line, got, tc.kind)
		}
	}
}

func TestNormalizeCodexCollabProjectsSubagent(t *testing.T) {
	got := normalizeCodex([]byte(`{"method":"item/started","params":{"item":{"id":"a1","type":"collabAgentToolCall","tool":"spawn_agent","status":"inProgress","senderThreadId":"root","newThreadId":"child","prompt":"inspect"}}}`))
	if len(got) != 2 || got[0].eventType != "tool_started" || got[1].eventType != "subagent_started" {
		t.Fatalf("events = %+v", got)
	}
}

func TestNormalizeCodexFriendlyToolPayloads(t *testing.T) {
	tests := []struct {
		line string
		name string
		key  string
	}{
		{`{"method":"item/completed","params":{"item":{"id":"w1","type":"webSearch","query":"Hydra docs","status":"completed"}}}`, "WebSearch", "query"},
		{`{"method":"item/completed","params":{"item":{"id":"f1","type":"fileChange","changes":[{"path":"x.go","kind":{"type":"update"},"diff":"package x"}],"status":"completed"}}}`, "Edit", "changes"},
		{`{"method":"item/started","params":{"item":{"id":"v1","type":"imageView","path":"shot.png"}}}`, "View Image", "path"},
	}
	for _, tc := range tests {
		got := normalizeCodex([]byte(tc.line))
		if len(got) != 1 {
			t.Fatalf("%s => %+v", tc.line, got)
		}
		payload := got[0].payload.(map[string]any)
		input, _ := payload["input"].(map[string]any)
		if payload["name"] != tc.name || input[tc.key] == nil {
			t.Errorf("payload = %+v, want name %q and input %q", payload, tc.name, tc.key)
		}
	}
}

func TestCodexFileChangeName(t *testing.T) {
	tests := []struct {
		changes string
		want    string
	}{
		{`[{"kind":{"type":"add"}}]`, "Write"},
		{`[{"kind":{"type":"update"}}]`, "Edit"},
		{`[{"kind":{"type":"delete"}}]`, "Delete"},
		{`[{"kind":{"type":"move"}}]`, "Move"},
		{`[{"kind":{"type":"add"}},{"kind":{"type":"update"}}]`, "Edit"},
	}
	for _, tc := range tests {
		if got := codexFileChangeName(json.RawMessage(tc.changes)); got != tc.want {
			t.Errorf("codexFileChangeName(%s) = %q, want %q", tc.changes, got, tc.want)
		}
	}
}

func TestNormalizeCodexCommandAsBash(t *testing.T) {
	got := normalizeCodex([]byte(`{"method":"item/started","params":{"item":{"id":"c1","type":"commandExecution","command":"/usr/bin/bash -lc \\\"pwd\\\"","cwd":"src"}}}`))
	if len(got) != 1 || got[0].eventType != "tool_started" {
		t.Fatalf("events = %+v", got)
	}
	raw, _ := json.Marshal(got[0].payload)
	var payload struct {
		Name  string `json:"name"`
		Input struct {
			Command string `json:"command"`
			CWD     string `json:"cwd"`
		} `json:"input"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil || payload.Name != "Bash" || payload.Input.CWD != "src" || payload.Input.Command == "" {
		t.Fatalf("payload = %s (%v)", raw, err)
	}
}

func TestCodexChildThreadDecoration(t *testing.T) {
	line := []byte(`{"method":"item/completed","params":{"threadId":"child","item":{"id":"m1","type":"agentMessage","text":"report"}}}`)
	threadID, started := codexLineThreads(line)
	if threadID != "child" || started != "" {
		t.Fatalf("threads = %q, %q", threadID, started)
	}
	specs := normalizeCodex(line)
	if len(specs) != 1 {
		t.Fatalf("events = %+v", specs)
	}
	raw, _ := json.Marshal(withCodexSidechain(specs[0].payload, threadID))
	var payload struct {
		Sidechain bool   `json:"sidechain"`
		AgentID   string `json:"agent_id"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil || !payload.Sidechain || payload.AgentID != "child" {
		t.Fatalf("payload = %s (%v)", raw, err)
	}
}

func TestNormalizeCodexAdditionalRichEvents(t *testing.T) {
	tests := []struct {
		line string
		kind string
	}{
		{`{"method":"turn/plan/updated","params":{"plan":[{"step":"test","status":"inProgress"}]}}`, "plan_updated"},
		{`{"method":"thread/tokenUsage/updated","params":{"tokenUsage":{"total":{"totalTokens":42}}}}`, "usage_updated"},
		{`{"method":"item/reasoning/textDelta","params":{"itemId":"r1","delta":"detail"}}`, "reasoning_delta"},
		{`{"method":"item/started","params":{"item":{"id":"s1","type":"sleep","durationMs":1000}}}`, "tool_started"},
		{`{"method":"item/completed","params":{"item":{"id":"r1","type":"exitedReviewMode","review":"Looks good"}}}`, "assistant_message"},
		{`{"method":"item/completed","params":{"item":{"id":"c1","type":"contextCompaction"}}}`, "notice"},
	}
	for _, tc := range tests {
		got := normalizeCodex([]byte(tc.line))
		if len(got) != 1 || got[0].eventType != tc.kind {
			t.Errorf("%s => %+v, want %s", tc.line, got, tc.kind)
		}
	}
}
