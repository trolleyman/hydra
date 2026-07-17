package claudestream

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestParseEvent(t *testing.T) {
	cases := []struct {
		line     string
		wantOK   bool
		wantType string
	}{
		{`{"type":"assistant","message":{}}`, true, "assistant"},
		{`  {"type":"result","subtype":"success"}  `, true, "result"},
		{`{"type":"unknown_future_event","x":1}`, true, "unknown_future_event"},
		{`pre-spawn script chatter`, false, ""},
		{`{"no_type":true}`, false, ""},
		{`{"type":"assistant"`, false, ""}, // truncated (mid-line ring wrap)
		{``, false, ""},
	}
	for _, c := range cases {
		ev, ok := ParseEvent([]byte(c.line))
		if ok != c.wantOK || ev.Type != c.wantType {
			t.Errorf("ParseEvent(%q) = (%q, %v), want (%q, %v)", c.line, ev.Type, ok, c.wantType, c.wantOK)
		}
	}
}

func TestParseEventModel(t *testing.T) {
	// The system:init line carries the active model at the top level; the daemon
	// reads it to persist the head's current model.
	init := `{"type":"system","subtype":"init","session_id":"s1","model":"claude-opus-4-8","slash_commands":["compact"]}`
	ev, ok := ParseEvent([]byte(init))
	if !ok || ev.Type != "system" || ev.Subtype != "init" {
		t.Fatalf("ParseEvent(system:init) = (%q/%q, %v)", ev.Type, ev.Subtype, ok)
	}
	if ev.Model != "claude-opus-4-8" {
		t.Errorf("Model = %q, want claude-opus-4-8", ev.Model)
	}
	// A nested per-message model (assistant envelope) must NOT populate the
	// top-level Model, so only the system:init line drives model capture.
	asst := `{"type":"assistant","message":{"model":"<synthetic>","content":[]}}`
	ev, ok = ParseEvent([]byte(asst))
	if !ok || ev.Model != "" {
		t.Errorf("assistant Model = %q (ok=%v), want empty", ev.Model, ok)
	}
}

func TestUserMessageLine(t *testing.T) {
	line, err := UserMessageLine(json.RawMessage(`[{"type":"text","text":"hi"}]`))
	if err != nil {
		t.Fatalf("UserMessageLine: %v", err)
	}
	if !strings.HasSuffix(string(line), "\n") {
		t.Error("line must be newline-terminated")
	}
	var msg struct {
		Type    string `json:"type"`
		Message struct {
			Role    string `json:"role"`
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		} `json:"message"`
	}
	if err := json.Unmarshal(line, &msg); err != nil {
		t.Fatalf("unmarshal built line: %v", err)
	}
	if msg.Type != "user" || msg.Message.Role != "user" || len(msg.Message.Content) != 1 || msg.Message.Content[0].Text != "hi" {
		t.Errorf("unexpected envelope: %s", line)
	}

	if _, err := UserMessageLine(json.RawMessage(`{"not":"an array"}`)); err == nil {
		t.Error("non-array content: expected error")
	}
	if _, err := UserMessageLine(json.RawMessage(`[{"broken"`)); err == nil {
		t.Error("invalid JSON content: expected error")
	}
}

func TestTextUserMessageLine(t *testing.T) {
	line := TextUserMessageLine("fix the bug\nplease")
	ev, ok := ParseEvent(line)
	if !ok || ev.Type != "user" {
		t.Fatalf("built line does not parse as a user event: %s", line)
	}
}

func TestInterruptLine(t *testing.T) {
	line := InterruptLine("hydra-interrupt-1")
	var msg struct {
		Type      string `json:"type"`
		RequestID string `json:"request_id"`
		Request   struct {
			Subtype string `json:"subtype"`
		} `json:"request"`
	}
	if err := json.Unmarshal(line, &msg); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if msg.Type != "control_request" || msg.RequestID != "hydra-interrupt-1" || msg.Request.Subtype != "interrupt" {
		t.Errorf("unexpected interrupt line: %s", line)
	}
}

func TestSetModelLine(t *testing.T) {
	line := SetModelLine("hydra-set-model-1", "sonnet")
	var msg struct {
		Type      string `json:"type"`
		RequestID string `json:"request_id"`
		Request   struct {
			Subtype string `json:"subtype"`
			Model   string `json:"model"`
		} `json:"request"`
	}
	if err := json.Unmarshal(line, &msg); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if msg.Type != "control_request" || msg.RequestID != "hydra-set-model-1" ||
		msg.Request.Subtype != "set_model" || msg.Request.Model != "sonnet" {
		t.Errorf("unexpected set_model line: %s", line)
	}
}

func TestControlResponseLine(t *testing.T) {
	line, err := ControlResponseLine(json.RawMessage(`{"subtype":"success","request_id":"r1","response":{"behavior":"allow"}}`))
	if err != nil {
		t.Fatalf("ControlResponseLine: %v", err)
	}
	var msg struct {
		Type     string `json:"type"`
		Response struct {
			Subtype   string `json:"subtype"`
			RequestID string `json:"request_id"`
		} `json:"response"`
	}
	if err := json.Unmarshal(line, &msg); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if msg.Type != "control_response" || msg.Response.Subtype != "success" || msg.Response.RequestID != "r1" {
		t.Errorf("unexpected control_response line: %s", line)
	}

	if _, err := ControlResponseLine(json.RawMessage(`["not","an","object"]`)); err == nil {
		t.Error("array control response: expected error")
	}
	if _, err := ControlResponseLine(json.RawMessage(`{"broken"`)); err == nil {
		t.Error("invalid JSON control response: expected error")
	}
}

func TestParseToolPermissionRequest(t *testing.T) {
	// A can_use_tool control_request for ExitPlanMode is recognised, with its
	// request_id, tool name and input surfaced.
	line := []byte(`{"type":"control_request","request_id":"req_7","request":{"subtype":"can_use_tool","tool_name":"ExitPlanMode","tool_use_id":"t9","input":{"plan":"do the thing"}}}`)
	req, ok := ParseToolPermissionRequest(line)
	if !ok {
		t.Fatalf("ParseToolPermissionRequest ok=false, want true")
	}
	if req.RequestID != "req_7" || req.ToolName != "ExitPlanMode" {
		t.Errorf("parsed %+v", req)
	}
	if string(req.Input) != `{"plan":"do the thing"}` {
		t.Errorf("input = %s", req.Input)
	}

	// Non-matching lines: a different control subtype, a non-control event, and
	// malformed JSON all report ok=false.
	for _, bad := range []string{
		`{"type":"control_request","request_id":"r","request":{"subtype":"interrupt"}}`,
		`{"type":"control_request","request":{"subtype":"can_use_tool","tool_name":"ExitPlanMode"}}`, // no request_id
		`{"type":"assistant","message":{"content":[]}}`,
		`{"broken"`,
	} {
		if _, ok := ParseToolPermissionRequest([]byte(bad)); ok {
			t.Errorf("ParseToolPermissionRequest(%s) ok=true, want false", bad)
		}
	}
}

func TestApproveToolLine(t *testing.T) {
	line := ApproveToolLine("req_7", json.RawMessage(`{"plan":"p"}`))
	var msg struct {
		Type     string `json:"type"`
		Response struct {
			Subtype   string `json:"subtype"`
			RequestID string `json:"request_id"`
			Response  struct {
				Behavior     string          `json:"behavior"`
				UpdatedInput json.RawMessage `json:"updatedInput"`
			} `json:"response"`
		} `json:"response"`
	}
	if err := json.Unmarshal(line, &msg); err != nil {
		t.Fatalf("unmarshal %s: %v", line, err)
	}
	if msg.Type != "control_response" || msg.Response.Subtype != "success" || msg.Response.RequestID != "req_7" {
		t.Errorf("envelope: %s", line)
	}
	if msg.Response.Response.Behavior != "allow" {
		t.Errorf("behavior = %q, want allow", msg.Response.Response.Behavior)
	}
	if string(msg.Response.Response.UpdatedInput) != `{"plan":"p"}` {
		t.Errorf("updatedInput = %s", msg.Response.Response.UpdatedInput)
	}
	if line[len(line)-1] != '\n' {
		t.Error("line not newline-terminated")
	}

	// A nil/invalid input degrades to an empty object rather than emitting
	// invalid JSON.
	line = ApproveToolLine("r", nil)
	if !strings.Contains(string(line), `"updatedInput":{}`) {
		t.Errorf("nil input line = %s", line)
	}
}

func TestRingFilterOnPlanApproval(t *testing.T) {
	var got []string
	f := &RingFilter{OnPlanApproval: func(requestID string, _ json.RawMessage) {
		got = append(got, requestID)
	}}

	// An ExitPlanMode can_use_tool control_request fires OnPlanApproval and is
	// still persisted to the ring (the client renders the plan card from it).
	kept, _ := f.Filter([]byte(`{"type":"control_request","request_id":"req_1","request":{"subtype":"can_use_tool","tool_name":"ExitPlanMode","input":{"plan":"x"}}}` + "\n"))
	if len(kept) == 0 {
		t.Error("control_request line should still be persisted to the ring")
	}
	// A can_use_tool request for a different tool (AskUserQuestion, answered by
	// the client) does NOT auto-approve; nor do ordinary lines.
	f.Filter([]byte(`{"type":"control_request","request_id":"req_2","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","input":{}}}` + "\n"))
	f.Filter([]byte(`{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}` + "\n"))
	if len(got) != 1 || got[0] != "req_1" {
		t.Fatalf("OnPlanApproval fired %v, want [req_1]", got)
	}
}

func TestParseEventAPIError(t *testing.T) {
	line := []byte(`{"type":"assistant","isApiErrorMessage":true,"message":{"role":"assistant","content":[{"type":"text","text":"API Error: Server error mid-response. The response above may be incomplete."}]}}`)
	ev, ok := ParseEvent(line)
	if !ok || !ev.IsAPIError {
		t.Fatalf("ParseEvent IsAPIError = %v (ok=%v), want true", ev.IsAPIError, ok)
	}
	if got := APIErrorText(line); got != "API Error: Server error mid-response. The response above may be incomplete." {
		t.Errorf("APIErrorText = %q", got)
	}

	// An ordinary assistant message is not flagged.
	ev, _ = ParseEvent([]byte(`{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}`))
	if ev.IsAPIError {
		t.Error("ordinary assistant message flagged IsAPIError")
	}
}

func TestRingFilterOnAPIError(t *testing.T) {
	var got []string
	f := &RingFilter{OnAPIError: func(msg string) { got = append(got, msg) }}

	// A stream_event is dropped (and never an error); a normal assistant line is
	// kept and does not fire; an api-error line fires exactly once with its text.
	f.Filter([]byte(`{"type":"stream_event"}` + "\n"))
	f.Filter([]byte(`{"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}}` + "\n"))
	kept, _ := f.Filter([]byte(`{"type":"assistant","isApiErrorMessage":true,"message":{"content":[{"type":"text","text":"API Error: boom"}]}}` + "\n"))

	if len(got) != 1 || got[0] != "API Error: boom" {
		t.Fatalf("OnAPIError fired %v, want [\"API Error: boom\"]", got)
	}
	if len(kept) == 0 {
		t.Error("api-error line should still be persisted to the ring")
	}
}

func TestRingFilterOnResult(t *testing.T) {
	var results int
	f := &RingFilter{OnResult: func() { results++ }}

	// A `result` line (turn end) fires OnResult exactly once and is persisted;
	// other line types don't fire it.
	f.Filter([]byte(`{"type":"stream_event"}` + "\n"))
	f.Filter([]byte(`{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}` + "\n"))
	kept, _ := f.Filter([]byte(`{"type":"result","subtype":"success","duration_ms":1200}` + "\n"))
	if results != 1 {
		t.Fatalf("OnResult fired %d times, want 1", results)
	}
	if len(kept) == 0 {
		t.Error("result line should still be persisted to the ring")
	}
	// A second result fires again (one drain per turn end).
	f.Filter([]byte(`{"type":"result","subtype":"success"}` + "\n"))
	if results != 2 {
		t.Fatalf("OnResult fired %d times after a second result, want 2", results)
	}
}

func TestRingFilterOnStep(t *testing.T) {
	var steps int
	f := &RingFilter{OnStep: func() { steps++ }}

	// A completed main-conversation assistant line (thinking / tool_use / text)
	// is a step boundary and fires OnStep; user echoes, tool_results, sidechain
	// (sub-agent) lines, api-error lines, stream_events and results do not.
	f.Filter([]byte(`{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"hm"}]}}` + "\n"))
	f.Filter([]byte(`{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash"}]}}` + "\n"))
	if steps != 2 {
		t.Fatalf("OnStep fired %d times after two assistant lines, want 2", steps)
	}
	f.Filter([]byte(`{"type":"user","message":{"content":[{"type":"text","text":"echoed user message"}]}}` + "\n"))
	f.Filter([]byte(`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}` + "\n"))
	f.Filter([]byte(`{"type":"assistant","isSidechain":true,"agentId":"sub1","message":{"content":[{"type":"text","text":"sub"}]}}` + "\n"))
	f.Filter([]byte(`{"type":"assistant","isApiErrorMessage":true,"message":{"content":[{"type":"text","text":"API Error"}]}}` + "\n"))
	f.Filter([]byte(`{"type":"stream_event"}` + "\n"))
	f.Filter([]byte(`{"type":"result","subtype":"success"}` + "\n"))
	if steps != 2 {
		t.Fatalf("OnStep fired %d times after non-step lines, want still 2", steps)
	}
}

func TestRingFilterOnThinking(t *testing.T) {
	// Pin the clock so the measured duration is deterministic, advancing it
	// between the thinking block's start and stop.
	var clock time.Time
	orig := nowFunc
	nowFunc = func() time.Time { return clock }
	defer func() { nowFunc = orig }()

	var gotID string
	var gotMS int64
	var calls int
	f := &RingFilter{OnThinking: func(id string, ms int64) { calls++; gotID, gotMS = id, ms }}

	// message_start pins the id; content_block_start(thinking) stamps the start;
	// content_block_stop 2.5s later reports the duration and injects a synthetic
	// hydra_thinking line for live delivery.
	f.Filter([]byte(`{"type":"stream_event","event":{"type":"message_start","message":{"id":"msg_1"}}}` + "\n"))
	f.Filter([]byte(`{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}}` + "\n"))
	clock = clock.Add(2500 * time.Millisecond)
	_, injected := f.Filter([]byte(`{"type":"stream_event","event":{"type":"content_block_stop","index":0}}` + "\n"))

	if calls != 1 || gotID != "msg_1" || gotMS != 2500 {
		t.Fatalf("OnThinking = (calls %d, id %q, ms %d), want (1, msg_1, 2500)", calls, gotID, gotMS)
	}
	var ev struct {
		Type       string `json:"type"`
		MessageID  string `json:"message_id"`
		DurationMS int64  `json:"duration_ms"`
	}
	if err := json.Unmarshal(injected, &ev); err != nil {
		t.Fatalf("injected line not JSON: %v (%q)", err, injected)
	}
	if ev.Type != "hydra_thinking" || ev.MessageID != "msg_1" || ev.DurationMS != 2500 {
		t.Fatalf("injected = %+v, want hydra_thinking/msg_1/2500", ev)
	}

	// A non-thinking block's start/stop is ignored (no entry to key on).
	calls = 0
	f.Filter([]byte(`{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"text"}}}` + "\n"))
	_, inj := f.Filter([]byte(`{"type":"stream_event","event":{"type":"content_block_stop","index":1}}` + "\n"))
	if calls != 0 || len(inj) != 0 {
		t.Fatalf("text block fired OnThinking (%d) / injected %q, want neither", calls, inj)
	}
}

func TestRingFilterThinkingBoundaryHold(t *testing.T) {
	// The synthetic hydra_thinking line must not be handed to attachers while a
	// partial line is still buffered - it would splice into the half-line. It is
	// held until the chunk stream next lands on a line boundary.
	f := &RingFilter{}
	f.Filter([]byte(`{"type":"stream_event","event":{"type":"message_start","message":{"id":"m"}}}` + "\n"))
	f.Filter([]byte(`{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}}` + "\n"))

	// The thinking-stop line is complete, but the chunk continues into a partial
	// next line (no trailing newline) - so the injection is HELD this chunk.
	_, inj1 := f.Filter([]byte(`{"type":"stream_event","event":{"type":"content_block_stop","index":0}}` + "\n" + `{"type":"stream_event","even`))
	if len(inj1) != 0 {
		t.Fatalf("injected %q while a partial line was buffered, want held", inj1)
	}
	// Completing the partial reaches a boundary - the held line flushes now.
	_, inj2 := f.Filter([]byte(`t":{"type":"message_stop"}}` + "\n"))
	if len(inj2) == 0 {
		t.Fatalf("held injection not flushed at the next line boundary")
	}
}

func TestLineBufferReassembly(t *testing.T) {
	lb := &LineBuffer{}
	var got []string
	feed := func(chunk string) {
		for _, l := range lb.Feed([]byte(chunk)) {
			got = append(got, string(l))
		}
	}
	feed(`{"type":"a`)
	if len(got) != 0 {
		t.Fatalf("partial chunk produced lines: %v", got)
	}
	feed("\"}\n{\"type\":\"b\"}\n{\"ty")
	feed("pe\":\"c\"}\n")
	want := []string{`{"type":"a"}`, `{"type":"b"}`, `{"type":"c"}`}
	if len(got) != len(want) {
		t.Fatalf("got %d lines %v, want %v", len(got), got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("line %d = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestIsHiddenChatMessage(t *testing.T) {
	cases := []struct {
		name string
		line string
		want bool
	}{
		// The exact shapes claude 2.1.204 writes to the transcript on resuming an
		// interrupted turn (captured in a spike).
		{
			"injected resume prompt (isMeta user)",
			`{"parentUuid":"a0","isSidechain":false,"type":"user","message":{"role":"user","content":[{"type":"text","text":"Continue from where you left off."}]},"isMeta":true,"uuid":"9e"}`,
			true,
		},
		{
			"synthetic no-response reply",
			`{"parentUuid":"9e","isSidechain":false,"type":"assistant","uuid":"40","message":{"model":"<synthetic>","role":"assistant","content":[{"type":"text","text":"No response requested."}]}}`,
			true,
		},
		{
			"any synthetic-model assistant is hidden",
			`{"type":"assistant","message":{"model":"<synthetic>","content":[{"type":"text","text":"(no content)"}]}}`,
			true,
		},
		// Must NOT hide.
		{
			"same text but NOT isMeta (a real user turn) stays",
			`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Continue from where you left off."}]}}`,
			false,
		},
		{
			"isMeta user with different text stays (e.g. injected context)",
			`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"some other injected context"}]},"isMeta":true}`,
			false,
		},
		{
			"real assistant turn stays",
			`{"type":"assistant","message":{"model":"claude-opus-4-8","content":[{"type":"text","text":"hi"}]}}`,
			false,
		},
		{"the Hydra continue nudge stays", string(TextUserMessageLine("Continue")), false},
		{"non-json line", `not json`, false},
		{"empty line", ``, false},
		{"result envelope stays", `{"type":"result","subtype":"success"}`, false},
	}
	for _, c := range cases {
		if got := IsHiddenChatMessage([]byte(c.line)); got != c.want {
			t.Errorf("%s: IsHiddenChatMessage = %v, want %v", c.name, got, c.want)
		}
	}
}
