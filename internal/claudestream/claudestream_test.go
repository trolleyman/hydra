package claudestream

import (
	"encoding/json"
	"strings"
	"testing"
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
	kept := f.Filter([]byte(`{"type":"assistant","isApiErrorMessage":true,"message":{"content":[{"type":"text","text":"API Error: boom"}]}}` + "\n"))

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
	kept := f.Filter([]byte(`{"type":"result","subtype":"success","duration_ms":1200}` + "\n"))
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
