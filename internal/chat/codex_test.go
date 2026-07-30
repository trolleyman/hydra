package chat

import (
	"encoding/json"
	"strings"
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
		if len(got) != 1 || got[0].eventType() != tc.kind {
			t.Errorf("%s => %+v, want %s", tc.line, got, tc.kind)
		}
	}
}

func TestNormalizeCodexInterruptedTurn(t *testing.T) {
	for _, status := range []string{"interrupted", "cancelled", "canceled"} {
		line := strings.Replace(`{"method":"turn/completed","params":{"turn":{"id":"t1","status":"STATUS"}}}`, "STATUS", status, 1)
		got := normalizeCodex([]byte(line))
		if len(got) != 1 || got[0].eventType() != "turn_interrupted" {
			t.Errorf("%s => %+v", status, got)
		}
	}
	got := normalizeCodex([]byte(`{"method":"turn/completed","params":{"turn":{"id":"t1","status":"failed","error":{"message":"Turn interrupted by user"}}}}`))
	if len(got) != 1 || got[0].eventType() != "turn_interrupted" {
		t.Fatalf("failed interrupt => %+v", got)
	}
	got = normalizeCodex([]byte(`{"method":"error","params":{"error":{"message":"Turn cancelled"}}}`))
	if len(got) != 1 || got[0].eventType() != "turn_interrupted" {
		t.Fatalf("cancel error => %+v", got)
	}
}

func TestNormalizeCodexTodoList(t *testing.T) {
	got := normalizeCodex([]byte(`{"method":"item/completed","params":{"item":{"id":"p1","type":"todoList","items":[{"text":"inspect","completed":true},{"text":"fix","completed":false}]}}}`))
	if len(got) != 1 || got[0].eventType() != "plan_updated" {
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
	if len(got) != 1 || got[0].eventType() != "assistant_delta" {
		t.Fatalf("delta = %+v", got)
	}
	// Approval prompts are accepted by the controller, so they must not leave a
	// pending interaction behind in the chat state.
	got = normalizeCodex([]byte(`{"id":9,"method":"item/commandExecution/requestApproval","params":{"reason":"why"}}`))
	if len(got) != 0 {
		t.Fatalf("approval request = %+v", got)
	}
	got = normalizeCodex([]byte(`{"id":9,"method":"item/tool/requestUserInput","params":{"questions":[]}}`))
	if len(got) != 1 || got[0].eventType() != "interaction_requested" {
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
		if len(got) != 1 || got[0].eventType() != tc.kind {
			t.Errorf("%s => %+v, want %s", tc.line, got, tc.kind)
		}
	}
}

func TestNormalizeCodexMCPUsesCanonicalNameAndArguments(t *testing.T) {
	got := normalizeCodex([]byte(`{"method":"item/completed","params":{"item":{"id":"m1","type":"mcpToolCall","server":"hydra","tool":"git_commit","arguments":{"message":"fix it","paths":["a.go"]},"status":"completed","result":{"content":[]}}}}`))
	if len(got) != 1 {
		t.Fatalf("events = %+v", got)
	}
	name, input := toolNameAndInput(got[0].payload)
	if name != "mcp__hydra__git_commit" {
		t.Fatalf("name = %q", name)
	}
	if input["message"] != "fix it" {
		t.Errorf("input = %#v", input)
	}
	if _, ok := input["_raw"]; !ok {
		t.Errorf("native Codex item missing from raw input: %#v", input)
	}
}

func TestNormalizeCodexCollabProjectsSubagent(t *testing.T) {
	got := normalizeCodex([]byte(`{"method":"item/started","params":{"item":{"id":"a1","type":"collabAgentToolCall","tool":"spawn_agent","status":"inProgress","senderThreadId":"root","newThreadId":"child","prompt":"inspect"}}}`))
	if len(got) != 2 || got[0].eventType() != "tool_started" || got[1].eventType() != "subagent_started" {
		t.Fatalf("events = %+v", got)
	}
}

func TestNormalizeCodexSpawnWithoutChildIDRemainsActive(t *testing.T) {
	got := normalizeCodex([]byte(`{"method":"item/completed","params":{"item":{"id":"a1","type":"collabAgentToolCall","tool":"spawnAgent","status":"completed","prompt":"inspect"}}}`))
	if len(got) != 1 {
		t.Fatalf("events = %+v", got)
	}
	done, ok := got[0].payload.(*ToolCompleted)
	if !ok || string(done.Output) != `"Async agent launched successfully. The agent is working in the background."` {
		t.Fatalf("output = %#v", got[0].payload)
	}
}

func TestNormalizeCodexCamelCaseAgentControls(t *testing.T) {
	tests := []struct {
		tool string
		name string
	}{
		{"sendMessage", "SendMessage"},
		{"resumeAgent", "ResumeAgent"},
		{"closeAgent", "CloseAgent"},
	}
	for _, tc := range tests {
		line := `{"method":"item/completed","params":{"item":{"id":"a1","type":"collabAgentToolCall","tool":"TOOL","status":"completed","receiverThreadId":"child"}}}`
		line = strings.Replace(line, "TOOL", tc.tool, 1)
		got := normalizeCodex([]byte(line))
		if len(got) != 1 {
			t.Fatalf("%s => %+v", tc.tool, got)
		}
		done, ok := got[0].payload.(*ToolCompleted)
		if !ok {
			t.Fatalf("%s payload = %T", tc.tool, got[0].payload)
		}
		if done.Name != tc.name {
			t.Errorf("%s name = %v, want %s", tc.tool, done.Name, tc.name)
		}
		if tc.tool == "closeAgent" {
			if string(done.Output) != `"Agent closed"` {
				t.Errorf("%s output = %s, want Agent closed", tc.tool, done.Output)
			}
		}
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
		// The cases mix item/started and item/completed on purpose: the friendly
		// name and semantic input are the same either way.
		name, input := toolNameAndInput(got[0].payload)
		if name != tc.name || input[tc.key] == nil {
			t.Errorf("payload = %+v, want name %q and input %q", got[0].payload, tc.name, tc.key)
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
	got := normalizeCodex([]byte(`{"method":"item/started","params":{"item":{"id":"c1","type":"commandExecution","command":"# Inspect the source\npwd","cwd":"src"}}}`))
	if len(got) != 1 || got[0].eventType() != "tool_started" {
		t.Fatalf("events = %+v", got)
	}
	raw, _ := json.Marshal(got[0].payload)
	var payload struct {
		Name  string `json:"name"`
		Input struct {
			Command     string `json:"command"`
			CWD         string `json:"cwd"`
			Description string `json:"description"`
		} `json:"input"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil || payload.Name != "Bash" || payload.Input.CWD != "src" ||
		payload.Input.Command == "" || payload.Input.Description != "Inspect the source" {
		t.Fatalf("payload = %s (%v)", raw, err)
	}
}

func TestCodexCommandDescription(t *testing.T) {
	tests := map[string]string{
		"# Inspect usage\nrg -n usage internal":                            "Inspect usage",
		`/usr/bin/bash -lc "# Run focused tests` + "\n" + `go test ./..."`: "Run focused tests",
		"#!/usr/bin/env bash\n# Build\nmage build":                         "",
		"echo ok\n# This is too late":                                      "",
	}
	for command, want := range tests {
		if got := codexCommandDescription(command); got != want {
			t.Errorf("codexCommandDescription(%q) = %q, want %q", command, got, want)
		}
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
	sc, ok := specs[0].payload.(sidechainSetter)
	if !ok {
		t.Fatalf("payload %T cannot be marked a sidechain step", specs[0].payload)
	}
	sc.SetSidechain(threadID, "spawn")
	raw, _ := json.Marshal(specs[0].payload)
	var payload struct {
		Sidechain bool   `json:"sidechain"`
		AgentID   string `json:"agent_id"`
		ParentId  string `json:"parent_item_id"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil || !payload.Sidechain || payload.AgentID != "child" || payload.ParentId != "spawn" {
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
		if len(got) != 1 || got[0].eventType() != tc.kind {
			t.Errorf("%s => %+v, want %s", tc.line, got, tc.kind)
		}
	}
}

// toolNameAndInput reads the display name and semantic input off a tool event,
// whichever end of the call it is.
func toolNameAndInput(p Payload) (string, map[string]any) {
	var name string
	var raw json.RawMessage
	switch tool := p.(type) {
	case *ToolStarted:
		name, raw = tool.Name, tool.Input
	case *ToolCompleted:
		name, raw = tool.Name, tool.Input
	default:
		return "", nil
	}
	var input map[string]any
	_ = json.Unmarshal(raw, &input)
	return name, input
}
