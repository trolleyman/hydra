package agenthost

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strconv"
	"time"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/gate"
)

// RunGate is the provider-hook entry point exposed by hydra-agent-host gate.
// It intentionally contains no Hydra head/status behavior: the parent host
// watches the shared approval directory and bridges asks to VS Code.
func RunGate(agentType string, input io.Reader, output, logs io.Writer) error {
	raw, err := io.ReadAll(input)
	if err != nil {
		return errtrace.Wrap(err)
	}
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return errtrace.Wrap(err)
	}
	toolName, _ := payload["tool_name"].(string)
	toolInput, _ := payload["tool_input"].(map[string]any)
	policy, err := gate.LoadPolicy(os.Getenv(gate.EnvPolicyPath))
	if err != nil {
		return errtrace.Wrap(err)
	}
	result := gate.Decide(policy, toolName, toolInput)
	if result.Decision == gate.Ask {
		result.Decision = waitForGateApproval(agentType, toolName, result, logs)
	}
	if result.Decision != gate.Deny {
		return nil
	}
	return errtrace.Wrap(json.NewEncoder(output).Encode(map[string]any{
		"hookSpecificOutput": map[string]any{
			"hookEventName": "PreToolUse", "permissionDecision": "deny",
			"permissionDecisionReason": result.Reason,
		},
	}))
}

func waitForGateApproval(agentType, toolName string, result gate.Result, logs io.Writer) gate.Decision {
	dir := os.Getenv(gate.EnvApprovalDir)
	if dir == "" {
		return gate.Deny
	}
	id := "tool-" + strconv.FormatInt(time.Now().UnixNano(), 10)
	request := gate.Request{
		ReqID: id, Tool: toolName, Kind: result.Kind, Target: result.Target,
		Reason: result.Reason, Summary: fmt.Sprintf("%s wants to use %s", agentType, result.Target),
		RW: result.RW, URL: result.URL, ArgsPreview: result.ArgsPreview,
		TS: time.Now().Format(time.RFC3339Nano),
	}
	if err := gate.WriteRequest(dir, request); err != nil {
		_, _ = fmt.Fprintf(logs, "agent-host gate: write approval: %v\n", err)
		return gate.Deny
	}
	defer gate.RemoveRequest(dir, id)
	deadline := time.NewTimer(approvalTimeout)
	defer deadline.Stop()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		if decision, ok, err := gate.ReadDecision(dir, id); err == nil && ok {
			return decision.Decision
		}
		select {
		case <-deadline.C:
			return gate.Deny
		case <-ticker.C:
		}
	}
}
