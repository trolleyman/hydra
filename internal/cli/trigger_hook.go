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

// stopStatus decides whether a finished turn means the agent is waiting on the
// user or has genuinely finished. Heuristic: a trailing '?' in the agent's last
// message signals it ended by asking a question, so it's waiting for an answer;
// otherwise it completed its work. (Best-effort — agents don't expose an
// explicit "I need input" signal on turn end.)
func stopStatus(lastMessage string) api.AgentStatus {
	if strings.HasSuffix(strings.TrimRight(lastMessage, " \t\r\n"), "?") {
		return api.Waiting
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
	case "Stop", "AfterAgent":
		// The turn finished. Distinguish "waiting on the user" (the agent ended
		// by asking a question) from "finished" (it completed its work).
		status = stopStatus(lastMessage)
	case "SessionEnd", "sessionEnd":
		status = api.Stopped
	case "PreToolUse", "PostToolUse", "PostToolUseFailure", "BeforeTool", "AfterTool", "preToolUse", "postToolUse":
		// A tool event means the agent is actively working. We rewrite status.json
		// (keeping it Running) so the timestamp changes, signaling the frontend it
		// may need to refresh (e.g. after a git commit) and refreshing live activity.
		status = api.Running
	case "Notification", "notification":
		// Any notification means the agent is blocking on the user — either a
		// permission prompt or the "waiting for your input" idle nudge.
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
