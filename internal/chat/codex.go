package chat

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/codexstream"
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
		started := &ConversationStarted{}
		started.ConversationId, started.Model = params.Thread.ID, params.Thread.Model
		return []eventSpec{{sourceID: "codex:thread:" + params.Thread.ID, payload: started}}
	case "turn/started":
		started := &TurnStarted{}
		started.Id, started.Status = params.Turn.ID, "running"
		return []eventSpec{{sourceID: "codex:turn:" + params.Turn.ID + ":started", payload: started}}
	case "turn/completed":
		kind := "turn_completed"
		status := params.Turn.Status
		if status == "" {
			status = "completed"
		}
		normalizedStatus := strings.ToLower(status)
		if normalizedStatus == "cancelled" || normalizedStatus == "canceled" || normalizedStatus == "interrupted" ||
			strings.Contains(strings.ToLower(string(params.Turn.Error)), "interrupt") || strings.Contains(strings.ToLower(string(params.Turn.Error)), "cancel") {
			kind, status = "turn_interrupted", "interrupted"
		} else if normalizedStatus == "failed" {
			kind = "turn_failed"
		}
		turn := api.ChatTurnPayload{Id: params.Turn.ID, Status: status, Error: params.Turn.Error}
		ctx := ProviderContext{Usage: params.Turn.Usage}
		source := "codex:turn:" + params.Turn.ID + ":completed"
		var payload Payload
		switch kind {
		case "turn_interrupted":
			payload = &TurnInterrupted{ProviderContext: ctx, ChatTurnPayload: turn}
		case "turn_failed":
			payload = &TurnFailed{ProviderContext: ctx, ChatTurnPayload: turn}
		default:
			payload = &TurnCompleted{ProviderContext: ctx, ChatTurnPayload: turn}
		}
		return []eventSpec{{sourceID: source, payload: payload}}
	case "item/agentMessage/delta":
		delta := &AssistantDelta{}
		delta.MessageId, delta.Text = params.ItemID, params.Delta
		return []eventSpec{{payload: delta}}
	case "item/reasoning/delta", "item/reasoning/summaryTextDelta", "item/reasoning/textDelta":
		delta := &ReasoningDelta{}
		delta.MessageId, delta.Text = params.ItemID, params.Delta
		return []eventSpec{{payload: delta}}
	case "item/commandExecution/outputDelta":
		delta := &ToolDelta{}
		delta.Id, delta.Text = params.ItemID, params.Delta
		return []eventSpec{{payload: delta}}
	case "item/plan/delta":
		delta := &PlanDelta{}
		delta.Id, delta.Text = params.ItemID, params.Delta
		return []eventSpec{{payload: delta}}
	case "turn/plan/updated":
		return []eventSpec{{payload: codexPlan(params.Plan)}}
	case "thread/tokenUsage/updated":
		usage := params.Usage
		if len(params.TokenUsage) > 0 {
			usage = params.TokenUsage
		}
		updated := &UsageUpdated{}
		updated.Usage, _ = json.Marshal(usage)
		return []eventSpec{{payload: updated}}
	case "error":
		errorText := strings.ToLower(string(params.Error))
		if strings.Contains(errorText, "interrupt") || strings.Contains(errorText, "cancel") {
			interrupted := &TurnInterrupted{}
			interrupted.Status, interrupted.Error = "interrupted", params.Error
			return []eventSpec{{payload: interrupted}}
		}
		failed := &TurnError{}
		failed.Error = params.Error
		return []eventSpec{{payload: failed}}
	case "serverRequest/resolved":
		resolved := &InteractionResolved{}
		resolved.Interaction, _ = json.Marshal(params)
		return []eventSpec{{payload: resolved}}
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
		// Approval prompts are answered by the controller, so recording them as
		// a pending interaction would leave the chat state waiting on a decision
		// that has already been made.
		if len(msg.ID) > 0 && string(msg.ID) != "null" && !codexstream.AutoApproved(msg.Method) {
			asked := &InteractionRequested{}
			asked.Interaction, _ = json.Marshal(map[string]any{"method": msg.Method, "request_id": msg.ID, "params": json.RawMessage(msg.Params)})
			asked.Provider = "codex"
			return []eventSpec{{payload: asked}}
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
			msg := &AssistantMessage{}
			msg.MessageId, msg.Text = item.ID, item.Text
			return []eventSpec{{sourceID: source + ":completed", payload: msg}}
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
		if kind == "reasoning_completed" {
			thought := &ReasoningCompleted{}
			thought.MessageId, thought.Text = item.ID, text
			return []eventSpec{{sourceID: source + ":" + kind, payload: thought}}
		}
		msg := &AssistantMessage{}
		msg.MessageId, msg.Text = item.ID, text
		return []eventSpec{{sourceID: source + ":" + kind, payload: msg}}
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
			return []eventSpec{{sourceID: source + ":completed", payload: codexPlan(plan)}}
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
		rawInput, _ := json.Marshal(input)
		rawOutput, _ := json.Marshal(output)
		var toolPayload Payload
		if completed {
			done := &ToolCompleted{}
			done.Id, done.Name, done.Input = item.ID, name, rawInput
			done.Output, done.Status, done.IsError = rawOutput, item.Status, isError
			toolPayload = done
		} else {
			call := &ToolStarted{}
			call.Id, call.Name, call.Input = item.ID, name, rawInput
			call.Output, call.Status = rawOutput, item.Status
			toolPayload = call
		}
		out := []eventSpec{{sourceID: source + ":" + kind, payload: toolPayload}}
		subID := item.NewThreadID
		if subID == "" {
			subID = item.ReceiverThreadID
		}
		// Receiver ids on send/resume/close identify the target of an ordinary
		// collaboration control; only spawnAgent owns a new child lifecycle.
		if subID != "" && codexCollabTool(item.Tool) == "spawnagent" {
			subKind := "subagent_started"
			status := codexAgentStatus(item.AgentStatus, subID)
			if status == "" {
				status = "running"
			}
			if completed && isCodexAgentDone(status) {
				subKind = "subagent_completed"
			}
			if completed && codexCollabTool(item.Tool) == "spawnagent" && status == "running" {
				out[0].payload.(outputSetter).SetOutput("Async agent launched successfully. The agent is working in the background.")
			}
			sub := api.ChatSubagentPayload{Id: subID, ParentId: item.SenderThreadID, AgentType: "codex", Description: item.Prompt, Prompt: item.Prompt, Status: status}
			subCtx := ProviderContext{ParentItemId: item.ID}
			var subPayload Payload = &SubagentStarted{ProviderContext: subCtx, ChatSubagentPayload: sub}
			if subKind == "subagent_completed" {
				subPayload = &SubagentCompleted{ProviderContext: subCtx, ChatSubagentPayload: sub}
			}
			out = append(out, eventSpec{sourceID: source + ":" + subKind, payload: subPayload})
		}
		if completed && codexCollabTool(item.Tool) == "spawnagent" && len(item.Result) == 0 {
			out[0].payload.(outputSetter).SetOutput("Async agent launched successfully. The agent is working in the background.")
		}
		if completed && codexCollabTool(item.Tool) == "closeagent" && !isError {
			out[0].payload.(outputSetter).SetOutput("Agent closed")
		}
		return out
	case "sleep":
		kind := "tool_started"
		if completed {
			kind = "tool_completed"
		}
		waitInput, _ := json.Marshal(map[string]any{"duration_ms": item.DurationMS, "_raw": item})
		if completed {
			done := &ToolCompleted{}
			done.Id, done.Name, done.Input, done.Status = item.ID, "Wait", waitInput, item.Status
			return []eventSpec{{sourceID: source + ":" + kind, payload: done}}
		}
		call := &ToolStarted{}
		call.Id, call.Name, call.Input, call.Status = item.ID, "Wait", waitInput, item.Status
		return []eventSpec{{sourceID: source + ":" + kind, payload: call}}
	case "enteredReviewMode":
		note := &Notice{}
		note.Text = "Review started"
		return []eventSpec{{sourceID: source + ":review-started", payload: note}}
	case "exitedReviewMode":
		msg := &AssistantMessage{}
		msg.MessageId, msg.Text = item.ID, item.Review
		return []eventSpec{{sourceID: source + ":review-completed", payload: msg}}
	case "contextCompaction", "compacted":
		note := &Notice{}
		note.Text = "Conversation context compacted"
		return []eventSpec{{sourceID: source + ":compacted", payload: note}}
	default:
		kind := "tool_started"
		if completed {
			kind = "tool_completed"
		}
		return []eventSpec{{sourceID: source + ":" + kind, payload: codexToolPayload(item, completed)}}
	}
	return nil
}

func codexCollabPresentation(item codexItem) (string, map[string]any) {
	name := "Agent"
	switch codexCollabTool(item.Tool) {
	case "wait":
		name = "Wait"
	case "sendinput", "sendmessage":
		name = "SendMessage"
	case "resumeagent":
		name = "ResumeAgent"
	case "closeagent":
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

func codexCollabTool(tool string) string {
	return strings.NewReplacer("_", "", "-", "").Replace(strings.ToLower(tool))
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

// codexToolPayload builds a tool event from a Codex item. `input` carries the
// semantic fields the card renders plus the native item under `_raw`, so the
// flattened duplicates this used to also emit at the top level (command, cwd,
// exit_code, changes, query, ...) are redundant - everything reads them off
// `input`. `cwd` stays, on the context, because the shell-cwd tracking reads it
// there (see lib/shellCwd).
func codexToolPayload(item codexItem, completed bool) Payload {
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
		commandInput := map[string]any{"command": item.Command, "cwd": item.CWD, "_raw": item}
		if description := codexCommandDescription(item.Command); description != "" {
			commandInput["description"] = description
		}
		input = commandInput
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
		name = "mcp__" + item.Server + "__" + item.Tool
		visible := map[string]any{}
		if json.Unmarshal(item.Arguments, &visible) != nil {
			visible["arguments"] = item.Arguments
		}
		visible["_raw"] = item
		input = visible
	}
	rawInput, _ := json.Marshal(input)
	rawOutput, _ := json.Marshal(output)
	ctx := ProviderContext{Cwd: item.CWD}
	if completed {
		done := &ToolCompleted{ProviderContext: ctx}
		done.Id, done.Name, done.Input = item.ID, name, rawInput
		done.Output, done.Status = rawOutput, item.Status
		return done
	}
	call := &ToolStarted{ProviderContext: ctx}
	call.Id, call.Name, call.Input = item.ID, name, rawInput
	call.Output, call.Status = rawOutput, item.Status
	return call
}

// codexCommandDescription reads the convention Hydra puts in Codex's standing
// instructions: a concise `# description` on the first line of a shell script.
// The command itself is preserved byte-for-byte in the event for display, Raw
// view and auditability; this only adds the semantic field Claude supplies
// natively.
func codexCommandDescription(command string) string {
	script := strings.TrimSpace(command)
	for _, launcher := range []string{"bash -lc ", "bash -c ", "/bin/bash -lc ", "/bin/bash -c ", "/usr/bin/bash -lc ", "/usr/bin/bash -c "} {
		if !strings.HasPrefix(script, launcher) {
			continue
		}
		script = strings.TrimSpace(strings.TrimPrefix(script, launcher))
		if len(script) >= 2 && (script[0] == '\'' || script[0] == '"') && script[len(script)-1] == script[0] {
			script = script[1 : len(script)-1]
		}
		break
	}
	first, _, _ := strings.Cut(script, "\n")
	first = strings.TrimSpace(first)
	if !strings.HasPrefix(first, "#") || strings.HasPrefix(first, "#!") {
		return ""
	}
	return strings.TrimSpace(strings.TrimPrefix(first, "#"))
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

// codexPlan builds the plan checkpoint Codex's notifications and plan items both
// produce. Its entries are already the shared PlanEntry shape.
func codexPlan(plan any) *PlanUpdated {
	updated := &PlanUpdated{}
	updated.Provider = "codex"
	updated.Plan, _ = json.Marshal(plan)
	return updated
}
