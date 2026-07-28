package chat

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
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
	Request json.RawMessage `json:"request,omitempty"`
	Usage   json.RawMessage `json:"usage,omitempty"`
	Event   json.RawMessage `json:"event,omitempty"`
	// The tool's own structured result, riding alongside the tool_result block.
	// Two spellings for the same field: live stdout stream-json writes it
	// snake_case, the persisted transcript camelCase. Only the Edit slice of it
	// is kept (see editPatch) - the rest holds the whole pre-edit file.
	ToolUseResult      json.RawMessage `json:"tool_use_result,omitempty"`
	ToolUseResultCamel json.RawMessage `json:"toolUseResult,omitempty"`

	RetractedMessageUUIDs []string `json:"retractedMessageUuids,omitempty"`
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
			// The envelope carries ONE tool_use_result, with nothing tying it to
			// a particular block, so it is only attributable when the message
			// holds a single result.
			results := 0
			for _, block := range blocks {
				if block.Type == "tool_result" {
					results++
				}
			}
			var patch json.RawMessage
			if results == 1 {
				patch = editPatch(ev)
			}
			for i, block := range blocks {
				if block.Type == "tool_result" {
					payload := map[string]any{"id": block.ToolUseID, "content": cleanClaudeToolResult(block.Content), "is_error": block.IsError}
					if patch != nil {
						payload["patch"] = patch
					}
					out = append(out, eventSpec{sourceID: claudeBlockSource(base, i), eventType: "tool_completed", payload: richClaudePayload(ev, payload)})
				}
			}
			if len(out) > 0 {
				return out
			}
		}
		userText := textFromClaudeContent(ev.Message.Content)
		if strings.HasPrefix(strings.TrimSpace(userText), "[Request interrupted by user") {
			return []eventSpec{{sourceID: base, eventType: "turn_interrupted", payload: map[string]any{"status": "interrupted"}}}
		}
		// Claude records an agent's completion notification TWICE: as the
		// standalone bookkeeping record (collapsed below) and as the user turn that
		// resumed the parent. Collapse both to the same canonical source id so the
		// second is a no-op append rather than a second "finished" chip - without
		// this the history normalizer's user-event fallback re-emitted it as a
		// user_message, which the client rendered as its own notice.
		if spec := claudeAgentCompletionSpec(userText); spec != nil {
			return spec
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
		if spec := claudeAgentCompletionSpec(ev.Content); spec != nil {
			return spec
		}
		return []eventSpec{{sourceID: base, eventType: "notice", payload: richClaudePayload(ev, map[string]any{"text": ev.Content})}}
	}
	if len(ev.Attachment.Prompt) > 0 && string(ev.Attachment.Prompt) != "null" {
		return []eventSpec{{sourceID: base, eventType: "notice", payload: richClaudePayload(ev, map[string]any{"text": textFromClaudeContent(ev.Attachment.Prompt)})}}
	}
	return nil
}

// cleanClaudeToolResult removes the machine continuation trailer Claude adds
// as a separate text block to Agent results. The child id and usage remain in
// Hydra's sub-agent events/projection; exposing this transport block as report
// prose both leaks protocol detail and prevents report de-duplication.
func cleanClaudeToolResult(raw json.RawMessage) json.RawMessage {
	var blocks []claudeBlock
	if json.Unmarshal(raw, &blocks) != nil {
		return raw
	}
	kept := blocks[:0]
	for _, block := range blocks {
		if block.Type == "text" && strings.HasPrefix(strings.TrimSpace(block.Text), "agentId:") && strings.Contains(block.Text, "<usage>") {
			continue
		}
		kept = append(kept, block)
	}
	if len(kept) == len(blocks) {
		return raw
	}
	out, err := json.Marshal(kept)
	if err != nil {
		return raw
	}
	return out
}

// maxEditPatchBytes caps the structured patch carried on a tool_completed
// event. The patch is roughly old_string + new_string + 6 context lines, so it
// about doubles what an Edit already costs to store; a pathological
// whole-file Edit is not worth that, and the client falls back to diffing the
// two strings itself when the patch is absent.
const maxEditPatchBytes = 128 * 1024

// editPatch returns the Edit tool's own unified patch (the CLI's
// `structuredPatch`: hunks of oldStart/newStart line numbers and ` `/`-`/`+`
// lines) so the chat can render an Edit as a real diff against the file's REAL
// line numbers, rather than as two disembodied string fragments.
//
// Gated on oldString+newString being present, which is what distinguishes an
// Edit result from a Write's (whose patch is the entire new file, already
// rendered as a numbered code block). Returned verbatim as the provider sent
// it; nil when absent, unparseable, not an Edit, or over the size cap.
func editPatch(ev claudeEnvelope) json.RawMessage {
	raw := ev.ToolUseResult
	if len(raw) == 0 {
		raw = ev.ToolUseResultCamel
	}
	if len(raw) == 0 || len(raw) > maxEditPatchBytes {
		return nil
	}
	var res struct {
		OldString       *string         `json:"oldString"`
		NewString       *string         `json:"newString"`
		StructuredPatch json.RawMessage `json:"structuredPatch"`
	}
	if json.Unmarshal(raw, &res) != nil || res.OldString == nil || res.NewString == nil {
		return nil
	}
	if len(res.StructuredPatch) == 0 || string(res.StructuredPatch) == "null" {
		return nil
	}
	return res.StructuredPatch
}

func taskNotificationField(text, field string) string {
	start, end := "<"+field+">", "</"+field+">"
	i := strings.Index(text, start)
	if i < 0 {
		return ""
	}
	rest := text[i+len(start):]
	j := strings.Index(rest, end)
	if j < 0 {
		return ""
	}
	return strings.TrimSpace(rest[:j])
}

// claudeAgentCompletionSpec collapses a spawned agent's completion
// <task-notification> into the one canonical subagent_completed event, or
// returns nil when the text is not one.
//
// Claude uses the same envelope (and output-file field) for spawned agents and
// background shell commands: agent summaries carry the lifecycle distinction
// and become the completion event; command summaries stay expandable notices.
// The source id is derived from the task id alone, so every copy of the same
// notification - the bookkeeping record and the user turn that consumed it -
// dedups to a single stored event instead of rendering two indistinguishable
// "finished" chips.
func claudeAgentCompletionSpec(text string) []eventSpec {
	taskID := taskNotificationField(text, "task-id")
	if taskID == "" || !strings.EqualFold(taskNotificationField(text, "status"), "completed") {
		return nil
	}
	if taskNotificationField(text, "output-file") != "" &&
		!strings.HasPrefix(strings.ToLower(taskNotificationField(text, "summary")), "agent ") {
		return nil
	}
	return []eventSpec{{sourceID: "claude:subagent:" + taskID + ":completed", eventType: "subagent_completed", payload: map[string]any{"id": taskID, "status": "completed"}}}
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
