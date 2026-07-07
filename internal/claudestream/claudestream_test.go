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
