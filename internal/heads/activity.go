package heads

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/paths"
)

// maxStatusLogTail caps how many trailing bytes of status_log.jsonl we parse to
// derive live activity. The log is append-only and can grow large, but the most
// recent activity is always at the end.
const maxStatusLogTail = 64 * 1024

// enrichAgentStatus augments a computed status with richer progress detail read
// from the per-head status_log.jsonl (issue #10): a short description of the
// agent's current action while it's running, and its most recent message. It is
// best-effort — any read/parse failure simply leaves the status unchanged.
func enrichAgentStatus(projectRoot, id string, info *api.AgentStatusInfo) {
	if info == nil {
		return
	}
	switch info.Status {
	case api.Running, api.Waiting, api.Finished:
		// Worth enriching — the agent is live and may have recent activity.
	default:
		return
	}

	activity, lastMessage := readStatusLogTail(projectRoot, id)
	if info.Status == api.Running && activity != "" {
		info.Activity = &activity
	}
	if info.LastMessage == nil && lastMessage != "" {
		info.LastMessage = &lastMessage
	}
}

// readStatusLogTail parses the tail of the head's status_log.jsonl and returns
// (activity, lastMessage): activity describes the most recent tool action when
// the agent is mid-tool (empty once the turn ends), and lastMessage is the most
// recent assistant message. Either may be "".
func readStatusLogTail(projectRoot, id string) (activity, lastMessage string) {
	path := paths.GetStatusLogFromProjectRoot(projectRoot, id)
	data, err := tailFile(path, maxStatusLogTail)
	if err != nil {
		return "", ""
	}

	lines := bytes.Split(data, []byte("\n"))
	activityDone := false
	// Walk newest → oldest.
	for i := len(lines) - 1; i >= 0; i-- {
		line := bytes.TrimSpace(lines[i])
		if len(line) == 0 {
			continue
		}
		var entry struct {
			Hook map[string]interface{} `json:"hook"`
		}
		if err := json.Unmarshal(line, &entry); err != nil || entry.Hook == nil {
			continue
		}
		payload := entry.Hook
		event, _ := payload["hook_event_name"].(string)

		if !activityDone && activity == "" {
			if tool, _ := payload["tool_name"].(string); tool != "" && isToolEvent(event) {
				toolInput, _ := payload["tool_input"].(map[string]interface{})
				activity = describeActivity(tool, toolInput)
				activityDone = true
			} else if isTurnBoundary(event) {
				// A turn started/ended after the last tool ran, so no tool is
				// currently active — stop looking for activity.
				activityDone = true
			}
		}

		if lastMessage == "" {
			if msg := messageFromPayload(payload); msg != "" {
				lastMessage = truncate(strings.TrimSpace(msg), 300)
			}
		}

		if activityDone && lastMessage != "" {
			break
		}
	}
	return activity, lastMessage
}

// messageFromPayload extracts the agent's most recent user-facing message from a
// hook payload: its last assistant message, or — for a tool that asks the user
// something (e.g. AskUserQuestion) — the question/plan text it's waiting on.
func messageFromPayload(p map[string]interface{}) string {
	if msg, _ := p["last_assistant_message"].(string); msg != "" {
		return msg
	}
	tool, _ := p["tool_name"].(string)
	if !isUserInputTool(tool) {
		return ""
	}
	ti, _ := p["tool_input"].(map[string]interface{})
	if ti == nil {
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

// isUserInputTool reports whether a tool blocks waiting for the user. Keep in
// sync with the equivalent list in internal/cli/trigger_hook.go.
func isUserInputTool(tool string) bool {
	switch tool {
	case "AskUserQuestion", "ExitPlanMode":
		return true
	default:
		return false
	}
}

// isToolEvent reports whether a hook event name denotes a tool invocation across
// the Claude/Gemini/Copilot naming variants. An empty event (Copilot omits it
// from the payload) is treated as a possible tool event so tool_name still wins.
func isToolEvent(event string) bool {
	switch event {
	case "", "PreToolUse", "PostToolUse", "PostToolUseFailure", "BeforeTool", "AfterTool", "preToolUse", "postToolUse":
		return true
	default:
		return false
	}
}

// isTurnBoundary reports whether an event marks a turn start/end, meaning no
// tool is currently running.
func isTurnBoundary(event string) bool {
	switch event {
	case "SessionStart", "sessionStart", "Stop", "AfterAgent", "BeforeAgent",
		"SessionEnd", "sessionEnd", "UserPromptSubmit", "userPromptSubmitted":
		return true
	default:
		return false
	}
}

// describeActivity renders a short, human-readable description of a tool call,
// handling the common Claude and Gemini tool names.
func describeActivity(tool string, input map[string]interface{}) string {
	get := func(keys ...string) string {
		for _, k := range keys {
			if v, ok := input[k].(string); ok && v != "" {
				return v
			}
		}
		return ""
	}

	switch tool {
	case "Bash", "run_shell_command", "shell":
		if cmd := firstLine(get("command", "cmd")); cmd != "" {
			return "$ " + truncate(cmd, 80)
		}
		return "Running a command"
	case "Edit", "MultiEdit", "Write", "Update", "NotebookEdit", "replace", "write_file":
		if p := get("file_path", "path", "absolute_path"); p != "" {
			return "Editing " + filepath.Base(p)
		}
		return "Editing files"
	case "Read", "read_file", "read_many_files":
		if p := get("file_path", "path", "absolute_path"); p != "" {
			return "Reading " + filepath.Base(p)
		}
		return "Reading files"
	case "Grep", "search_file_content":
		if pat := get("pattern"); pat != "" {
			return "Searching: " + truncate(pat, 40)
		}
		return "Searching"
	case "Glob", "glob", "list_directory", "LS":
		return "Exploring files"
	case "Task":
		if d := get("description"); d != "" {
			return "Subagent: " + truncate(d, 40)
		}
		return "Running a subagent"
	case "WebFetch", "web_fetch":
		return "Fetching the web"
	case "WebSearch", "google_web_search":
		return "Searching the web"
	case "TodoWrite":
		return "Updating its plan"
	default:
		if tool == "" {
			return ""
		}
		return "Using " + tool
	}
}

// tailFile reads up to the last n bytes of the file at path, dropping a leading
// partial line when the file was truncated.
func tailFile(path string, n int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	fi, err := f.Stat()
	if err != nil {
		return nil, err
	}
	size := fi.Size()
	start := int64(0)
	if size > n {
		start = size - n
	}
	buf := make([]byte, size-start)
	if _, err := f.ReadAt(buf, start); err != nil {
		return nil, err
	}
	if start > 0 {
		if i := bytes.IndexByte(buf, '\n'); i >= 0 {
			buf = buf[i+1:]
		}
	}
	return buf, nil
}

// firstLine returns the first non-empty line of s, trimmed.
func firstLine(s string) string {
	for _, line := range strings.Split(s, "\n") {
		if line = strings.TrimSpace(line); line != "" {
			return line
		}
	}
	return ""
}

// truncate shortens s to at most max runes, appending an ellipsis if cut.
func truncate(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max]) + "…"
}
