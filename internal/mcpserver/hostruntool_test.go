package mcpserver

import (
	"encoding/json"
	"strings"
	"testing"
)

// The escape hatch must explain itself. The CLI could only nag about a missing
// --why (an argv is just words, and refusing one would strand agents that
// predate the flag); a structured tool can require it, and does.
func TestParseHostRunRequiresCommandAndWhy(t *testing.T) {
	if _, errMsg := parseHostRun(json.RawMessage(`{"why":"because"}`)); !strings.Contains(errMsg, "command") {
		t.Errorf("a missing command should be rejected, got %q", errMsg)
	}
	if _, errMsg := parseHostRun(json.RawMessage(`{"command":"ls","why":"  "}`)); !strings.Contains(errMsg, "why") {
		t.Errorf("a blank why should be rejected, got %q", errMsg)
	}
	if _, errMsg := parseHostRun(json.RawMessage(`{"command":"  ","why":"x"}`)); !strings.Contains(errMsg, "command") {
		t.Errorf("a blank command should be rejected, got %q", errMsg)
	}
	req, errMsg := parseHostRun(json.RawMessage(`{"command":"  git merge main  ","why":"  needs a writable .git  "}`))
	if errMsg != "" {
		t.Fatalf("valid arguments rejected: %s", errMsg)
	}
	if req.Command != "git merge main" || req.Why != "needs a writable .git" {
		t.Errorf("parsed = %+v, want both fields trimmed", req)
	}
}

// The command must survive verbatim - shell metacharacters and all. Not eating
// them is the entire reason this tool exists next to the CLI spelling.
func TestParseHostRunKeepsShellSyntaxVerbatim(t *testing.T) {
	const cmd = `ss -Hltn | grep ':266' > /tmp/out 2>&1 && echo done`
	raw, err := json.Marshal(map[string]string{"command": cmd, "why": "host listeners are invisible from my netns"})
	if err != nil {
		t.Fatal(err)
	}
	req, errMsg := parseHostRun(raw)
	if errMsg != "" {
		t.Fatalf("rejected: %s", errMsg)
	}
	if req.Command != cmd {
		t.Errorf("command = %q, want it byte-identical to what was sent", req.Command)
	}
}

// The tool is advertised only when an approval channel exists: without one it
// could never do anything but fail.
func TestHostRunToolAdvertisedOnlyWhenWired(t *testing.T) {
	if names := toolNames(toolDefs(Deps{})); contains(names, "host_run") {
		t.Errorf("host_run should be hidden with no HostRun dep, got %v", names)
	}
	deps := Deps{HostRun: func(HostRunRequest) HostRunResult { return HostRunResult{} }}
	if names := toolNames(toolDefs(deps)); !contains(names, "host_run") {
		t.Errorf("host_run should be advertised when wired, got %v", names)
	}
}

func toolNames(defs []map[string]any) []string {
	out := make([]string, 0, len(defs))
	for _, d := range defs {
		if n, ok := d["name"].(string); ok {
			out = append(out, n)
		}
	}
	return out
}

func contains(hay []string, needle string) bool {
	for _, h := range hay {
		if h == needle {
			return true
		}
	}
	return false
}
