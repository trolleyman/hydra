package chat

import (
	"bytes"
	"encoding/json"
	"fmt"
)

type codexMessage struct {
	ID     json.RawMessage `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
}

type codexParams struct {
	Thread struct {
		ID    string `json:"id"`
		Model string `json:"model,omitempty"`
	} `json:"thread"`
	Turn struct {
		ID     string          `json:"id"`
		Status string          `json:"status,omitempty"`
		Error  json.RawMessage `json:"error,omitempty"`
	} `json:"turn"`
	Item   json.RawMessage `json:"item,omitempty"`
	ItemID string          `json:"itemId,omitempty"`
	Delta  string          `json:"delta,omitempty"`
}

type codexItem struct {
	ID               string          `json:"id"`
	Type             string          `json:"type"`
	Text             string          `json:"text,omitempty"`
	Status           string          `json:"status,omitempty"`
	Command          string          `json:"command,omitempty"`
	AggregatedOutput string          `json:"aggregatedOutput,omitempty"`
	Plan             json.RawMessage `json:"plan,omitempty"`
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
		return []eventSpec{{sourceID: "codex:turn:" + params.Turn.ID + ":completed", eventType: kind, payload: map[string]any{"id": params.Turn.ID, "status": status, "error": params.Turn.Error}}}
	case "item/agentMessage/delta":
		return []eventSpec{{eventType: "assistant_delta", payload: map[string]any{"message_id": params.ItemID, "text": params.Delta}}}
	case "item/reasoning/delta", "item/reasoning/summaryTextDelta":
		return []eventSpec{{eventType: "reasoning_delta", payload: map[string]any{"message_id": params.ItemID, "text": params.Delta}}}
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
			return []eventSpec{{sourceID: "", eventType: "interaction_requested", payload: map[string]any{"interaction": map[string]any{"method": msg.Method, "params": params}}}}
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
		return []eventSpec{{sourceID: source + ":" + kind, eventType: kind, payload: map[string]any{"message_id": item.ID, "text": item.Text}}}
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
	default:
		kind := "tool_started"
		if completed {
			kind = "tool_completed"
		}
		return []eventSpec{{sourceID: source + ":" + kind, eventType: kind, payload: map[string]any{"id": item.ID, "name": typ, "command": item.Command, "output": item.AggregatedOutput, "status": item.Status, "item": item}}}
	}
	return nil
}
