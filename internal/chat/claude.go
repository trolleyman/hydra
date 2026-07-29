package chat

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/trolleyman/hydra/internal/api"
)

// eventSpec is one event a provider line normalizes to. The payload names its
// own type (see events.go), so a spec cannot claim a type its payload is not.
type eventSpec struct {
	sourceID string
	payload  Payload
}

// eventType is the type the spec's payload declares.
func (e eventSpec) eventType() string {
	if e.payload == nil {
		return ""
	}
	return e.payload.EventType()
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
	MessageId       string   `json:"message_id,omitempty"`
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

// claudeEntry is the CLI's whole entry with the message CONTENT taken out:
// everything it wrote AROUND the block, with no field picked by hand. The chat's
// Raw panel puts the block back inside it, so what it shows is the entry as
// recorded rather than the handful of fields something thought to copy across.
//
// Content is dropped because the payload already carries it, and it is the big
// part - a tool result can be a megabyte of output, and keeping a second copy
// per block would multiply the stored conversation.
func claudeEntry(line []byte) *api.ChatProviderEntry {
	var entry map[string]any
	if json.Unmarshal(bytes.TrimSpace(line), &entry) != nil {
		return nil
	}
	if msg, ok := entry["message"].(map[string]any); ok {
		delete(msg, "content")
	}
	out := api.ChatProviderEntry(entry)
	return &out
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
			started := &ConversationStarted{}
			started.ConversationId, started.Model = ev.SessionID, ev.Model
			started.SlashCommands, started.ApiKeySource = ev.SlashCommands, ev.APIKeySource
			return []eventSpec{{sourceID: "claude:" + ev.SessionID + ":init", payload: started}}
		}
		if ev.Subtype == "model_refusal_fallback" {
			retracted := &MessagesRetracted{}
			retracted.MessageIds = ev.RetractedMessageUUIDs
			return []eventSpec{{sourceID: base + ":retraction", payload: retracted}}
		}
	case "assistant":
		if ev.IsAPIError {
			failed := &TurnFailed{}
			failed.Id, failed.Status = ev.Message.ID, "failed"
			failed.Error, _ = json.Marshal(textFromClaudeContent(ev.Message.Content))
			return []eventSpec{{sourceID: base, payload: failed}}
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
				msg := &AssistantMessage{ProviderContext: claudeContext(ev)}
				msg.MessageId, msg.Text = ev.Message.ID, block.Text
				out = append(out, eventSpec{sourceID: source, payload: msg})
			case "thinking":
				thought := &ReasoningCompleted{ProviderContext: claudeContext(ev)}
				thought.MessageId, thought.Text = ev.Message.ID, block.Thinking
				out = append(out, eventSpec{sourceID: source, payload: thought})
			case "tool_use":
				call := &ToolStarted{ProviderContext: claudeContext(ev)}
				call.Id, call.Name, call.Input = block.ID, block.Name, block.Input
				call.Entry = claudeEntry(line)
				out = append(out, eventSpec{sourceID: source, payload: call})
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
					done := &ToolCompleted{ProviderContext: claudeContext(ev)}
					done.Id, done.Content = block.ToolUseID, cleanClaudeToolResult(block.Content)
					done.IsError, done.Entry, done.Patch = block.IsError, claudeEntry(line), patch
					out = append(out, eventSpec{sourceID: claudeBlockSource(base, i), payload: done})
				}
			}
			if len(out) > 0 {
				return out
			}
		}
		userText := textFromClaudeContent(ev.Message.Content)
		if strings.HasPrefix(strings.TrimSpace(userText), "[Request interrupted by user") {
			interrupted := &TurnInterrupted{}
			interrupted.Status = "interrupted"
			return []eventSpec{{sourceID: base, payload: interrupted}}
		}
		// The compaction preamble is CLI-injected, not typed, so the "Hydra
		// already recorded it" rule below does not apply - and the CLI does not
		// flag it isMeta either, so without this it falls through to nil and only
		// ever enters the log when importClaudeHistory next reads the transcript.
		// That import appends at the tail, so the "Continued from a previous
		// conversation" pill surfaced however many turns later the next attach
		// happened to be. The source id matches the history path's exactly, so
		// that later import dedups to a no-op.
		if isClaudeCompactionPreamble(userText) {
			resumed := &UserMessage{ProviderContext: claudeContext(ev)}
			resumed.Id, resumed.Content = ev.UUID, ev.Message.Content
			return []eventSpec{{sourceID: base, payload: resumed}}
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
			injected := &ContextMessage{ProviderContext: claudeContext(ev)}
			injected.Content, injected.IsMeta = ev.Message.Content, true
			return []eventSpec{{sourceID: base, payload: injected}}
		}
		return nil
	case "result":
		turn := api.ChatTurnPayload{Status: "completed", Result: ev.Result, CostUsd: ev.TotalCostUSD}
		ctx := ProviderContext{Usage: ev.Usage}
		if ev.IsError {
			turn.Status = "failed"
			return []eventSpec{{sourceID: base, payload: &TurnFailed{ProviderContext: ctx, ChatTurnPayload: turn}}}
		}
		return []eventSpec{{sourceID: base, payload: &TurnCompleted{ProviderContext: ctx, ChatTurnPayload: turn}}}
	case "control_request":
		asked := &InteractionRequested{}
		asked.Interaction, asked.RequestId, asked.Provider = json.RawMessage(ev.Request), ev.RequestID, "claude"
		return []eventSpec{{sourceID: "claude:request:" + ev.RequestID, payload: asked}}
	case "stream_event":
		return normalizeClaudeStream(ev.Event)
	case "hydra_thinking":
		measured := &ReasoningDuration{}
		measured.MessageId, measured.DurationMs = ev.MessageId, ev.DurationMS
		return []eventSpec{{sourceID: "claude:thinking:" + ev.MessageId, payload: measured}}
	}
	if ev.Content != "" {
		if spec := claudeAgentCompletionSpec(ev.Content); spec != nil {
			return spec
		}
		note := &Notice{ProviderContext: claudeContext(ev)}
		note.Text = ev.Content
		return []eventSpec{{sourceID: base, payload: note}}
	}
	if len(ev.Attachment.Prompt) > 0 && string(ev.Attachment.Prompt) != "null" {
		note := &Notice{ProviderContext: claudeContext(ev)}
		note.Text = textFromClaudeContent(ev.Attachment.Prompt)
		return []eventSpec{{sourceID: base, payload: note}}
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
	done := &SubagentCompleted{}
	done.Id, done.Status = taskID, "completed"
	return []eventSpec{{sourceID: "claude:subagent:" + taskID + ":completed", payload: done}}
}

// isClaudeCompactionPreamble recognises the summary the CLI injects as the first
// user turn after a context compaction (auto/ran-out-of-context or an explicit
// /compact). The client matches the same opening to collapse it behind the
// "Continued from a previous conversation" pill.
func isClaudeCompactionPreamble(text string) bool {
	return strings.HasPrefix(strings.TrimSpace(text),
		"This session is being continued from a previous conversation")
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
	msg := &UserMessage{ProviderContext: claudeContext(ev)}
	msg.Id, msg.Content = ev.UUID, ev.Message.Content
	return []eventSpec{{sourceID: "claude:" + ev.UUID, payload: msg}}
}

func claudeBlockSource(base string, index int) string {
	if base == "" {
		return ""
	}
	return fmt.Sprintf("%s:block:%d", base, index)
}

// claudeContext is who produced an event and where it belongs, read off the
// envelope once and embedded rather than copied field by field at each site.
func claudeContext(ev claudeEnvelope) ProviderContext {
	return ProviderContext{
		Uuid:         ev.UUID,
		Usage:        ev.Message.Usage,
		StopReason:   ev.Message.StopReason,
		Sidechain:    ev.IsSidechain || ev.ParentToolUseID != "",
		AgentId:      ev.AgentID,
		ParentItemId: ev.ParentToolUseID,
	}
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
		opened := &ContentStreamStarted{}
		opened.Kind = event.ContentBlock.Type
		return []eventSpec{{payload: opened}}
	case "content_block_delta":
		if event.Delta.Type == "text_delta" {
			delta := &AssistantDelta{}
			delta.Text = event.Delta.Text
			return []eventSpec{{payload: delta}}
		}
		if event.Delta.Type == "thinking_delta" {
			delta := &ReasoningDelta{}
			delta.Text = event.Delta.Thinking
			return []eventSpec{{payload: delta}}
		}
	case "message_start":
		usage := &UsageUpdated{}
		usage.MessageId, usage.Usage = event.Message.ID, event.Message.Usage
		return []eventSpec{{payload: usage}}
	case "message_delta":
		usage := &UsageUpdated{}
		usage.Usage = event.Usage
		return []eventSpec{{payload: usage}}
	case "message_stop":
		return []eventSpec{{payload: &ContentStreamCompleted{}}}
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
