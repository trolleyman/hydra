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
)

func init() {
	rootCmd.AddCommand(triggerHookCmd)
}

func openStatusLog() (*os.File, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("get home dir: %w", err))
	}
	statusLogPath := filepath.Join(home, ".hydra", "status_log.jsonl")
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
			appendJSONLine(logFile, map[string]interface{}{"error": err.Error()})
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

	// Only update status.json for events that represent a meaningful status change.
	// All other events are logged above but do not alter the displayed status.
	var status api.AgentStatus
	switch event {
	case "SessionStart", "sessionStart":
		status = api.Running
	case "Stop", "AfterAgent":
		status = api.Waiting
	case "SessionEnd", "sessionEnd":
		status = api.Stopped
	case "AfterTool", "postToolUse":
		// AfterTool/postToolUse doesn't change the status (it remains Running), but we
		// want to update status.json so the timestamp changes, signaling to the frontend
		// that it might need to refresh (e.g. after a git commit).
		status = api.Running
	default:
		return nil
	}

	_ = agentType // available for future per-agent logic

	eventCopy := event
	info := api.AgentStatusInfo{
		Status:    status,
		Event:     &eventCopy,
		Timestamp: time.Now().Format(time.RFC3339),
	}

	if event == "Stop" || event == "AfterAgent" {
		if msg, ok := input["last_assistant_message"].(string); ok && msg != "" {
			if len(msg) > 300 {
				msg = msg[:300]
			}
			info.LastMessage = &msg
		}
	}

	if event == "SessionEnd" {
		if reason, ok := input["reason"].(string); ok && reason != "" {
			info.Reason = &reason
		}
	}

	home, err := os.UserHomeDir()
	if err != nil {
		return errtrace.Wrap(fmt.Errorf("get home dir: %w", err))
	}

	statusPath := filepath.Join(home, ".hydra", "status.json")
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
