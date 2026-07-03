package heads

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/trolleyman/hydra/internal/api"
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

func TestEnrichAgentStatusRunning(t *testing.T) {
	root := t.TempDir()
	id := "abc"
	writeStatusLog(t, root, id,
		`{"hook":{"hook_event_name":"PreToolUse","tool_name":"Edit","tool_input":{"file_path":"/repo/main.go"}}}`,
	)

	info := &api.AgentStatusInfo{Status: api.Running}
	enrichAgentStatus(root, id, info)
	if info.Activity == nil || *info.Activity != "Editing main.go" {
		t.Fatalf("activity = %v, want %q", info.Activity, "Editing main.go")
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

	info := &api.AgentStatusInfo{Status: api.Waiting}
	enrichAgentStatus(root, id, info)
	if info.LastMessage == nil || *info.LastMessage != "Which DB?" {
		t.Fatalf("lastMessage = %v, want %q", info.LastMessage, "Which DB?")
	}
	// The message is a question the agent is asking the user, not a suggestion you
	// could send back - so it must not be flagged as a suggested next message even
	// though its shape (short, single line, no mid-message break) looks terse.
	if info.LastMessageIsSuggestedNextMessage != nil {
		t.Fatalf("lastMessageIsSuggestedNextMessage = %v, want nil for a question", *info.LastMessageIsSuggestedNextMessage)
	}
	// A question tool isn't "activity" - the agent is blocked, not working.
	if info.Activity != nil {
		t.Fatalf("activity = %v, want nil while waiting", info.Activity)
	}
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
	}
	for _, c := range cases {
		if got := describeActivity(c.tool, c.input); got != c.want {
			t.Errorf("describeActivity(%q) = %q, want %q", c.tool, got, c.want)
		}
	}
}
