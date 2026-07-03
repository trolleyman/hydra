package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"braces.dev/errtrace"
	"github.com/spf13/cobra"
	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/heads"
)

// stringField returns input[key] as a string, or "" if absent or not a string.
func stringField(input map[string]interface{}, key string) string {
	if v, ok := input[key].(string); ok {
		return v
	}
	return ""
}

// isUserInputTool reports whether a tool, when invoked, blocks waiting for the
// user to respond (answering a question, approving a plan) rather than doing
// work. Keep in sync with the equivalent list in internal/heads/activity.go.
func isUserInputTool(tool string) bool {
	switch tool {
	case "AskUserQuestion", "ExitPlanMode":
		return true
	default:
		return false
	}
}

// questionText best-effort extracts the prompt an input tool is presenting to
// the user (AskUserQuestion's first question, or ExitPlanMode's plan), for
// display as the agent's pending message.
func questionText(input map[string]interface{}) string {
	ti, ok := input["tool_input"].(map[string]interface{})
	if !ok {
		return ""
	}
	if qs, ok := ti["questions"].([]interface{}); ok {
		for _, q := range qs {
			if qm, ok := q.(map[string]interface{}); ok {
				if s, _ := qm["question"].(string); s != "" {
					return s
				}
			}
		}
	}
	if s, _ := ti["plan"].(string); s != "" {
		return s
	}
	return ""
}

func init() {
	rootCmd.AddCommand(triggerHookCmd)
}

// statusFilePath returns the per-head status.json path. Hydra sets
// HYDRA_STATUS_PATH inside the sandbox (the host's real per-head file, made
// writable); otherwise we fall back to $HOME/.hydra/status.json.
func statusFilePath() (string, error) {
	if p := os.Getenv("HYDRA_STATUS_PATH"); p != "" {
		return p, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", errtrace.Wrap(fmt.Errorf("get home dir: %w", err))
	}
	return filepath.Join(home, ".hydra", "status.json"), nil
}

// currentStatus reads the status currently persisted in status.json, returning
// "" if it can't be read or parsed. Used to avoid downgrading a terminal status
// (finished/stopped) when a late idle-nudge notification arrives.
func currentStatus() api.AgentStatus {
	path, err := statusFilePath()
	if err != nil {
		return ""
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	var info api.AgentStatusInfo
	if err := json.Unmarshal(data, &info); err != nil {
		return ""
	}
	return info.Status
}

// subagentStale is how long a sub-agent marker survives without a refresh before
// it's treated as gone. A live sub-agent refreshes its marker on every tool hook
// (far more often than this), so the TTL only reclaims a marker whose
// SubagentStop was never delivered - it must not fire while a real sub-agent is
// still working, hence a generous window.
const subagentStale = 5 * time.Minute

// subagentsDir returns the per-head directory of active sub-agent marker files,
// or "" when tracking isn't configured (then it's a no-op and Stop falls back to
// its old always-finished behavior). Set via HYDRA_SUBAGENTS_DIR by seedHead.
func subagentsDir() string {
	return os.Getenv("HYDRA_SUBAGENTS_DIR")
}

// sanitizeSubagentID keeps only filename-safe characters from an agent_id so it
// can be a marker filename. agent_ids are hex, so this is defensive.
func sanitizeSubagentID(id string) string {
	out := make([]rune, 0, len(id))
	for _, r := range id {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			out = append(out, r)
		}
	}
	if len(out) == 0 {
		return "unknown"
	}
	return string(out)
}

// markSubagentActive creates (or refreshes) the marker for a starting sub-agent.
func markSubagentActive(id string) {
	dir := subagentsDir()
	if dir == "" || id == "" {
		return
	}
	_ = os.MkdirAll(dir, 0755)
	_ = os.WriteFile(filepath.Join(dir, sanitizeSubagentID(id)), nil, 0644)
}

// refreshSubagentActive bumps an existing marker's mtime (keeping a long-running
// sub-agent from ageing out) but never resurrects one whose SubagentStop already
// removed it - so a late tool hook arriving after stop can't wedge the parent.
func refreshSubagentActive(id string) {
	dir := subagentsDir()
	if dir == "" || id == "" {
		return
	}
	now := time.Now()
	_ = os.Chtimes(filepath.Join(dir, sanitizeSubagentID(id)), now, now) // no-op if the marker is gone
}

// clearSubagentActive removes a sub-agent's marker (its SubagentStop fired).
func clearSubagentActive(id string) {
	dir := subagentsDir()
	if dir == "" || id == "" {
		return
	}
	_ = os.Remove(filepath.Join(dir, sanitizeSubagentID(id)))
}

// activeSubagentCount counts live sub-agent markers, pruning any that have gone
// stale (a missed SubagentStop). Zero when none are running or tracking is off.
func activeSubagentCount() int {
	dir := subagentsDir()
	if dir == "" {
		return 0
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	cutoff := time.Now().Add(-subagentStale)
	n := 0
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		if info.ModTime().Before(cutoff) {
			_ = os.Remove(filepath.Join(dir, e.Name()))
			continue
		}
		n++
	}
	return n
}

// statusLogFilePath returns the per-head status_log.jsonl path, honoring
// HYDRA_STATUS_LOG_PATH with the same fallback as statusFilePath.
func statusLogFilePath() (string, error) {
	if p := os.Getenv("HYDRA_STATUS_LOG_PATH"); p != "" {
		return p, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", errtrace.Wrap(fmt.Errorf("get home dir: %w", err))
	}
	return filepath.Join(home, ".hydra", "status_log.jsonl"), nil
}

func openStatusLog() (*os.File, error) {
	statusLogPath, err := statusLogFilePath()
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	if err := os.MkdirAll(filepath.Dir(statusLogPath), 0755); err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("create status dir: %w", err))
	}
	return errtrace.Wrap2(os.OpenFile(statusLogPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644))
}

// appendJSONLine encodes object as a single JSON line and writes it to w.
// Falls back to stderr if w is nil.
func appendJSONLine(w io.Writer, object any) {
	if w == nil {
		w = os.Stderr
	}
	encoder := json.NewEncoder(w)
	_ = encoder.Encode(object)
}

// triggerHookCmd is an internal command run inside agent containers via Claude Code / Gemini / Copilot hooks.
// It reads a JSON hook payload from stdin, appends {"hook": <payload>} to ~/.hydra/status_log.jsonl,
// and for status-changing events also writes ~/.hydra/status.json.
//
// Usage (internal only):
//
//	hydra trigger-hook <agentType> [eventName]
//
// The agentType argument (e.g. "claude", "gemini", "copilot", "codex") is accepted for future use.
// The optional eventName argument overrides reading the event from the JSON payload; this is
// required for Copilot CLI hooks which do not include the event name in the payload.
var triggerHookCmd = &cobra.Command{
	Use:    "trigger-hook <agentType> [eventName]",
	Short:  "Internal: process a hook event and write ~/.hydra/status.json and ~/.hydra/status_log.jsonl",
	Long:   `Internal command used by hook scripts inside agent containers to update the agent status file. Not intended for direct use.`,
	Hidden: true,
	Args:   cobra.RangeArgs(1, 2),
	// Always exit 0 so we never block the agent session.
	RunE: func(cmd *cobra.Command, args []string) error {
		logFile, logErr := openStatusLog()
		if logErr != nil {
			fmt.Fprintf(os.Stderr, "hydra trigger-hook: open log: %v\n", logErr)
		}
		if logFile != nil {
			defer logFile.Close()
		}

		eventOverride := ""
		if len(args) >= 2 {
			eventOverride = args[1]
		}

		if err := runTriggerHook(args[0], eventOverride, logFile, os.Stdout); err != nil {
			// Log to status_log.jsonl and stderr but don't propagate - hooks must not fail the agent.
			fmt.Fprintf(os.Stderr, "hydra trigger-hook error: %v\n", err)
			if logFile != nil {
				appendJSONLine(logFile, map[string]interface{}{"error": err.Error()})
			}
		}
		return nil
	},
}

// approvePermission writes the PermissionRequest hook's "allow" decision to w -
// the JSON Claude Code reads on stdout to auto-approve a permission prompt
// without ever showing it to the user. Schema: hooks docs, "PermissionRequest".
func approvePermission(w io.Writer) {
	if w == nil {
		w = os.Stdout
	}
	appendJSONLine(w, map[string]interface{}{
		"hookSpecificOutput": map[string]interface{}{
			"hookEventName": "PermissionRequest",
			"decision":      map[string]interface{}{"behavior": "allow"},
		},
	})
}

func runTriggerHook(agentType string, eventOverride string, logFile *os.File, stdout io.Writer) error {
	raw, err := io.ReadAll(os.Stdin)
	if err != nil {
		return errtrace.Wrap(fmt.Errorf("read stdin: %w", err))
	}

	var input map[string]interface{}
	_ = json.Unmarshal(raw, &input) // ignore parse errors; input stays empty map

	// Always append {"hook": <payload>} to the log for every hook invocation.
	appendJSONLine(logFile, map[string]interface{}{"hook": input})

	// Determine event name: use the override (for Copilot CLI which omits it
	// from the payload) or fall back to the JSON field used by Claude/Gemini.
	event := eventOverride
	if event == "" {
		if v, ok := input["hook_event_name"].(string); ok {
			event = v
		}
	}

	// Sub-agent (Claude Task tool) hooks share this head's status.json but must
	// NOT drive the main agent's status: a sub-agent's tool call would otherwise
	// overwrite the parent's real state (e.g. flip a needs_input/finished parent
	// back to running). Sub-agent hooks carry an agent_id the main agent's hooks
	// lack - use it to bracket sub-agent lifetime (so the main Stop can tell a
	// real finish from "still running sub-agents") and otherwise ignore them.
	agentID := stringField(input, "agent_id")
	switch event {
	case "SubagentStart", "subagentStart":
		markSubagentActive(agentID)
		return nil
	case "SubagentStop", "subagentStop":
		clearSubagentActive(agentID)
		return nil
	}
	if agentID != "" {
		// A sub-agent's own tool/notification hook: keep its liveness marker fresh
		// (so a long-running sub-agent doesn't age out) but leave the parent alone.
		refreshSubagentActive(agentID)
		return nil
	}

	// lastMessage is the agent's most recent assistant message, when the hook
	// payload carries one (Claude/Gemini include it on turn-end events).
	lastMessage := stringField(input, "last_assistant_message")
	// lastMessageIsQuestion marks lastMessage as a question/plan the agent is
	// presenting to the user via a user-input tool (set below). Such a message is
	// never a suggested next message, even when its shape looks terse.
	lastMessageIsQuestion := false
	// notificationType carries Claude's `notification_type` for Notification
	// events (idle_prompt, permission_prompt, elicitation_dialog, ...). It selects
	// between the explicit "the agent is asking you" prompt (status needs_input,
	// surfaced at once) and the idle "gone quiet" nudge (status waiting, deferred).
	notificationType := ""

	// Only update status.json for events that represent a meaningful status change.
	// All other events are logged above but do not alter the displayed status.
	var status api.AgentStatus
	switch event {
	case "SessionStart", "sessionStart":
		// A resume (claude --continue / --resume, source="resume") restores a
		// prior conversation and then sits idle waiting for the user - it is not
		// actively working - so report it as waiting. A fresh startup
		// (source="startup", "clear", "compact") proceeds to work on the submitted
		// prompt (a UserPromptSubmit follows), so it stays running. Without a
		// resume signal we can't tell a restored session from a working one apart,
		// which is why a resumed agent otherwise lingered as "running".
		//
		// But don't downgrade a terminal status: a head that had finished (or was
		// stopped) before the daemon restarted is restored, not freshly waiting on
		// the user - flipping it to "waiting" here would spuriously revert a finished
		// head on every restart. ResumeHead seeds the same terminal status into
		// status.json before launch, so currentStatus() sees it here.
		if stringField(input, "source") == "resume" {
			if cur := currentStatus(); cur == api.Finished || cur == api.Stopped {
				return nil
			}
			status = api.Waiting
		} else {
			status = api.Running
		}
	case "UserPromptSubmit", "userPromptSubmit", "BeforeAgent", "beforeAgent":
		// The user just submitted a prompt (Claude's UserPromptSubmit) or the
		// agent's turn is beginning (Gemini's BeforeAgent). Either way the agent
		// is now working, so flip to running immediately rather than waiting for
		// the first tool call (PreToolUse) to report it. These hooks were already
		// registered but unhandled, so a freshly-submitted message lingered as
		// waiting/finished until the agent happened to run a tool.
		status = api.Running
	case "Stop", "AfterAgent":
		// The turn ended, so the agent has finished its work. The "waiting on
		// the user" case isn't inferred here: agents don't expose an explicit
		// "I need input" signal on turn end, and guessing from the message text
		// (e.g. a trailing '?') misfires too often - plenty of finished turns
		// end on a question. Genuine waits surface through other hooks instead:
		// ExitPlanMode's PermissionRequest and the Notification event whose
		// notification_type marks an AskUserQuestion / permission prompt. (Claude
		// does NOT fire PreToolUse/PostToolUse for AskUserQuestion or
		// ExitPlanMode, so those tool calls can't be detected via PreToolUse.)
		//
		// But if sub-agents this head launched are still running, the turn ending
		// doesn't mean the head is done - its background sub-agents are, and it
		// will resume when they report back. Report running so the head isn't
		// treated (or auto-merged) as finished. finished thus means "main turn
		// ended AND no live sub-agents".
		if activeSubagentCount() > 0 {
			status = api.Running
		} else {
			status = api.Finished
		}
	case "SessionEnd", "sessionEnd":
		status = api.Stopped
	case "PreToolUse", "preToolUse", "BeforeTool":
		// A tool is about to run. Most tools mean the agent is working, but a tool
		// that asks the user something (e.g. AskUserQuestion) blocks until the user
		// answers - that's an explicit "needs you" wait, not working. (Defensive:
		// current Claude fires no PreToolUse for AskUserQuestion/ExitPlanMode.)
		if isUserInputTool(stringField(input, "tool_name")) {
			status = api.NeedsInput
			if q := questionText(input); q != "" {
				lastMessage = q
				lastMessageIsQuestion = true
			}
		} else {
			status = api.Running
		}
	case "PostToolUse", "PostToolUseFailure", "AfterTool", "postToolUse":
		// A tool finished (including the user answering a question) - the agent is
		// working again. Rewriting status.json also refreshes the timestamp, so the
		// frontend knows it may need to refresh (e.g. after a git commit).
		status = api.Running
	case "PermissionRequest", "permissionRequest":
		// A tool is asking the user to approve it - the agent is blocked on the
		// user. Under our bypass-permissions mode most tools never reach here, but
		// plan approval (ExitPlanMode) and any genuinely non-bypassable prompt do.
		// This is the reliable signal for ExitPlanMode, which fires no PreToolUse.
		tool := stringField(input, "tool_name")
		if tool == "ExitPlanMode" {
			// ExitPlanMode is the gate Claude shows when it finishes presenting a
			// plan and asks "can I proceed?". The user never opted into plan mode -
			// the agent entered it on its own - and a Hydra head already runs fully
			// autonomously (--dangerously-skip-permissions) in a throwaway sandbox +
			// worktree, so there's nothing for this gate to guard. Auto-approve it by
			// emitting the PermissionRequest "allow" decision on stdout, and report
			// the agent as running: it proceeds straight into the work rather than
			// waiting on the user. Only ExitPlanMode is auto-approved; any other
			// PermissionRequest is still surfaced as a wait below.
			approvePermission(stdout)
			status = api.Running
			break
		}
		// We only OBSERVE other prompts: trigger-hook writes nothing to stdout, so
		// the permission flow proceeds unchanged. This is an explicit "needs you"
		// wait, so it gets the needs_input status (flagged as unread at once).
		status = api.NeedsInput
		if isUserInputTool(tool) {
			if q := questionText(input); q != "" {
				lastMessage = q
				lastMessageIsQuestion = true
			}
		}
	case "Notification", "notification":
		// A notification means the agent is blocking on the user. The
		// notification_type tells the kinds apart:
		//   - elicitation_complete / elicitation_response: the user just answered
		//     an AskUserQuestion, so the agent is working again.
		//   - auth_success (and other informational types): no status change.
		//   - permission_prompt / elicitation_dialog: an explicit prompt - a tool
		//     needs approval, or AskUserQuestion is asking. This is how an
		//     AskUserQuestion surfaces (it fires no PreToolUse); it gets the
		//     needs_input status so the UI flags it for the user at once.
		//   - idle_prompt (and any unrecognised type): the agent has gone quiet.
		//     This gets the softer waiting status; the poller defers its unread
		//     flag (the idle nudge also fires ~60s after a turn ends and when a
		//     head awaits a subagent). Don't downgrade a terminal status here: the
		//     idle nudge fires after a finished/stopped turn too, and flipping that
		//     back to waiting would spuriously revive it.
		notificationType = stringField(input, "notification_type")
		switch notificationType {
		case "elicitation_complete", "elicitation_response":
			status = api.Running
		case "auth_success":
			return nil
		case "permission_prompt", "elicitation_dialog":
			status = api.NeedsInput
			if lastMessage == "" {
				lastMessage = stringField(input, "message")
			}
		default:
			if cur := currentStatus(); cur == api.Finished || cur == api.Stopped {
				return nil
			}
			status = api.Waiting
			if lastMessage == "" {
				lastMessage = stringField(input, "message")
			}
		}
	default:
		return nil
	}

	if status == "" {
		return nil
	}

	_ = agentType // available for future per-agent logic

	eventCopy := event
	info := api.AgentStatusInfo{
		Status:    status,
		Event:     &eventCopy,
		Timestamp: time.Now().Format(time.RFC3339Nano),
	}

	if lastMessage != "" {
		if len(lastMessage) > 300 {
			lastMessage = lastMessage[:300]
		}
		info.LastMessage = &lastMessage
		if suggested := !lastMessageIsQuestion && heads.IsSuggestedNextMessage(lastMessage); suggested {
			info.LastMessageIsSuggestedNextMessage = &suggested
		}
	}

	if event == "SessionEnd" || event == "sessionEnd" {
		if reason := stringField(input, "reason"); reason != "" {
			info.Reason = &reason
		}
	}

	statusPath, err := statusFilePath()
	if err != nil {
		return errtrace.Wrap(err)
	}
	if err := os.MkdirAll(filepath.Dir(statusPath), 0755); err != nil {
		return errtrace.Wrap(fmt.Errorf("create status dir: %w", err))
	}

	data, err := json.Marshal(heads.StatusFile{AgentStatusInfo: info})
	if err != nil {
		return errtrace.Wrap(fmt.Errorf("marshal status: %w", err))
	}

	if err := os.WriteFile(statusPath, data, 0644); err != nil {
		return errtrace.Wrap(fmt.Errorf("write status: %w", err))
	}

	return nil
}
