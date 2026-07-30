package cli

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/trolleyman/hydra/internal/gate"
)

// seedPolicy writes a minimal enabled policy and points the gate at it, as
// heads.seedHead does for a real head. Without it the PreToolUse path fails open
// before it ever gets to the advice.
func seedPolicy(t *testing.T) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "policy.json")
	data, err := json.Marshal(gate.Policy{GateEnabled: true})
	if err != nil {
		t.Fatalf("marshal policy: %v", err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatalf("write policy: %v", err)
	}
	t.Setenv(gate.EnvPolicyPath, path)
}

// preAdviceFor runs the gate over a PreToolUse payload for an allowed command and
// returns the additionalContext it attached (empty when it stayed silent).
func preAdviceFor(t *testing.T, toolName, cwd string) string {
	t.Helper()
	raw, err := json.Marshal(map[string]any{
		"hook_event_name": "PreToolUse",
		"tool_name":       toolName,
		"tool_input":      map[string]any{"command": "rg pat src"},
		"cwd":             cwd,
	})
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
			HookEventName      string `json:"hookEventName"`
			AdditionalContext  string `json:"additionalContext"`
			PermissionDecision string `json:"permissionDecision"`
		} `json:"hookSpecificOutput"`
	}
	if err := json.Unmarshal(out.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal hook output %q: %v", out.String(), err)
	}
	if name := got.HookSpecificOutput.HookEventName; name != "PreToolUse" {
		t.Fatalf("hook output should be a PreToolUse one, got %q", name)
	}
	// An advice-only response must not carry a decision - the call is allowed.
	if d := got.HookSpecificOutput.PermissionDecision; d != "" {
		t.Fatalf("advice should not decide the call, got permissionDecision %q", d)
	}
	return got.HookSpecificOutput.AdditionalContext
}

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

// A failing Bash call never delivers PostToolUse advice (Claude drops
// additionalContext from PostToolUseFailure), so the shell's position has to be
// restated on the way IN as well. This is the half that covers a run of failures.
func TestGatePreAdviceReportsShellCwd(t *testing.T) {
	const wt = "/repo/.hydra/local/worktrees/head"
	t.Setenv(gate.EnvWorktree, wt)
	seedPolicy(t)

	if advice := preAdviceFor(t, "Bash", wt+"/web"); !strings.Contains(advice, wt+"/web") {
		t.Errorf("advice should name where the shell already is, got %q", advice)
	}
	if advice := preAdviceFor(t, "Bash", wt); advice != "" {
		t.Errorf("shell at the worktree root should get no advice, got %q", advice)
	}
	if advice := preAdviceFor(t, "Read", wt+"/web"); advice != "" {
		t.Errorf("non-Bash tool should get no shell advice, got %q", advice)
	}
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

// The read-only .git explanation is produced on the one event Claude drops
// (PostToolUseFailure), so it has to be held and re-delivered on the next
// PreToolUse. Without this the pointer at the mcp__hydra__git_* tools was written
// into the void for every uncovered git write - `git tag`, `git worktree add` -
// since those fail, and failing is what makes the context disappear.
func TestGateDefersDroppedAdviceToNextCall(t *testing.T) {
	const wt = "/repo/.hydra/local/worktrees/head"
	t.Setenv(gate.EnvWorktree, wt)
	t.Setenv(gate.EnvApprovalDir, t.TempDir())
	seedPolicy(t)

	// A failing git write: nothing is emitted now, because nothing would arrive.
	// Note the payload shape - a failure carries a bare `error` string and NO
	// tool_response, which is the field the advice used to look in.
	if advice := postAdviceFor(t, map[string]any{
		"hook_event_name": "PostToolUseFailure",
		"tool_name":       "Bash",
		"tool_input":      map[string]any{"command": "git tag v1"},
		"error":           "Exit code 128\nfatal: cannot lock ref 'refs/tags/v1': Unable to create '/repo/.git/refs/tags/v1.lock': Read-only file system",
		"is_interrupt":    false,
		"cwd":             wt,
	}); advice != "" {
		t.Fatalf("a dropped event should emit nothing, got %q", advice)
	}

	// It arrives on the next call instead - and on ANY tool, not just Bash, since
	// it is about a call that already happened.
	advice := preAdviceFor(t, "Read", wt)
	if !strings.Contains(advice, "mcp__hydra__git_") {
		t.Fatalf("deferred git advice should arrive on the next call, got %q", advice)
	}
	if !strings.Contains(advice, "previous") {
		t.Errorf("deferred advice should say it is about an earlier call, got %q", advice)
	}
	// And only once.
	if advice := preAdviceFor(t, "Read", wt); advice != "" {
		t.Errorf("deferred advice should be delivered once, got %q", advice)
	}
}

// A call the USER interrupted was not refused by anything, so there is nothing to
// explain - and its partial output can contain arbitrary text.
func TestGateIgnoresInterruptedCalls(t *testing.T) {
	const wt = "/repo/.hydra/local/worktrees/head"
	t.Setenv(gate.EnvWorktree, wt)
	t.Setenv(gate.EnvApprovalDir, t.TempDir())
	seedPolicy(t)

	if advice := postAdviceFor(t, map[string]any{
		"hook_event_name": "PostToolUseFailure",
		"tool_name":       "Bash",
		"tool_input":      map[string]any{"command": "git tag v1"},
		"error":           "fatal: cannot lock ref: Read-only file system",
		"is_interrupt":    true,
		"cwd":             wt,
	}); advice != "" {
		t.Fatalf("an interrupted call should emit nothing, got %q", advice)
	}
	if advice := preAdviceFor(t, "Read", wt); advice != "" {
		t.Errorf("an interrupted call should queue nothing either, got %q", advice)
	}
}

// A deny swallows its own output, so taking the queue there would lose the note
// for good. It has to survive until a call that actually emits.
func TestGateDeferredAdviceSurvivesADeny(t *testing.T) {
	const wt = "/repo/.hydra/local/worktrees/head"
	t.Setenv(gate.EnvWorktree, wt)
	t.Setenv(gate.EnvApprovalDir, t.TempDir())
	seedPolicy(t)

	if err := gate.QueueAdvice(os.Getenv(gate.EnvApprovalDir), "", "About your previous Bash call: held note", time.Now()); err != nil {
		t.Fatalf("queue: %v", err)
	}

	// `git commit` is redirected to the git tools, i.e. denied at PreToolUse.
	raw, err := json.Marshal(map[string]any{
		"hook_event_name": "PreToolUse",
		"tool_name":       "Bash",
		"tool_input":      map[string]any{"command": "git commit -m x"},
		"cwd":             wt,
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var out bytes.Buffer
	if err := runGate("claude", bytes.NewReader(raw), &out); err != nil {
		t.Fatalf("runGate: %v", err)
	}
	if !strings.Contains(out.String(), "deny") {
		t.Fatalf("expected the git commit redirect to deny, got %q", out.String())
	}

	if advice := preAdviceFor(t, "Bash", wt); !strings.Contains(advice, "held note") {
		t.Errorf("advice should survive a deny and land on the next allowed call, got %q", advice)
	}
}

// Two advices can apply to one call, and they must not evict each other. A git
// write whose failure did not set the script's exit status (here, piped into
// something that succeeded) is the case where both are live at once.
func TestGatePostAdviceCombinesGitAndCwd(t *testing.T) {
	const wt = "/repo/.hydra/local/worktrees/head"
	t.Setenv(gate.EnvWorktree, wt)

	advice := postAdviceFor(t, map[string]any{
		"hook_event_name": "PostToolUse",
		"tool_name":       "Bash",
		"tool_input":      map[string]any{"command": "git commit -m x | tail -3"},
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
