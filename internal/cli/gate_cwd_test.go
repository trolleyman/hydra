package cli

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/trolleyman/hydra/internal/gate"
)

// postAdviceFor runs the gate over a PostToolUse payload and returns the
// additionalContext it attached (empty when it stayed silent).
func postAdviceFor(t *testing.T, payload map[string]any) string {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	var out bytes.Buffer
	if err := runGate("claude", bytes.NewReader(raw), &out); err != nil {
		t.Fatalf("runGate: %v", err)
	}
	if out.Len() == 0 {
		return ""
	}
	var got struct {
		HookSpecificOutput struct {
			HookEventName     string `json:"hookEventName"`
			AdditionalContext string `json:"additionalContext"`
		} `json:"hookSpecificOutput"`
	}
	if err := json.Unmarshal(out.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal hook output %q: %v", out.String(), err)
	}
	if name := got.HookSpecificOutput.HookEventName; name != "PostToolUse" {
		t.Fatalf("hook output should be a PostToolUse one, got %q", name)
	}
	return got.HookSpecificOutput.AdditionalContext
}

// Where the persistent Bash shell ended up is read from the hook payload's own
// top-level `cwd`, which Claude stamps AFTER the command ran. Getting that field
// name (or the env holding the root) wrong would not fail anything - the advice
// would just silently never fire - so it is pinned here.
func TestGatePostAdviceReportsShellCwd(t *testing.T) {
	const wt = "/repo/.hydra/local/worktrees/head"
	t.Setenv(gate.EnvWorktree, wt)

	advice := postAdviceFor(t, map[string]any{
		"hook_event_name": "PostToolUse",
		"tool_name":       "Bash",
		"tool_input":      map[string]any{"command": "cd web && pwd"},
		"tool_response":   map[string]any{"stdout": wt + "/web\n"},
		"cwd":             wt + "/web",
	})
	if !strings.Contains(advice, wt+"/web") {
		t.Errorf("advice should name the shell's new cwd, got %q", advice)
	}

	// Back at the root, and for a non-Bash tool, the gate says nothing.
	if advice := postAdviceFor(t, map[string]any{
		"hook_event_name": "PostToolUse",
		"tool_name":       "Bash",
		"tool_input":      map[string]any{"command": "pwd"},
		"cwd":             wt,
	}); advice != "" {
		t.Errorf("shell at the worktree root should get no advice, got %q", advice)
	}
	if advice := postAdviceFor(t, map[string]any{
		"hook_event_name": "PostToolUse",
		"tool_name":       "Read",
		"tool_input":      map[string]any{"file_path": wt + "/web/src/App.tsx"},
		"cwd":             wt + "/web",
	}); advice != "" {
		t.Errorf("non-Bash tool should get no shell advice, got %q", advice)
	}
}

// A failing Bash call arrives as PostToolUseFailure, and that is exactly when the
// shell's cwd is most surprising (it keeps a `cd` only on a zero exit), so the
// note has to ride that event too.
func TestGatePostAdviceCombinesGitAndCwd(t *testing.T) {
	const wt = "/repo/.hydra/local/worktrees/head"
	t.Setenv(gate.EnvWorktree, wt)

	advice := postAdviceFor(t, map[string]any{
		"hook_event_name": "PostToolUseFailure",
		"tool_name":       "Bash",
		"tool_input":      map[string]any{"command": "git commit -m x"},
		"tool_response":   map[string]any{"stderr": "error: Unable to create '/repo/.git/index.lock': Read-only file system"},
		"cwd":             wt + "/web",
	})
	if !strings.Contains(advice, "git_commit") {
		t.Errorf("read-only git advice should survive alongside the cwd note, got %q", advice)
	}
	if !strings.Contains(advice, wt+"/web") {
		t.Errorf("cwd note should survive alongside the git advice, got %q", advice)
	}
}
