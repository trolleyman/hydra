package chat

import (
	"bytes"
	"encoding/json"
	"fmt"
)

type eventSpec struct {
	sourceID  string
	eventType string
	payload   any
}

type claudeEnvelope struct {
	Type       string `json:"type"`
	Subtype    string `json:"subtype,omitempty"`
	UUID       string `json:"uuid,omitempty"`
	SessionID  string `json:"session_id,omitempty"`
	Model      string `json:"model,omitempty"`
	IsError    bool   `json:"is_error,omitempty"`
	IsAPIError bool   `json:"isApiErrorMessage,omitempty"`
	Result     string `json:"result,omitempty"`
	RequestID  string `json:"request_id,omitempty"`
	IsMeta     bool   `json:"isMeta,omitempty"`
	Message    struct {
		ID      string          `json:"id,omitempty"`
		Content json.RawMessage `json:"content,omitempty"`
	} `json:"message,omitempty"`
	Request json.RawMessage `json:"request,omitempty"`
	Usage   json.RawMessage `json:"usage,omitempty"`
}

type claudeBlock struct {
	Type      string          `json:"type"`
	ID        string          `json:"id,omitempty"`
	Name      string          `json:"name,omitempty"`
	Text      string          `json:"text,omitempty"`
	Thinking  string          `json:"thinking,omitempty"`
	Input     json.RawMessage `json:"input,omitempty"`
	ToolUseID string          `json:"tool_use_id,omitempty"`
	Content   json.RawMessage `json:"content,omitempty"`
	IsError   bool            `json:"is_error,omitempty"`
}

func normalizeClaude(line []byte) []eventSpec {
	var ev claudeEnvelope
	if json.Unmarshal(bytes.TrimSpace(line), &ev) != nil || ev.Type == "" {
		return nil
	}
	base := ""
	if ev.UUID != "" {
		base = "claude:" + ev.UUID
	}
	switch ev.Type {
	case "system":
		if ev.Subtype == "init" {
			return []eventSpec{{sourceID: "claude:" + ev.SessionID + ":init", eventType: "conversation_started", payload: map[string]any{"conversation_id": ev.SessionID, "model": ev.Model}}}
		}
	case "assistant":
		if ev.IsAPIError {
			return []eventSpec{{sourceID: base, eventType: "turn_failed", payload: map[string]any{"id": ev.Message.ID, "status": "failed", "error": textFromClaudeContent(ev.Message.Content)}}}
		}
		var blocks []claudeBlock
		if json.Unmarshal(ev.Message.Content, &blocks) != nil {
			return nil
		}
		out := make([]eventSpec, 0, len(blocks))
		for i, block := range blocks {
			source := fmt.Sprintf("%s:block:%d", base, i)
			switch block.Type {
			case "text":
				out = append(out, eventSpec{sourceID: source, eventType: "assistant_message", payload: map[string]any{"message_id": ev.Message.ID, "text": block.Text}})
			case "thinking":
				out = append(out, eventSpec{sourceID: source, eventType: "reasoning_completed", payload: map[string]any{"message_id": ev.Message.ID, "text": block.Thinking}})
			case "tool_use":
				out = append(out, eventSpec{sourceID: source, eventType: "tool_started", payload: map[string]any{"id": block.ID, "name": block.Name, "input": block.Input}})
			}
		}
		return out
	case "user":
		var blocks []claudeBlock
		if json.Unmarshal(ev.Message.Content, &blocks) == nil {
			out := make([]eventSpec, 0, len(blocks))
			for i, block := range blocks {
				if block.Type == "tool_result" {
					out = append(out, eventSpec{sourceID: fmt.Sprintf("%s:block:%d", base, i), eventType: "tool_completed", payload: map[string]any{"id": block.ToolUseID, "content": block.Content, "is_error": block.IsError}})
				}
			}
			if len(out) > 0 {
				return out
			}
		}
		// Hydra records submitted user messages (and their stable client ids) at
		// the queue/input boundary. Claude echoes them here; emitting the echo too
		// would duplicate the bubble and lose queue reconciliation identity.
		return nil
	case "result":
		kind, status := "turn_completed", "completed"
		if ev.IsError {
			kind, status = "turn_failed", "failed"
		}
		return []eventSpec{{sourceID: base, eventType: kind, payload: map[string]any{"status": status, "result": ev.Result, "usage": ev.Usage}}}
	case "control_request":
		return []eventSpec{{sourceID: "claude:request:" + ev.RequestID, eventType: "interaction_requested", payload: map[string]any{"interaction": json.RawMessage(ev.Request), "request_id": ev.RequestID}}}
	}
	return nil
}

func textFromClaudeContent(raw json.RawMessage) string {
	var blocks []claudeBlock
	if json.Unmarshal(raw, &blocks) != nil {
		return ""
	}
	var out bytes.Buffer
	for _, b := range blocks {
		if b.Type != "text" || b.Text == "" {
			continue
		}
		if out.Len() > 0 {
			out.WriteByte('\n')
		}
		out.WriteString(b.Text)
	}
	return out.String()
}
