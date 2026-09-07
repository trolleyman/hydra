package agenthost

import (
	"bytes"
	"strings"
	"testing"
	"time"

	"github.com/trolleyman/hydra/internal/gate"
)

func TestRunGateDeniesDisabledCoreTool(t *testing.T) {
	dir := t.TempDir()
	policyPath := dir + "/policy.json"
	if err := (gate.Policy{GateEnabled: true, ToolDecisions: map[string]gate.Decision{"edit": gate.Deny}}).Save(policyPath); err != nil {
		t.Fatal(err)
	}
	t.Setenv(gate.EnvPolicyPath, policyPath)
	t.Setenv(gate.EnvApprovalDir, dir)
	var output bytes.Buffer
	if err := RunGate("codex", strings.NewReader(`{"tool_name":"apply_patch","tool_input":{"patch":"x"}}`), &output, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), `"permissionDecision":"deny"`) {
		t.Fatalf("gate output = %s", output.String())
	}
}

func TestRunGateParksAskUntilDecision(t *testing.T) {
	dir := t.TempDir()
	policyPath := dir + "/policy.json"
	if err := (gate.Policy{GateEnabled: true, ToolDecisions: map[string]gate.Decision{"bash": gate.Ask}}).Save(policyPath); err != nil {
		t.Fatal(err)
	}
	t.Setenv(gate.EnvPolicyPath, policyPath)
	t.Setenv(gate.EnvApprovalDir, dir)
	var output bytes.Buffer
	done := make(chan error, 1)
	go func() {
		done <- RunGate("claude", strings.NewReader(`{"tool_name":"Bash","tool_input":{"command":"pwd"}}`), &output, &bytes.Buffer{})
	}()
	deadline := time.Now().Add(time.Second)
	var request gate.Request
	for time.Now().Before(deadline) {
		requests, _ := gate.ListRequests(dir)
		if len(requests) > 0 {
			request = requests[0]
			break
		}
		time.Sleep(time.Millisecond)
	}
	if request.ReqID == "" {
		t.Fatal("gate did not create approval request")
	}
	if err := gate.WriteDecision(dir, request.ReqID, gate.DecisionFile{Decision: gate.Allow}); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("gate did not resume after approval")
	}
	if output.Len() != 0 {
		t.Fatalf("allowed gate emitted deny: %s", output.String())
	}
}
