package cli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/gate"
)

// answerFirstRequest waits for resolveAsk to park a request in dir, then writes
// the given verdict for it, mimicking the UI's approval card.
func answerFirstRequest(t *testing.T, dir string, d gate.Decision) {
	t.Helper()
	go func() {
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			reqs, err := gate.ListRequests(dir)
			if err == nil && len(reqs) > 0 {
				_ = gate.WriteDecision(dir, reqs[0].ReqID, gate.DecisionFile{Decision: d})
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
	}()
}

func readStatusWrite(t *testing.T, path string) statusWrite {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read status.json: %v", err)
	}
	var s statusWrite
	if err := json.Unmarshal(data, &s); err != nil {
		t.Fatalf("unmarshal status.json: %v", err)
	}
	return s
}

// A resolved approval must leave the head running. The gate writes the parent's
// needs_input wait, so it owns clearing it: when the gated call belongs to a
// sub-agent, trigger-hook drops that sub-agent's PostToolUse and no other hook
// re-stamps status.json until the main agent moves - so a head that relied on
// the hook sat at needs_input long after the user had answered.
func TestResolveAskClearsApprovalWait(t *testing.T) {
	for _, tc := range []struct {
		name    string
		verdict gate.Decision
	}{
		{"allow", gate.Allow},
		{"deny", gate.Deny},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			statusPath := filepath.Join(t.TempDir(), "status.json")
			t.Setenv(gate.EnvApprovalDir, dir)
			t.Setenv("HYDRA_STATUS_PATH", statusPath)

			answerFirstRequest(t, dir, tc.verdict)

			got := resolveAsk("WebFetch", gate.Result{
				Kind:   "webfetch",
				Target: "unpkg.com",
				Reason: "not on the network allow-list",
				URL:    "https://unpkg.com/thing",
			})
			if got != tc.verdict {
				t.Errorf("resolveAsk = %q, want %q", got, tc.verdict)
			}

			s := readStatusWrite(t, statusPath)
			if s.Status != string(api.Running) {
				t.Errorf("status after decision = %q, want %q", s.Status, api.Running)
			}
			if s.NotificationType != "" {
				t.Errorf("notification_type after decision = %q, want it cleared", s.NotificationType)
			}
			if s.LastMessage != "" {
				t.Errorf("last_message = %q, want empty so gate bookkeeping doesn't overwrite the agent's message", s.LastMessage)
			}
		})
	}
}

// While the request is unanswered the head must show the policy-approval wait,
// so the UI raises the card.
func TestResolveAskWritesApprovalWaitWhilePending(t *testing.T) {
	dir := t.TempDir()
	statusPath := filepath.Join(t.TempDir(), "status.json")
	t.Setenv(gate.EnvApprovalDir, dir)
	t.Setenv("HYDRA_STATUS_PATH", statusPath)

	done := make(chan gate.Decision, 1)
	go func() {
		done <- resolveAsk("WebFetch", gate.Result{Kind: "webfetch", Target: "unpkg.com"})
	}()

	deadline := time.Now().Add(5 * time.Second)
	var s statusWrite
	for time.Now().Before(deadline) {
		if _, err := os.Stat(statusPath); err == nil {
			s = readStatusWrite(t, statusPath)
			if s.Status == string(api.NeedsInput) {
				break
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	if s.Status != string(api.NeedsInput) {
		t.Fatalf("status while pending = %q, want %q", s.Status, api.NeedsInput)
	}
	if s.NotificationType != gate.NotificationPolicyApproval {
		t.Errorf("notification_type = %q, want %q", s.NotificationType, gate.NotificationPolicyApproval)
	}
	if s.LastMessage != `wants to fetch from "unpkg.com"` {
		t.Errorf("last_message = %q, want the approval summary", s.LastMessage)
	}

	answerFirstRequest(t, dir, gate.Allow)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("resolveAsk did not return after the decision landed")
	}
}
