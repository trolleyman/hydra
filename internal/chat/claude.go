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
	Type            string   `json:"type"`
	Subtype         string   `json:"subtype,omitempty"`
	UUID            string   `json:"uuid,omitempty"`
	SessionID       string   `json:"session_id,omitempty"`
	Model           string   `json:"model,omitempty"`
	SlashCommands   []string `json:"slash_commands,omitempty"`
	APIKeySource    string   `json:"apiKeySource,omitempty"`
	IsError         bool     `json:"is_error,omitempty"`
	IsAPIError      bool     `json:"isApiErrorMessage,omitempty"`
	Result          string   `json:"result,omitempty"`
	RequestID       string   `json:"request_id,omitempty"`
	IsMeta          bool     `json:"isMeta,omitempty"`
	IsSidechain     bool     `json:"isSidechain,omitempty"`
	AgentID         string   `json:"agentId,omitempty"`
	ParentToolUseID string   `json:"parent_tool_use_id,omitempty"`
	Content         string   `json:"content,omitempty"`
	DurationMS      int64    `json:"duration_ms,omitempty"`
	MessageID       string   `json:"message_id,omitempty"`
	TotalCostUSD    float64  `json:"total_cost_usd,omitempty"`
	Message         struct {
		ID         string          `json:"id,omitempty"`
		Content    json.RawMessage `json:"content,omitempty"`
		StopReason string          `json:"stop_reason,omitempty"`
		Usage      json.RawMessage `json:"usage,omitempty"`
	} `json:"message,omitempty"`
	Request               json.RawMessage `json:"request,omitempty"`
	Usage                 json.RawMessage `json:"usage,omitempty"`
	Event                 json.RawMessage `json:"event,omitempty"`
	RetractedMessageUUIDs []string        `json:"retractedMessageUuids,omitempty"`
	Attachment            struct {
		Prompt json.RawMessage `json:"prompt,omitempty"`
	} `json:"attachment,omitempty"`
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
			return []eventSpec{{sourceID: "claude:" + ev.SessionID + ":init", eventType: "conversation_started", payload: map[string]any{"conversation_id": ev.SessionID, "model": ev.Model, "slash_commands": ev.SlashCommands, "api_key_source": ev.APIKeySource}}}
		}
		if ev.Subtype == "model_refusal_fallback" {
			return []eventSpec{{sourceID: base + ":retraction", eventType: "messages_retracted", payload: map[string]any{"message_ids": ev.RetractedMessageUUIDs}}}
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
			source := claudeBlockSource(base, i)
			switch block.Type {
			case "text":
				out = append(out, eventSpec{sourceID: source, eventType: "assistant_message", payload: richClaudePayload(ev, map[string]any{"message_id": ev.Message.ID, "text": block.Text})})
			case "thinking":
				out = append(out, eventSpec{sourceID: source, eventType: "reasoning_completed", payload: richClaudePayload(ev, map[string]any{"message_id": ev.Message.ID, "text": block.Thinking})})
			case "tool_use":
				out = append(out, eventSpec{sourceID: source, eventType: "tool_started", payload: richClaudePayload(ev, map[string]any{"id": block.ID, "name": block.Name, "input": block.Input})})
			}
		}
		return out
	case "user":
		var blocks []claudeBlock
		if json.Unmarshal(ev.Message.Content, &blocks) == nil {
			out := make([]eventSpec, 0, len(blocks))
			for i, block := range blocks {
				if block.Type == "tool_result" {
					out = append(out, eventSpec{sourceID: claudeBlockSource(base, i), eventType: "tool_completed", payload: richClaudePayload(ev, map[string]any{"id": block.ToolUseID, "content": block.Content, "is_error": block.IsError})})
				}
			}
			if len(out) > 0 {
				return out
			}
		}
		// Hydra records submitted user messages (and their stable client ids) at
		// the queue/input boundary. Claude echoes them here; emitting the echo too
		// would duplicate the bubble and lose queue reconciliation identity.
		if ev.IsMeta {
			return []eventSpec{{sourceID: base, eventType: "context_message", payload: richClaudePayload(ev, map[string]any{"content": ev.Message.Content, "is_meta": true})}}
		}
		return nil
	case "result":
		kind, status := "turn_completed", "completed"
		if ev.IsError {
			kind, status = "turn_failed", "failed"
		}
		return []eventSpec{{sourceID: base, eventType: kind, payload: map[string]any{"status": status, "result": ev.Result, "usage": ev.Usage, "cost_usd": ev.TotalCostUSD}}}
	case "control_request":
		return []eventSpec{{sourceID: "claude:request:" + ev.RequestID, eventType: "interaction_requested", payload: map[string]any{"interaction": json.RawMessage(ev.Request), "request_id": ev.RequestID, "provider": "claude"}}}
	case "stream_event":
		return normalizeClaudeStream(ev.Event)
	case "hydra_thinking":
		return []eventSpec{{sourceID: "claude:thinking:" + ev.MessageID, eventType: "reasoning_duration", payload: map[string]any{"message_id": ev.MessageID, "duration_ms": ev.DurationMS}}}
	}
	if ev.Content != "" {
		return []eventSpec{{sourceID: base, eventType: "notice", payload: richClaudePayload(ev, map[string]any{"text": ev.Content})}}
	}
	if len(ev.Attachment.Prompt) > 0 && string(ev.Attachment.Prompt) != "null" {
		return []eventSpec{{sourceID: base, eventType: "notice", payload: richClaudePayload(ev, map[string]any{"text": textFromClaudeContent(ev.Attachment.Prompt)})}}
	}
	return nil
}

func normalizeClaudeHistory(line []byte) []eventSpec {
	specs := normalizeClaude(line)
	if len(specs) > 0 {
		return specs
	}
	var ev claudeEnvelope
	if json.Unmarshal(bytes.TrimSpace(line), &ev) != nil || ev.Type != "user" || ev.UUID == "" {
		return nil
	}
	return []eventSpec{{sourceID: "claude:" + ev.UUID, eventType: "user_message", payload: richClaudePayload(ev, map[string]any{"id": ev.UUID, "content": ev.Message.Content})}}
}

func claudeBlockSource(base string, index int) string {
	if base == "" {
		return ""
	}
	return fmt.Sprintf("%s:block:%d", base, index)
}

func richClaudePayload(ev claudeEnvelope, payload map[string]any) map[string]any {
	payload["uuid"] = ev.UUID
	payload["usage"] = ev.Message.Usage
	payload["stop_reason"] = ev.Message.StopReason
	payload["sidechain"] = ev.IsSidechain || ev.ParentToolUseID != ""
	payload["agent_id"] = ev.AgentID
	payload["parent_item_id"] = ev.ParentToolUseID
	return payload
}

func normalizeClaudeStream(raw json.RawMessage) []eventSpec {
	var event struct {
		Type         string `json:"type"`
		ContentBlock struct {
			Type string `json:"type"`
		} `json:"content_block"`
		Delta struct {
			Type     string `json:"type"`
			Text     string `json:"text"`
			Thinking string `json:"thinking"`
		} `json:"delta"`
		Message struct {
			ID    string          `json:"id"`
			Usage json.RawMessage `json:"usage"`
		} `json:"message"`
		Usage json.RawMessage `json:"usage"`
	}
	if json.Unmarshal(raw, &event) != nil {
		return nil
	}
	switch event.Type {
	case "content_block_start":
		return []eventSpec{{eventType: "content_stream_started", payload: map[string]any{"kind": event.ContentBlock.Type}}}
	case "content_block_delta":
		if event.Delta.Type == "text_delta" {
			return []eventSpec{{eventType: "assistant_delta", payload: map[string]any{"text": event.Delta.Text}}}
		}
		if event.Delta.Type == "thinking_delta" {
			return []eventSpec{{eventType: "reasoning_delta", payload: map[string]any{"text": event.Delta.Thinking}}}
		}
	case "message_start":
		return []eventSpec{{eventType: "usage_updated", payload: map[string]any{"message_id": event.Message.ID, "usage": event.Message.Usage}}}
	case "message_delta":
		return []eventSpec{{eventType: "usage_updated", payload: map[string]any{"usage": event.Usage}}}
	case "message_stop":
		return []eventSpec{{eventType: "content_stream_completed", payload: map[string]any{}}}
	}
	return nil
}

func textFromClaudeContent(raw json.RawMessage) string {
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return text
	}
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
