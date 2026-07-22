package chat

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
)

type codexMessage struct {
	ID     json.RawMessage `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
}

type codexParams struct {
	ThreadID string `json:"threadId,omitempty"`
	Thread   struct {
		ID    string `json:"id"`
		Model string `json:"model,omitempty"`
	} `json:"thread"`
	Turn struct {
		ID     string          `json:"id"`
		Status string          `json:"status,omitempty"`
		Error  json.RawMessage `json:"error,omitempty"`
		Usage  json.RawMessage `json:"usage,omitempty"`
	} `json:"turn"`
	Item       json.RawMessage `json:"item,omitempty"`
	ItemID     string          `json:"itemId,omitempty"`
	Delta      string          `json:"delta,omitempty"`
	Error      json.RawMessage `json:"error,omitempty"`
	Plan       json.RawMessage `json:"plan,omitempty"`
	Usage      json.RawMessage `json:"usage,omitempty"`
	TokenUsage json.RawMessage `json:"tokenUsage,omitempty"`
}

type codexItem struct {
	ID               string          `json:"id"`
	Type             string          `json:"type"`
	Text             string          `json:"text,omitempty"`
	Review           string          `json:"review,omitempty"`
	Status           string          `json:"status,omitempty"`
	Command          string          `json:"command,omitempty"`
	AggregatedOutput string          `json:"aggregatedOutput,omitempty"`
	Plan             json.RawMessage `json:"plan,omitempty"`
	Summary          []string        `json:"summary,omitempty"`
	Content          json.RawMessage `json:"content,omitempty"`
	CWD              string          `json:"cwd,omitempty"`
	ExitCode         *int            `json:"exitCode,omitempty"`
	DurationMS       *int64          `json:"durationMs,omitempty"`
	Changes          json.RawMessage `json:"changes,omitempty"`
	Server           string          `json:"server,omitempty"`
	Tool             string          `json:"tool,omitempty"`
	Arguments        json.RawMessage `json:"arguments,omitempty"`
	Result           json.RawMessage `json:"result,omitempty"`
	Error            json.RawMessage `json:"error,omitempty"`
	Query            string          `json:"query,omitempty"`
	Path             string          `json:"path,omitempty"`
	SenderThreadID   string          `json:"senderThreadId,omitempty"`
	ReceiverThreadID string          `json:"receiverThreadId,omitempty"`
	NewThreadID      string          `json:"newThreadId,omitempty"`
	Prompt           string          `json:"prompt,omitempty"`
	AgentStatus      json.RawMessage `json:"agentStatus,omitempty"`
	Items            []struct {
		Text      string `json:"text"`
		Completed bool   `json:"completed"`
	} `json:"items,omitempty"`
}

func normalizeCodex(line []byte) []eventSpec {
	var msg codexMessage
	if json.Unmarshal(bytes.TrimSpace(line), &msg) != nil || msg.Method == "" {
		return nil // request responses are consumed by the controller, not history
	}
	var params codexParams
	_ = json.Unmarshal(msg.Params, &params)
	switch msg.Method {
	case "thread/started":
		return []eventSpec{{sourceID: "codex:thread:" + params.Thread.ID, eventType: "conversation_started", payload: map[string]any{"conversation_id": params.Thread.ID, "model": params.Thread.Model}}}
	case "turn/started":
		return []eventSpec{{sourceID: "codex:turn:" + params.Turn.ID + ":started", eventType: "turn_started", payload: map[string]any{"id": params.Turn.ID, "status": "running"}}}
	case "turn/completed":
		kind := "turn_completed"
		status := params.Turn.Status
		if status == "" {
			status = "completed"
		}
		if status == "failed" {
			kind = "turn_failed"
		}
		return []eventSpec{{sourceID: "codex:turn:" + params.Turn.ID + ":completed", eventType: kind, payload: map[string]any{"id": params.Turn.ID, "status": status, "error": params.Turn.Error, "usage": params.Turn.Usage}}}
	case "item/agentMessage/delta":
		return []eventSpec{{eventType: "assistant_delta", payload: map[string]any{"message_id": params.ItemID, "text": params.Delta}}}
	case "item/reasoning/delta", "item/reasoning/summaryTextDelta", "item/reasoning/textDelta":
		return []eventSpec{{eventType: "reasoning_delta", payload: map[string]any{"message_id": params.ItemID, "text": params.Delta}}}
	case "item/commandExecution/outputDelta":
		return []eventSpec{{eventType: "tool_delta", payload: map[string]any{"id": params.ItemID, "text": params.Delta}}}
	case "item/plan/delta":
		return []eventSpec{{eventType: "plan_delta", payload: map[string]any{"id": params.ItemID, "text": params.Delta}}}
	case "turn/plan/updated":
		return []eventSpec{{eventType: "plan_updated", payload: map[string]any{"plan": params.Plan}}}
	case "thread/tokenUsage/updated":
		usage := params.Usage
		if len(params.TokenUsage) > 0 {
			usage = params.TokenUsage
		}
		return []eventSpec{{eventType: "usage_updated", payload: map[string]any{"usage": usage}}}
	case "error":
		return []eventSpec{{eventType: "turn_error", payload: map[string]any{"error": params.Error}}}
	case "serverRequest/resolved":
		return []eventSpec{{eventType: "interaction_resolved", payload: map[string]any{"interaction": params}}}
	case "item/started", "item/completed":
		var item codexItem
		if json.Unmarshal(params.Item, &item) != nil || item.ID == "" {
			return nil
		}
		completed := msg.Method == "item/completed"
		return normalizeCodexItem(item, completed)
	default:
		// Server-initiated requests carry an id. Preserve them as an interaction
		// projection even when a newer Codex version adds an unfamiliar method.
		if len(msg.ID) > 0 && string(msg.ID) != "null" {
			return []eventSpec{{sourceID: "", eventType: "interaction_requested", payload: map[string]any{"interaction": map[string]any{"method": msg.Method, "request_id": msg.ID, "params": json.RawMessage(msg.Params)}, "provider": "codex"}}}
		}
	}
	return nil
}

func normalizeCodexItem(item codexItem, completed bool) []eventSpec {
	source := "codex:item:" + item.ID
	typ := item.Type
	switch typ {
	case "agent_message", "agentMessage":
		if completed {
			return []eventSpec{{sourceID: source + ":completed", eventType: "assistant_message", payload: map[string]any{"message_id": item.ID, "text": item.Text}}}
		}
	case "reasoning":
		kind := "reasoning_started"
		if completed {
			kind = "reasoning_completed"
		}
		text := item.Text
		if text == "" && len(item.Summary) > 0 {
			text = strings.Join(item.Summary, "\n")
		}
		return []eventSpec{{sourceID: source + ":" + kind, eventType: kind, payload: map[string]any{"message_id": item.ID, "text": text, "content": item.Content}}}
	case "plan", "todo_list", "todoList":
		if completed {
			plan := any(item.Plan)
			if len(item.Items) > 0 {
				entries := make([]map[string]any, 0, len(item.Items))
				for i, todo := range item.Items {
					status := "pending"
					if todo.Completed {
						status = "completed"
					}
					entries = append(entries, map[string]any{"key": fmt.Sprintf("codex-%d", i), "content": todo.Text, "status": status, "order": i})
				}
				plan = entries
			}
			return []eventSpec{{sourceID: source + ":completed", eventType: "plan_updated", payload: map[string]any{"plan": plan}}}
		}
	case "user_message", "userMessage":
		return nil // recorded at Hydra's input/queue boundary with its client id
	case "collabToolCall", "collabAgentToolCall":
		kind := "tool_started"
		if completed {
			kind = "tool_completed"
		}
		name, input := codexCollabPresentation(item)
		output := any(item.Result)
		isError := false
		if len(item.Error) > 0 && string(item.Error) != "null" {
			output, isError = item.Error, true
		}
		out := []eventSpec{{sourceID: source + ":" + kind, eventType: kind, payload: map[string]any{
			"id": item.ID, "name": name, "input": input, "output": output,
			"status": item.Status, "is_error": isError,
		}}}
		subID := item.NewThreadID
		if subID == "" {
			subID = item.ReceiverThreadID
		}
		if subID != "" {
			subKind := "subagent_started"
			status := codexAgentStatus(item.AgentStatus, subID)
			if status == "" {
				status = "running"
			}
			if completed && isCodexAgentDone(status) {
				subKind = "subagent_completed"
			}
			if completed && item.Tool == "spawn_agent" && status == "running" {
				out[0].payload.(map[string]any)["output"] = "Async agent launched successfully. The agent is working in the background."
			}
			out = append(out, eventSpec{sourceID: source + ":" + subKind, eventType: subKind, payload: map[string]any{"id": subID, "parent_id": item.SenderThreadID, "parent_item_id": item.ID, "agent_type": "codex", "description": item.Prompt, "prompt": item.Prompt, "status": status}})
		}
		return out
	case "sleep":
		kind := "tool_started"
		if completed {
			kind = "tool_completed"
		}
		return []eventSpec{{sourceID: source + ":" + kind, eventType: kind, payload: map[string]any{
			"id": item.ID, "name": "Wait", "input": map[string]any{"duration_ms": item.DurationMS, "_raw": item}, "status": item.Status,
		}}}
	case "enteredReviewMode":
		return []eventSpec{{sourceID: source + ":review-started", eventType: "notice", payload: map[string]any{"text": "Review started"}}}
	case "exitedReviewMode":
		return []eventSpec{{sourceID: source + ":review-completed", eventType: "assistant_message", payload: map[string]any{"message_id": item.ID, "text": item.Review}}}
	case "contextCompaction", "compacted":
		return []eventSpec{{sourceID: source + ":compacted", eventType: "notice", payload: map[string]any{"text": "Conversation context compacted"}}}
	default:
		kind := "tool_started"
		if completed {
			kind = "tool_completed"
		}
		return []eventSpec{{sourceID: source + ":" + kind, eventType: kind, payload: codexToolPayload(item)}}
	}
	return nil
}

func codexCollabPresentation(item codexItem) (string, map[string]any) {
	name := "Agent"
	switch item.Tool {
	case "wait":
		name = "Wait"
	case "send_input", "send_message":
		name = "SendMessage"
	case "resume_agent":
		name = "ResumeAgent"
	case "close_agent":
		name = "CloseAgent"
	}
	input := map[string]any{"_raw": item}
	if item.Prompt != "" {
		input["prompt"] = item.Prompt
		input["description"] = item.Prompt
	}
	if item.ReceiverThreadID != "" {
		input["agent_id"] = item.ReceiverThreadID
	}
	return name, input
}

func codexAgentStatus(raw json.RawMessage, agentID string) string {
	var status string
	if json.Unmarshal(raw, &status) == nil {
		return status
	}
	var value struct {
		Status string `json:"status"`
		Type   string `json:"type"`
	}
	_ = json.Unmarshal(raw, &value)
	if value.Status != "" {
		return value.Status
	}
	if value.Type != "" {
		return value.Type
	}
	var statuses map[string]json.RawMessage
	if json.Unmarshal(raw, &statuses) == nil {
		if status, ok := statuses[agentID]; ok {
			return codexAgentStatus(status, "")
		}
	}
	return ""
}

func isCodexAgentDone(status string) bool {
	switch strings.ToLower(status) {
	case "completed", "complete", "finished", "failed", "errored", "cancelled", "canceled", "closed", "shutdown":
		return true
	default:
		return false
	}
}

func codexToolPayload(item codexItem) map[string]any {
	output := any(item.AggregatedOutput)
	if item.Type == "mcpToolCall" {
		if len(item.Error) > 0 && string(item.Error) != "null" {
			output = item.Error
		} else {
			output = item.Result
		}
	}
	name := item.Type
	input := any(item)
	switch item.Type {
	case "commandExecution", "command_execution":
		name = "Bash"
		input = map[string]any{"command": item.Command, "cwd": item.CWD, "_raw": item}
	case "fileChange", "file_change":
		name = codexFileChangeName(item.Changes)
		input = map[string]any{"changes": item.Changes, "_raw": item}
		if output == "" {
			output = "Files updated"
		}
	case "webSearch", "web_search":
		name = "WebSearch"
		input = map[string]any{"query": item.Query, "_raw": item}
		if output == "" && item.Query != "" {
			output = "Search completed"
		}
	case "imageView", "image_view":
		name = "View Image"
		input = map[string]any{"path": item.Path, "_raw": item}
	case "mcpToolCall":
		name = "MCP " + item.Server + "::" + item.Tool
		input = map[string]any{"arguments": item.Arguments, "_raw": item}
	}
	return map[string]any{
		"id": item.ID, "name": name, "command": item.Command, "cwd": item.CWD,
		"output": output, "status": item.Status, "exit_code": item.ExitCode,
		"duration_ms": item.DurationMS, "changes": item.Changes, "arguments": item.Arguments, "input": input,
		"query": item.Query, "path": item.Path, "item": item,
	}
}

func codexFileChangeName(changes json.RawMessage) string {
	var parsed []struct {
		Kind struct {
			Type string `json:"type"`
		} `json:"kind"`
	}
	if json.Unmarshal(changes, &parsed) != nil || len(parsed) == 0 {
		return "Edit"
	}
	kind := strings.ToLower(parsed[0].Kind.Type)
	for _, change := range parsed[1:] {
		if strings.ToLower(change.Kind.Type) != kind {
			return "Edit"
		}
	}
	switch kind {
	case "add", "create", "write":
		return "Write"
	case "delete", "remove":
		return "Delete"
	case "move", "rename":
		return "Move"
	default:
		return "Edit"
	}
}
