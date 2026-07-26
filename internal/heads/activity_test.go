package heads

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/db"
	"github.com/trolleyman/hydra/internal/paths"
)

func writeStatusLog(t *testing.T, projectRoot, id string, lines ...string) {
	t.Helper()
	path := paths.GetStatusLogFromProjectRoot(projectRoot, id)
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	var data string
	for _, l := range lines {
		data += l + "\n"
	}
	if err := os.WriteFile(path, []byte(data), 0644); err != nil {
		t.Fatal(err)
	}
}

func TestReadStatusLogTailActivity(t *testing.T) {
	root := t.TempDir()
	id := "abc"
	writeStatusLog(t, root, id,
		`{"hook":{"hook_event_name":"SessionStart"}}`,
		`{"hook":{"hook_event_name":"PreToolUse","tool_name":"Read","tool_input":{"file_path":"/repo/internal/foo.go"}}}`,
		`{"hook":{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"go test ./...\nsecond line"}}}`,
	)

	activity, _, _ := readStatusLogTail(root, id)
	if activity != "$ go test ./..." {
		t.Fatalf("activity = %q, want %q", activity, "$ go test ./...")
	}
}

func TestReadStatusLogTailNoActivityAfterStop(t *testing.T) {
	root := t.TempDir()
	id := "abc"
	writeStatusLog(t, root, id,
		`{"hook":{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"go build"}}}`,
		`{"hook":{"hook_event_name":"Stop","last_assistant_message":"All done."}}`,
	)

	activity, lastMessage, _ := readStatusLogTail(root, id)
	if activity != "" {
		t.Fatalf("activity = %q, want empty (turn ended after last tool)", activity)
	}
	if lastMessage != "All done." {
		t.Fatalf("lastMessage = %q, want %q", lastMessage, "All done.")
	}
}

// applyPersistedActivity copies the persisted live-activity columns onto the
// status: activity only while running, last_message in every state, and the
// suggested flag round-tripped from the column. (The columns themselves are filled
// by the poller from readStatusLogTail - see TestReadStatusLogTail* above.)
func TestApplyPersistedActivity(t *testing.T) {
	running := &api.AgentStatusInfo{Status: api.Running}
	applyPersistedActivity(running, &db.Agent{Activity: "Editing main.go", LastMessage: "All done."})
	if running.Activity == nil || *running.Activity != "Editing main.go" {
		t.Fatalf("activity = %v, want %q", running.Activity, "Editing main.go")
	}
	if running.LastMessage == nil || *running.LastMessage != "All done." {
		t.Fatalf("lastMessage = %v, want %q", running.LastMessage, "All done.")
	}

	// At rest the activity column is not surfaced (the UI hides it and it's stale),
	// but the last message still is.
	rest := &api.AgentStatusInfo{Status: api.Finished}
	applyPersistedActivity(rest, &db.Agent{Activity: "Editing main.go", LastMessage: "All done."})
	if rest.Activity != nil {
		t.Fatalf("activity = %v, want nil at rest", rest.Activity)
	}
	if rest.LastMessage == nil || *rest.LastMessage != "All done." {
		t.Fatalf("lastMessage = %v, want %q at rest", rest.LastMessage, "All done.")
	}

	// The suggested-next-message flag round-trips from the column.
	sug := &api.AgentStatusInfo{Status: api.Finished}
	applyPersistedActivity(sug, &db.Agent{LastMessage: "run it", LastMessageIsSuggested: true})
	if sug.LastMessageIsSuggestedNextMessage == nil || !*sug.LastMessageIsSuggestedNextMessage {
		t.Fatalf("suggested = %v, want true", sug.LastMessageIsSuggestedNextMessage)
	}
}

func TestEnrichAgentStatusRecoversNotificationType(t *testing.T) {
	root := t.TempDir()
	id := "abc"
	nt := "policy_approval"
	// The gate writes status.json with notification_type=policy_approval; the JSON
	// poller persists only the status string, so enrichAgentStatus must recover the
	// side channel from status.json for the UI approval card to render.
	if err := WriteAgentStatus(root, id, &api.AgentStatusInfo{Status: api.NeedsInput, NotificationType: &nt, Timestamp: "t"}); err != nil {
		t.Fatal(err)
	}
	info := &api.AgentStatusInfo{Status: api.NeedsInput}
	enrichAgentStatus(root, id, info)
	if info.NotificationType == nil || *info.NotificationType != "policy_approval" {
		t.Fatalf("notification_type = %v, want policy_approval", info.NotificationType)
	}
}

func TestEnrichAgentStatusStoppedSkipped(t *testing.T) {
	root := t.TempDir()
	id := "abc"
	writeStatusLog(t, root, id,
		`{"hook":{"hook_event_name":"PreToolUse","tool_name":"Edit","tool_input":{"file_path":"/repo/main.go"}}}`,
	)

	info := &api.AgentStatusInfo{Status: api.Stopped}
	enrichAgentStatus(root, id, info)
	if info.Activity != nil {
		t.Fatalf("activity = %v, want nil for stopped agent", info.Activity)
	}
}

func TestReadStatusLogTailQuestion(t *testing.T) {
	root := t.TempDir()
	id := "abc"
	writeStatusLog(t, root, id,
		`{"hook":{"hook_event_name":"PreToolUse","tool_name":"AskUserQuestion","tool_input":{"questions":[{"question":"Which DB?"}]}}}`,
	)

	_, lastMessage, isQuestion := readStatusLogTail(root, id)
	if lastMessage != "Which DB?" {
		t.Fatalf("lastMessage = %q, want %q", lastMessage, "Which DB?")
	}
	// The message is a question the agent is asking the user, not a suggestion you
	// could send back: the poller uses isQuestion to keep it off the suggested-next
	// flag even though its shape (short, single line) looks terse.
	if !isQuestion {
		t.Fatalf("isQuestion = false, want true for an AskUserQuestion")
	}
	if !isQuestion && IsSuggestedNextMessage(lastMessage) {
		t.Fatalf("a question must not be treated as a suggested next message")
	}
	// (readStatusLogTail reports the raw tool activity here; the agent-is-blocked
	// suppression is applied downstream, gated on the running status - see the
	// poller and applyPersistedActivity.)
}

func TestIsSuggestedNextMessage(t *testing.T) {
	cases := []struct {
		msg  string
		want bool
	}{
		{"run it", true},
		{"verify it works by running the app", true},
		{"  spin up the app  ", true}, // trimmed, still terse
		{"", false},
		{"The spike is built, tested, and committed. Here's what landed...", false}, // multi-sentence
		{"line one\nline two", false},                               // multi-line
		{strings.Repeat("x", 81), false},                            // too long
		{"Where should the app binary be distributed first?", true}, // shape is terse; the question exclusion is applied by callers, not here
	}
	for _, c := range cases {
		if got := IsSuggestedNextMessage(c.msg); got != c.want {
			t.Errorf("IsSuggestedNextMessage(%q) = %v, want %v", c.msg, got, c.want)
		}
	}
}

func TestDescribeActivity(t *testing.T) {
	cases := []struct {
		tool  string
		input map[string]interface{}
		want  string
	}{
		{"Bash", map[string]interface{}{"command": "ls -la"}, "$ ls -la"},
		{"run_shell_command", map[string]interface{}{"command": "go vet"}, "$ go vet"},
		{"Edit", map[string]interface{}{"file_path": "/a/b/c.go"}, "Editing c.go"},
		{"Read", map[string]interface{}{"file_path": "/a/b/c.go"}, "Reading c.go"},
		{"Grep", map[string]interface{}{"pattern": "TODO"}, "Searching: TODO"},
		{"WebSearch", nil, "Searching the web"},
		{"SomethingNew", nil, "Using SomethingNew"},
		// Markdown metachars in interpolated literals are escaped so the web UI
		// shows them verbatim (e.g. _LAYOUT_ must not render as italics).
		{"Edit", map[string]interface{}{"file_path": "/a/routes/_LAYOUT_.tsx"}, `Editing \_LAYOUT\_.tsx`},
		{"Read", map[string]interface{}{"file_path": "/a/b/__init__.py"}, `Reading \_\_init\_\_.py`},
		{"Grep", map[string]interface{}{"pattern": "foo_*bar`"}, "Searching: foo\\_\\*bar\\`"},
		{"mcp__hydra__git_commit", nil, `Using mcp\_\_hydra\_\_git\_commit`},
		// Shell commands are NOT escaped - the "$ ..." line renders whole as a
		// code span, never parsed as markdown.
		{"Bash", map[string]interface{}{"command": "mv a_b c_d"}, "$ mv a_b c_d"},
	}
	for _, c := range cases {
		if got := describeActivity(c.tool, c.input); got != c.want {
			t.Errorf("describeActivity(%q) = %q, want %q", c.tool, got, c.want)
		}
	}
}
