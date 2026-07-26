package heads

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/db"
	"github.com/trolleyman/hydra/internal/paths"
)

// maxStatusLogTail caps how many trailing bytes of status_log.jsonl we parse to
// derive live activity. The log is append-only and can grow large, but the most
// recent activity is always at the end.
const maxStatusLogTail = 64 * 1024

// enrichAgentStatus augments a computed status with richer progress detail read
// from the per-head status_log.jsonl (issue #10): a short description of the
// agent's current action while it's running, and its most recent message. It is
// best-effort - any read/parse failure simply leaves the status unchanged.
func enrichAgentStatus(projectRoot, id string, info *api.AgentStatusInfo) {
	if info == nil {
		return
	}
	switch info.Status {
	case api.Running, api.NeedsInput, api.Waiting, api.Finished:
		// Worth enriching - the agent is live and may have recent activity.
	default:
		return
	}

	// The security gate writes notification_type=policy_approval into status.json
	// when it parks a tool call (so the UI shows the approval card). The JSON
	// status poller persists only the status string, not this side channel, so
	// computeAgentStatus loses it - recover it straight from status.json here.
	if info.NotificationType == nil {
		if s := ReadAgentStatus(projectRoot, id); s != nil && s.NotificationType != nil {
			info.NotificationType = s.NotificationType
		}
	}

	// Activity + last_message are no longer parsed from the log here: the JSON
	// status poller derives them (via readStatusLogTail) and persists them to the
	// agent row, and ListHeads copies them onto the status from those columns
	// (applyPersistedActivity). This keeps GET /agents off the per-request log tail
	// and lets the live line survive a daemon restart.
}

// applyPersistedActivity copies a head's persisted live-activity columns onto its
// computed status. Activity is surfaced only while running (it's stale the moment a
// tool ends and the UI hides it at rest anyway); last_message is shown in every
// state. The poller keeps these columns fresh; see UpdateAgentActivity / poller.go.
func applyPersistedActivity(info *api.AgentStatusInfo, a *db.Agent) {
	if info == nil || a == nil {
		return
	}
	if info.Status == api.Running && a.Activity != "" {
		activity := a.Activity
		info.Activity = &activity
	}
	if a.LastMessage != "" {
		msg := a.LastMessage
		info.LastMessage = &msg
		if a.LastMessageIsSuggested {
			suggested := true
			info.LastMessageIsSuggestedNextMessage = &suggested
		}
	}
}

// IsSuggestedNextMessage decides whether an agent's last message reads as a
// suggested next message - a single terse instruction you could send straight
// back ("run it", "verify it works by running the app") - rather than a closing
// summary/report. There's no explicit signal from the agent for this, so it's a
// heuristic on the message shape: a single short line with no mid-message
// sentence break. A multi-sentence or long message (e.g. "The spike is built,
// tested, and committed. Here's what landed...") is treated as a report, not a
// suggestion. Callers separately exclude questions the agent is asking the user
// (from a user-input tool), which aren't suggestions even when terse.
func IsSuggestedNextMessage(msg string) bool {
	t := strings.TrimSpace(msg)
	if t == "" || utf8.RuneCountInString(t) > 80 {
		return false
	}
	if strings.Contains(t, "\n") {
		return false
	}
	// A sentence break mid-message (". ", "! ", "? ") marks prose/a report rather
	// than one terse instruction.
	return !sentenceBreakRe.MatchString(t)
}

// sentenceBreakRe matches a sentence-ending punctuation followed by whitespace,
// signalling prose rather than a single terse instruction.
var sentenceBreakRe = regexp.MustCompile(`[.!?]\s`)

// readStatusLogTail parses the tail of the head's status_log.jsonl and returns
// (activity, lastMessage, lastMessageIsQuestion): activity describes the most
// recent tool action when the agent is mid-tool (empty once the turn ends),
// lastMessage is the most recent assistant message (or the question/plan a
// user-input tool is waiting on), and lastMessageIsQuestion is true when
// lastMessage is such a question/plan. Either string may be "".
func readStatusLogTail(projectRoot, id string) (activity, lastMessage string, lastMessageIsQuestion bool) {
	path := paths.GetStatusLogFromProjectRoot(projectRoot, id)
	data, err := tailFile(path, maxStatusLogTail)
	if err != nil {
		return "", "", false
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
				// currently active - stop looking for activity.
				activityDone = true
			}
		}

		if lastMessage == "" {
			if msg, isQuestion := messageFromPayload(payload); msg != "" {
				lastMessage = truncate(strings.TrimSpace(msg), 300)
				lastMessageIsQuestion = isQuestion
			}
		}

		if activityDone && lastMessage != "" {
			break
		}
	}
	return activity, lastMessage, lastMessageIsQuestion
}

// messageFromPayload extracts the agent's most recent user-facing message from a
// hook payload: its last assistant message, or - for a tool that asks the user
// something (e.g. AskUserQuestion) - the question/plan text it's waiting on. The
// second return is true in that latter case, so callers can avoid treating the
// question as a suggested next message.
func messageFromPayload(p map[string]interface{}) (msg string, isQuestion bool) {
	if m, _ := p["last_assistant_message"].(string); m != "" {
		return m, false
	}
	tool, _ := p["tool_name"].(string)
	if !isUserInputTool(tool) {
		return "", false
	}
	ti, _ := p["tool_input"].(map[string]interface{})
	if ti == nil {
		return "", false
	}
	if qs, ok := ti["questions"].([]interface{}); ok {
		for _, q := range qs {
			if qm, ok := q.(map[string]interface{}); ok {
				if s, _ := qm["question"].(string); s != "" {
					return s, true
				}
			}
		}
	}
	if s, _ := ti["plan"].(string); s != "" {
		return s, true
	}
	return "", false
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

// markdownEscaper backslash-escapes the inline-markdown metacharacters the web
// UI's activity renderer styles (backtick, asterisk, underscore, tilde - plus
// backslash itself, so a literal backslash can't be misread as an escape). Tilde
// matters for paths like ~/foo, which would otherwise open a ~strikethrough~ span.
var markdownEscaper = strings.NewReplacer(`\`, `\\`, "`", "\\`", `*`, `\*`, `_`, `\_`, `~`, `\~`)

// escapeMarkdown escapes a literal value interpolated into an activity line (a
// file name, a search pattern, a tool name) so the web UI shows it verbatim
// instead of styling it - e.g. a _LAYOUT_.tsx file name would otherwise render
// as "LAYOUT" in italics. The frontend inline renderer (web/src/lib/
// markdown.tsx) understands these backslash escapes.
func escapeMarkdown(s string) string {
	return markdownEscaper.Replace(s)
}

// describeActivity renders a short, human-readable description of a tool call,
// handling the common Claude and Gemini tool names. Literal values pulled from
// the tool input are markdown-escaped (see escapeMarkdown); shell commands are
// not, because the "$ ..." form is rendered whole as a code span, never parsed
// as markdown.
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
	case "Edit", "MultiEdit", "Write", "Update", "NotebookEdit", "replace", "write_file", "apply_patch":
		if p := get("file_path", "path", "absolute_path"); p != "" {
			return "Editing " + escapeMarkdown(filepath.Base(p))
		}
		return "Editing files"
	case "Read", "read_file", "read_many_files":
		if p := get("file_path", "path", "absolute_path"); p != "" {
			return "Reading " + escapeMarkdown(filepath.Base(p))
		}
		return "Reading files"
	case "Grep", "search_file_content":
		if pat := get("pattern"); pat != "" {
			return "Searching: " + escapeMarkdown(truncate(pat, 40))
		}
		return "Searching"
	case "Glob", "glob", "list_directory", "LS":
		return "Exploring files"
	case "Task":
		if d := get("description"); d != "" {
			return "Subagent: " + escapeMarkdown(truncate(d, 40))
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
		// Tool names carry markdown metachars too - e.g. mcp__hydra__git_commit
		// would render "hydra" in bold.
		return "Using " + escapeMarkdown(tool)
	}
}

// tailFile reads up to the last n bytes of the file at path, dropping a leading
// partial line when the file was truncated.
func tailFile(path string, n int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	defer f.Close()

	fi, err := f.Stat()
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	size := fi.Size()
	start := int64(0)
	if size > n {
		start = size - n
	}
	buf := make([]byte, size-start)
	if _, err := f.ReadAt(buf, start); err != nil {
		return nil, errtrace.Wrap(err)
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
	return string(r[:max]) + "..."
}
