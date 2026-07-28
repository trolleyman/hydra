package cli

import (
	"strings"
	"testing"

	"github.com/trolleyman/hydra/internal/gate"
)

// hostRunMessage renders an outcome the way the MCP tool would, without going
// near the approval channel.
func hostRunMessage(t *testing.T, o hostRunOutcome) (string, bool) {
	t.Helper()
	res := renderHostRunOutcome(o)
	return res.Message, res.Failed
}

// A non-zero exit is a FAILED tool call, matching the Bash tool - and the
// message leads with the exit status rather than burying it under the output.
func TestHostRunResultReportsExitStatus(t *testing.T) {
	msg, failed := hostRunMessage(t, hostRunOutcome{Result: gate.HostRunResult{ExitCode: 2, Output: "boom\n"}})
	if !failed {
		t.Error("a non-zero exit should be reported as a failed tool call, like Bash")
	}
	if !strings.Contains(msg, "exit status 2") {
		t.Errorf("message should name the exit status, got %q", msg)
	}
	if !strings.HasPrefix(msg, "FAILED") {
		t.Errorf("message should lead with the failure, got %q", msg)
	}
	if !strings.Contains(msg, "boom") {
		t.Errorf("message should still carry the output, got %q", msg)
	}

	msg, failed = hostRunMessage(t, hostRunOutcome{Result: gate.HostRunResult{ExitCode: 0, Output: "fine\n"}})
	if failed {
		t.Error("exit 0 should not be a failure")
	}
	if !strings.Contains(msg, "exit status 0") || !strings.Contains(msg, "fine") {
		t.Errorf("message = %q, want the status and the output", msg)
	}

	msg, failed = hostRunMessage(t, hostRunOutcome{Result: gate.HostRunResult{TimedOut: true}})
	if !failed || !strings.Contains(msg, "timeout") {
		t.Errorf("a killed command should fail and say so, got failed=%v %q", failed, msg)
	}
}

// Each refusal is distinct and unmistakable - above all a denial, which must
// not read as something to retry.
func TestHostRunResultExplainsEachRefusal(t *testing.T) {
	for _, tc := range []struct {
		refusal hostRunRefusal
		wants   []string
	}{
		{hostRunDenied, []string{"DENIED", "did NOT run", "do not re-request"}},
		{hostRunNoDecision, []string{"TIMED OUT", "did NOT run"}},
		{hostRunNoChannel, []string{"UNAVAILABLE", "did NOT run"}},
		{hostRunNoResult, []string{"ALLOWED", "outcome is unknown"}},
		{hostRunSubmitFail, []string{"never saw it", "did NOT run"}},
	} {
		msg, failed := hostRunMessage(t, hostRunOutcome{Refusal: tc.refusal, Detail: "why"})
		if !failed {
			t.Errorf("%s should be a failed tool call", tc.refusal)
		}
		for _, want := range tc.wants {
			if !strings.Contains(msg, want) {
				t.Errorf("%s message %q should mention %q", tc.refusal, msg, want)
			}
		}
	}
}
