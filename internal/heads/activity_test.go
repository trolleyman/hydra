package heads

import (
	"os"
	"path/filepath"
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

	activity, _ := readStatusLogTail(root, id)
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

	activity, lastMessage := readStatusLogTail(root, id)
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
