package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strconv"
	"time"

	"braces.dev/errtrace"
	"github.com/spf13/cobra"
	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/gate"
)

func init() {
	rootCmd.AddCommand(gateCmd)
}

// askTimeout bounds how long the gate blocks waiting for a UI decision on an
// "ask" before it defaults to deny. Claude's per-hook command timeout is 10 min;
// staying comfortably under it leaves room to emit the deny cleanly.
const askTimeout = 5 * time.Minute

// askPollInterval is how often the blocked gate re-checks for a decision file.
const askPollInterval = 500 * time.Millisecond

// gateCmd is an internal command wired as a second PreToolUse hook (alongside
// trigger-hook, which keeps reporting status). It reads the hook payload from
// stdin, consults the seeded trusted policy, and can DENY a tool call - even
// under --dangerously-skip-permissions - by emitting a permissionDecision on
// stdout. An "ask" verdict parks the head until the user decides in the UI.
//
// Like trigger-hook it always exits 0: a gate that errored should fail open
// (the OS sandbox is still the boundary), never wedge the agent.
var gateCmd = &cobra.Command{
	Use:    "gate <agentType>",
	Short:  "Internal: PreToolUse policy gate (deny/ask) for an agent session",
	Long:   `Internal command used as a PreToolUse hook to enforce Hydra's security-gate policy. Not intended for direct use.`,
	Hidden: true,
	Args:   cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := runGate(args[0], os.Stdin, os.Stdout); err != nil {
			fmt.Fprintf(os.Stderr, "hydra gate error: %v\n", err)
		}
		return nil
	},
}

func runGate(agentType string, stdin io.Reader, stdout io.Writer) error {
	raw, err := io.ReadAll(stdin)
	if err != nil {
		return errtrace.Wrap(fmt.Errorf("read stdin: %w", err))
	}
	var input map[string]any
	_ = json.Unmarshal(raw, &input)

	toolName := stringField(input, "tool_name")
	toolInput, _ := input["tool_input"].(map[string]any)

	policyPath := os.Getenv(gate.EnvPolicyPath)
	if policyPath == "" {
		return nil // no policy seeded → fail open
	}
	policy, err := gate.LoadPolicy(policyPath)
	if err != nil {
		return errtrace.Wrap(err)
	}
	// Merge in hosts "always allow"ed earlier this session. The seeded policy.json is
	// read-only, so a mid-session grant reaches the gate through this writable file
	// in the approval dir rather than a relaunch. (Persisted grants land in the
	// project config and are seeded on the next launch.)
	if policy.WebFetchFilter {
		if dir := os.Getenv(gate.EnvApprovalDir); dir != "" {
			policy.WebFetchAllowHosts = append(policy.WebFetchAllowHosts, gate.LoadGrantedHosts(dir)...)
		}
	}

	result := gate.Decide(policy, toolName, toolInput)
	switch result.Decision {
	case gate.Allow:
		return nil // silence = proceed
	case gate.Deny:
		emitDeny(stdout, result.Reason)
		return nil
	case gate.Ask:
		decision := resolveAsk(agentType, toolName, result)
		if decision == gate.Deny {
			emitDeny(stdout, result.Reason+" (denied)")
		}
		return nil
	}
	return nil
}

// emitDeny writes the PreToolUse "deny" decision Claude Code reads on stdout. It
// blocks the tool and feeds the reason back to the model so it can adapt.
func emitDeny(w io.Writer, reason string) {
	appendJSONLine(w, map[string]any{
		"hookSpecificOutput": map[string]any{
			"hookEventName":            "PreToolUse",
			"permissionDecision":       "deny",
			"permissionDecisionReason": reason,
		},
	})
}

// resolveAsk parks the head for user approval: it records a request, flips the
// status to a policy-approval wait, and blocks until the UI writes a decision or
// the timeout elapses (defaulting to deny). It returns the final verdict.
func resolveAsk(agentType, toolName string, result gate.Result) gate.Decision {
	dir := os.Getenv(gate.EnvApprovalDir)
	if dir == "" {
		// No channel to ask over → fail closed for the cases we chose to gate
		// (an unattended head can't surface the question), but say why on stderr.
		fmt.Fprintln(os.Stderr, "hydra gate: no approval dir; denying parked tool call")
		return gate.Deny
	}

	reqid := strconv.FormatInt(time.Now().UnixNano(), 10)
	summary := approvalSummary(result)
	req := gate.Request{
		ReqID:       reqid,
		Tool:        toolName,
		Kind:        result.Kind,
		Target:      result.Target,
		Reason:      result.Reason,
		Summary:     summary,
		RW:          result.RW,
		URL:         result.URL,
		ArgsPreview: result.ArgsPreview,
		TS:          time.Now().Format(time.RFC3339Nano),
	}
	if err := gate.WriteRequest(dir, req); err != nil {
		fmt.Fprintf(os.Stderr, "hydra gate: write request: %v\n", err)
		return gate.Deny
	}
	deadline := time.Now().Add(askTimeout)
	for {
		// Re-assert the policy-approval wait each iteration: the status hook also
		// fires on this PreToolUse and may have written a plain "running" status, so
		// re-stamping keeps the approval card reliably visible until a decision lands.
		writeApprovalStatus(agentType, summary)
		if d, ok, err := gate.ReadDecision(dir, reqid); err == nil && ok {
			if d.Decision == gate.Allow {
				return gate.Allow
			}
			return gate.Deny
		}
		if time.Now().After(deadline) {
			fmt.Fprintln(os.Stderr, "hydra gate: approval timed out; denying")
			return gate.Deny
		}
		time.Sleep(askPollInterval)
	}
}

// approvalSummary is the one-line "Head wants to ..." shown in the UI card.
func approvalSummary(r gate.Result) string {
	switch r.Kind {
	case "mcp":
		return "wants to use MCP server " + strconv.Quote(r.Target)
	case "mcp_tool":
		verb := ""
		if r.RW != "" {
			verb = " (" + r.RW + ")"
		}
		return "wants to use MCP tool " + strconv.Quote(r.Target) + verb
	case "webfetch":
		return "wants to fetch from " + strconv.Quote(r.Target)
	case "bash":
		return "wants to run " + r.Target
	default:
		return r.Reason
	}
}

// statusWrite mirrors the JSON shape of api.AgentStatusInfo (plus the
// notification_type the gate adds) so the gate can flip a head into a
// policy-approval wait without depending on the heads package. The poller reads
// the same file; unknown fields it can't yet model are ignored.
type statusWrite struct {
	Status           string `json:"status"`
	Event            string `json:"event,omitempty"`
	Timestamp        string `json:"timestamp"`
	LastMessage      string `json:"last_message,omitempty"`
	NotificationType string `json:"notification_type,omitempty"`
}

// writeApprovalStatus flips the head's status.json to a needs-input wait flagged
// as a policy approval, so the UI surfaces the approval card immediately.
func writeApprovalStatus(agentType, summary string) {
	path, err := statusFilePath()
	if err != nil {
		return
	}
	data, err := json.Marshal(statusWrite{
		Status:           string(api.NeedsInput),
		Event:            "PreToolUse",
		Timestamp:        time.Now().Format(time.RFC3339Nano),
		LastMessage:      summary,
		NotificationType: gate.NotificationPolicyApproval,
	})
	if err != nil {
		return
	}
	_ = os.WriteFile(path, data, 0644)
	_ = agentType
}
