package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
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

	// PostToolUse is advice-only: the call already ran, so there is nothing to
	// decide. It exists so the readonly git redirect can stop being a deny (see
	// gate.GitReadonlyAdvice) - the command runs, the OS refuses the .git write,
	// and we explain that afterwards instead of pre-emptively killing the whole
	// Bash call over one git clause.
	if event := stringField(input, "hook_event_name"); event == "PostToolUse" || event == "PostToolUseFailure" {
		emitPostAdvice(stdout, toolName, toolInput, input["tool_response"], stringField(input, "cwd"))
		return nil
	}

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

	// A hook emits at most ONE decision object, so the advice below is confined to
	// the paths where nothing else is being said: a deny already carries its own
	// reason, and stacking a second object on it would be a malformed response.
	result := gate.Decide(policy, toolName, toolInput)
	switch result.Decision {
	case gate.Allow:
		emitPreAdvice(stdout, toolName, stringField(input, "cwd"))
		return nil
	case gate.Deny:
		emitDeny(stdout, result.Reason)
		return nil
	case gate.Ask:
		decision := resolveAsk(toolName, result)
		if decision == gate.Deny {
			emitDeny(stdout, result.Reason+" (denied)")
			return nil
		}
		emitPreAdvice(stdout, toolName, stringField(input, "cwd"))
		return nil
	}
	return nil
}

// emitPreAdvice states where the persistent Bash shell already is, before the
// command runs. This is the half that survives a FAILING call: Claude drops
// additionalContext from PostToolUseFailure (measured), so without it the shell's
// position goes unmentioned for every command that exits non-zero - and a run of
// failures is exactly when the agent is most likely to be lost. Silent at the
// worktree root, and silent for every tool but Bash.
func emitPreAdvice(w io.Writer, toolName, cwd string) {
	if toolName != "Bash" {
		return
	}
	advice := gate.ShellCwdAdviceBefore(cwd, os.Getenv(gate.EnvWorktree))
	if advice == "" {
		return
	}
	appendJSONLine(w, map[string]any{
		"hookSpecificOutput": map[string]any{
			"hookEventName":     "PreToolUse",
			"additionalContext": advice,
		},
	})
}

// emitPostAdvice attaches after-the-fact guidance to a tool call that already
// ran. Both pieces of advice are about the shell, so this applies to Bash alone:
// the read-only .git explanation (which needs the command and its output) and the
// shell's resulting cwd (which the Bash result itself never reports). Silence is
// the normal case - a hook that printed on every tool call would be noise.
//
// KNOWN GAP (measured on CLI 2.1.220): Claude delivers additionalContext from
// PostToolUse but silently DROPS it from PostToolUseFailure - the hook runs and
// emits, and the model never sees it. So everything here reaches the agent only
// when the Bash call exited 0. The cwd note covers itself (emitPreAdvice restates
// it before the next call), but GitReadonlyAdvice cannot: it needs the output, and
// a git write that hit the read-only .git exits non-zero by definition. It
// therefore lands only when the git command is not what set the script's exit
// status (e.g. it is piped into something that succeeds). The subcommands with a
// mcp__hydra__git_* equivalent are unaffected - they are redirected at PreToolUse,
// before running - so what is lost is the explanation for the uncovered writes
// (`git tag`, `git worktree add`, ...).
func emitPostAdvice(w io.Writer, toolName string, toolInput map[string]any, response any, cwd string) {
	if toolName != "Bash" {
		return
	}
	var parts []string
	if a := gate.GitReadonlyAdvice(stringField(toolInput, "command"), toolResponseText(response)); a != "" {
		parts = append(parts, a)
	}
	if a := gate.ShellCwdAdviceAfter(cwd, os.Getenv(gate.EnvWorktree)); a != "" {
		parts = append(parts, a)
	}
	if len(parts) == 0 {
		return
	}
	advice := strings.Join(parts, " ")
	appendJSONLine(w, map[string]any{
		"hookSpecificOutput": map[string]any{
			"hookEventName":     "PostToolUse",
			"additionalContext": advice,
		},
	})
}

// toolResponseText flattens a hook payload's tool_response into searchable text.
// Claude sends a Bash result either as a bare string or as an object carrying
// stdout/stderr, and the read-only error arrives on stderr, so both shapes have
// to be covered or the advice never fires.
func toolResponseText(response any) string {
	switch v := response.(type) {
	case string:
		return v
	case map[string]any:
		var b strings.Builder
		for _, key := range []string{"stdout", "stderr", "output", "error", "content"} {
			if s := stringField(v, key); s != "" {
				b.WriteString(s)
				b.WriteString("\n")
			}
		}
		return b.String()
	default:
		return ""
	}
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
func resolveAsk(toolName string, result gate.Result) gate.Decision {
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
	// However this resolves - allowed, denied, or timed out - the head has stopped
	// waiting on the user, so clear the policy-approval status on the way out
	// instead of leaving it for the agent's next hook to overwrite. That hook is
	// not guaranteed to come: when the gated call belongs to a sub-agent (Claude's
	// Task tool) its PostToolUse carries an agent_id, and trigger-hook drops those
	// so a sub-agent can't drive the parent's status. Nothing then re-stamps
	// status.json until the MAIN agent next runs a tool or ends its turn, so the
	// head sat at needs_input long after the user had answered - with no card left
	// to answer. The gate writes the parent's wait, so the gate must clear it.
	defer writeRunningStatus("")

	deadline := time.Now().Add(askTimeout)
	for {
		// Re-assert the policy-approval wait each iteration: the status hook also
		// fires on this PreToolUse and may have written a plain "running" status, so
		// re-stamping keeps the approval card reliably visible until a decision lands.
		writeApprovalStatus(summary)
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
	case "tool":
		return "wants to use unrecognized tool " + strconv.Quote(r.Target)
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
func writeApprovalStatus(summary string) {
	writeStatus(string(api.NeedsInput), "PreToolUse", summary, gate.NotificationPolicyApproval)
}

// writeRunningStatus flips the head's status.json back to plain running. Used
// wherever an approval wait resolves and no Claude hook is guaranteed to
// re-stamp the status afterwards: inside a long-blocking CLI (hydra host-run),
// and on every exit from the gate's own ask loop (see resolveAsk). An empty
// message leaves last_message unset, so gate bookkeeping never overwrites the
// agent's real last message.
func writeRunningStatus(message string) {
	writeStatus(string(api.Running), "", message, "")
}

func writeStatus(status, event, message, notificationType string) {
	path, err := statusFilePath()
	if err != nil {
		return
	}
	data, err := json.Marshal(statusWrite{
		Status:           status,
		Event:            event,
		Timestamp:        time.Now().Format(time.RFC3339Nano),
		LastMessage:      message,
		NotificationType: notificationType,
	})
	if err != nil {
		return
	}
	_ = os.WriteFile(path, data, 0644)
}
