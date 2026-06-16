package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"braces.dev/errtrace"
	"github.com/spf13/cobra"
	"github.com/trolleyman/hydra/internal/api"
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

// userQuestionLeads are phrases that, appearing in the final sentence of a
// turn, mark it as a question addressed to the user — asking them to choose,
// confirm, or grant permission. They're what distinguishes "Should I proceed?"
// (waiting on input) from the many finished turns that merely happen to end on
// a '?' (rhetorical recaps, "Anything else?", "Could that be a caching bug?").
// Matched case-insensitively as substrings of the last sentence.
var userQuestionLeads = []string{
	"should i",
	"shall i",
	"do you want",
	"do you prefer",
	"would you like",
	"would you prefer",
	"which would you",
	"how would you like",
	"what would you like",
	"want me to",
	"let me know",
	"may i",
	"can i proceed",
}

// stopStatus decides whether a finished turn means the agent is waiting on the
// user or has genuinely finished. Agents don't expose an explicit "I need
// input" signal on turn end, so this is best-effort. A trailing '?' alone is
// NOT enough — plenty of finished agents end on a question — so we additionally
// require the final sentence to read as a question put to the user (see
// userQuestionLeads). Only then is it treated as waiting; otherwise finished.
func stopStatus(lastMessage string) api.AgentStatus {
	trimmed := strings.TrimRight(lastMessage, " \t\r\n")
	if !strings.HasSuffix(trimmed, "?") {
		return api.Finished
	}
	// Isolate the final sentence: the text after the last sentence terminator
	// (or newline) that precedes the closing '?'.
	body := strings.TrimSuffix(trimmed, "?")
	start := strings.LastIndexAny(body, ".!?\n")
	sentence := strings.ToLower(strings.TrimSpace(body[start+1:]))
	for _, lead := range userQuestionLeads {
		if strings.Contains(sentence, lead) {
			return api.Waiting
		}
	}
	return api.Finished
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
// The agentType argument (e.g. "claude", "gemini", "copilot") is accepted for future use.
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

		if err := runTriggerHook(args[0], eventOverride, logFile); err != nil {
			// Log to status_log.jsonl and stderr but don't propagate – hooks must not fail the agent.
			fmt.Fprintf(os.Stderr, "hydra trigger-hook error: %v\n", err)
			if logFile != nil {
				appendJSONLine(logFile, map[string]interface{}{"error": err.Error()})
			}
		}
		return nil
	},
}

func runTriggerHook(agentType string, eventOverride string, logFile *os.File) error {
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

	// lastMessage is the agent's most recent assistant message, when the hook
	// payload carries one (Claude/Gemini include it on turn-end events).
	lastMessage := stringField(input, "last_assistant_message")

	// Only update status.json for events that represent a meaningful status change.
	// All other events are logged above but do not alter the displayed status.
	var status api.AgentStatus
	switch event {
	case "SessionStart", "sessionStart":
		status = api.Running
	case "UserPromptSubmit", "userPromptSubmit", "BeforeAgent", "beforeAgent":
		// The user just submitted a prompt (Claude's UserPromptSubmit) or the
		// agent's turn is beginning (Gemini's BeforeAgent). Either way the agent
		// is now working, so flip to running immediately rather than waiting for
		// the first tool call (PreToolUse) to report it. These hooks were already
		// registered but unhandled, so a freshly-submitted message lingered as
		// waiting/finished until the agent happened to run a tool.
		status = api.Running
	case "Stop", "AfterAgent":
		// The turn finished. Distinguish "waiting on the user" (the agent ended
		// by asking a question) from "finished" (it completed its work).
		status = stopStatus(lastMessage)
	case "SessionEnd", "sessionEnd":
		status = api.Stopped
	case "PreToolUse", "preToolUse", "BeforeTool":
		// A tool is about to run. Most tools mean the agent is working, but a tool
		// that asks the user something (e.g. AskUserQuestion) blocks until the user
		// answers — that's waiting on input, not working.
		if isUserInputTool(stringField(input, "tool_name")) {
			status = api.Waiting
			if q := questionText(input); q != "" {
				lastMessage = q
			}
		} else {
			status = api.Running
		}
	case "PostToolUse", "PostToolUseFailure", "AfterTool", "postToolUse":
		// A tool finished (including the user answering a question) — the agent is
		// working again. Rewriting status.json also refreshes the timestamp, so the
		// frontend knows it may need to refresh (e.g. after a git commit).
		status = api.Running
	case "Notification", "notification":
		// A notification means the agent is blocking on the user — either a
		// permission prompt or the "waiting for your input" idle nudge. The idle
		// nudge, though, also fires ~60s after a turn ends, when the agent has
		// simply gone quiet. In that case the status is already terminal
		// (finished/stopped) and downgrading it back to waiting would spuriously
		// reset a finished agent to waiting with nothing having changed. A real
		// permission prompt only fires mid-turn, so the status would be running;
		// guard against clobbering a terminal status here.
		if cur := currentStatus(); cur == api.Finished || cur == api.Stopped {
			return nil
		}
		status = api.Waiting
		if lastMessage == "" {
			lastMessage = stringField(input, "message")
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

	data, err := json.Marshal(info)
	if err != nil {
		return errtrace.Wrap(fmt.Errorf("marshal status: %w", err))
	}

	if err := os.WriteFile(statusPath, data, 0644); err != nil {
		return errtrace.Wrap(fmt.Errorf("write status: %w", err))
	}

	return nil
}
