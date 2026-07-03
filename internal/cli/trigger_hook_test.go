package cli

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/heads"
)

func TestStatusFilePathHonorsEnv(t *testing.T) {
	t.Setenv("HYDRA_STATUS_PATH", "/proj/.hydra/status/abc.json")
	got, err := statusFilePath()
	if err != nil {
		t.Fatal(err)
	}
	if got != "/proj/.hydra/status/abc.json" {
		t.Errorf("statusFilePath = %q, want the HYDRA_STATUS_PATH value", got)
	}
}

func TestStatusFilePathFallback(t *testing.T) {
	t.Setenv("HYDRA_STATUS_PATH", "")
	home := t.TempDir()
	t.Setenv("HOME", home)
	got, err := statusFilePath()
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(home, ".hydra", "status.json"); got != want {
		t.Errorf("statusFilePath = %q, want %q", got, want)
	}
}

func TestStatusLogFilePathHonorsEnv(t *testing.T) {
	t.Setenv("HYDRA_STATUS_LOG_PATH", "/proj/.hydra/status/abc.jsonl")
	got, err := statusLogFilePath()
	if err != nil {
		t.Fatal(err)
	}
	if got != "/proj/.hydra/status/abc.jsonl" {
		t.Errorf("statusLogFilePath = %q, want the HYDRA_STATUS_LOG_PATH value", got)
	}
}

func TestIsUserInputTool(t *testing.T) {
	for _, tool := range []string{"AskUserQuestion", "ExitPlanMode"} {
		if !isUserInputTool(tool) {
			t.Errorf("isUserInputTool(%q) = false, want true", tool)
		}
	}
	for _, tool := range []string{"Bash", "Edit", "Read", ""} {
		if isUserInputTool(tool) {
			t.Errorf("isUserInputTool(%q) = true, want false", tool)
		}
	}
}

// runTriggerHookForTest feeds payload on stdin to runTriggerHook with status
// files redirected into a temp dir, and returns the resulting status.json
// status (or "" if none was written).
func runTriggerHookForTest(t *testing.T, agentType, event string, payload map[string]interface{}) api.AgentStatus {
	t.Helper()
	dir := t.TempDir()
	statusPath := filepath.Join(dir, "status.json")
	t.Setenv("HYDRA_STATUS_PATH", statusPath)
	t.Setenv("HYDRA_STATUS_LOG_PATH", filepath.Join(dir, "status_log.jsonl"))
	t.Setenv("HYDRA_SUBAGENTS_DIR", filepath.Join(dir, "subagents"))

	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	in := filepath.Join(dir, "stdin.json")
	if err := os.WriteFile(in, raw, 0644); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(in)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	orig := os.Stdin
	os.Stdin = f
	defer func() { os.Stdin = orig }()

	if err := runTriggerHook(agentType, event, nil, io.Discard); err != nil {
		t.Fatalf("runTriggerHook(%q): %v", event, err)
	}

	data, err := os.ReadFile(statusPath)
	if os.IsNotExist(err) {
		return ""
	}
	if err != nil {
		t.Fatal(err)
	}
	var info api.AgentStatusInfo
	if err := json.Unmarshal(data, &info); err != nil {
		t.Fatal(err)
	}
	return info.Status
}

// TestTriggerHookPromptSubmitRunning covers issue #39: submitting a prompt must
// flip the agent to "running" immediately. UserPromptSubmit (Claude) and
// BeforeAgent (Gemini) were registered hooks but previously unhandled, so a
// freshly-submitted message lingered as waiting/finished until a tool ran.
func TestTriggerHookPromptSubmitRunning(t *testing.T) {
	cases := []struct {
		event string
		want  api.AgentStatus
	}{
		{"UserPromptSubmit", api.Running},
		{"BeforeAgent", api.Running},
		{"SessionStart", api.Running},
		{"PreCompact", ""}, // unhandled event leaves status untouched
	}
	for _, c := range cases {
		payload := map[string]interface{}{"hook_event_name": c.event}
		if got := runTriggerHookForTest(t, "claude", "", payload); got != c.want {
			t.Errorf("event %q: status = %q, want %q", c.event, got, c.want)
		}
	}
}

// TestTriggerHookSessionStartSource covers resume vs fresh start: a SessionStart
// with source="resume" (claude --continue/--resume) means the agent restored its
// conversation and is idle waiting for the user, so it must report "waiting", not
// "running" - otherwise a resumed agent lingers as "running" after a daemon
// restart. Any other source (or none) is a fresh start and stays "running".
func TestTriggerHookSessionStartSource(t *testing.T) {
	cases := []struct {
		source string
		want   api.AgentStatus
	}{
		{"resume", api.Waiting},
		{"startup", api.Running},
		{"clear", api.Running},
		{"compact", api.Running},
		{"", api.Running},
	}
	for _, c := range cases {
		payload := map[string]interface{}{"hook_event_name": "SessionStart"}
		if c.source != "" {
			payload["source"] = c.source
		}
		if got := runTriggerHookForTest(t, "claude", "", payload); got != c.want {
			t.Errorf("SessionStart source %q: status = %q, want %q", c.source, got, c.want)
		}
	}
}

// TestTriggerHookResumePreservesTerminalStatus covers the daemon-restart case: a
// head that had already finished its turn is resumed (claude --continue fires
// SessionStart source="resume"). Because ResumeHead seeds the prior terminal
// status into status.json before launch, the hook must NOT downgrade it to
// "waiting" - otherwise a finished head spuriously reverts to waiting on every
// restart. A non-terminal prior status still falls back to waiting.
func TestTriggerHookResumePreservesTerminalStatus(t *testing.T) {
	cases := []struct {
		prior api.AgentStatus
		want  api.AgentStatus
	}{
		{api.Finished, api.Finished},
		{api.Stopped, api.Stopped},
		{api.Running, api.Waiting},
		{api.Waiting, api.Waiting},
	}
	for _, c := range cases {
		dir := t.TempDir()
		statusPath := filepath.Join(dir, "status.json")
		t.Setenv("HYDRA_STATUS_PATH", statusPath)
		t.Setenv("HYDRA_STATUS_LOG_PATH", filepath.Join(dir, "status_log.jsonl"))
		t.Setenv("HYDRA_SUBAGENTS_DIR", filepath.Join(dir, "subagents"))

		seed, err := json.Marshal(api.AgentStatusInfo{Status: c.prior})
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(statusPath, seed, 0644); err != nil {
			t.Fatal(err)
		}

		payload := map[string]interface{}{"hook_event_name": "SessionStart", "source": "resume"}
		raw, err := json.Marshal(payload)
		if err != nil {
			t.Fatal(err)
		}
		in := filepath.Join(dir, "stdin.json")
		if err := os.WriteFile(in, raw, 0644); err != nil {
			t.Fatal(err)
		}
		f, err := os.Open(in)
		if err != nil {
			t.Fatal(err)
		}
		orig := os.Stdin
		os.Stdin = f
		if err := runTriggerHook("claude", "", nil, io.Discard); err != nil {
			f.Close()
			os.Stdin = orig
			t.Fatalf("runTriggerHook: %v", err)
		}
		f.Close()
		os.Stdin = orig

		data, err := os.ReadFile(statusPath)
		if err != nil {
			t.Fatal(err)
		}
		var info api.AgentStatusInfo
		if err := json.Unmarshal(data, &info); err != nil {
			t.Fatal(err)
		}
		if info.Status != c.want {
			t.Errorf("resume with prior %q: status = %q, want %q", c.prior, info.Status, c.want)
		}
	}
}

func TestQuestionText(t *testing.T) {
	ask := map[string]interface{}{
		"tool_input": map[string]interface{}{
			"questions": []interface{}{
				map[string]interface{}{"question": "Which database should we use?"},
			},
		},
	}
	if got := questionText(ask); got != "Which database should we use?" {
		t.Errorf("questionText(AskUserQuestion) = %q", got)
	}

	plan := map[string]interface{}{
		"tool_input": map[string]interface{}{"plan": "Step 1: do the thing"},
	}
	if got := questionText(plan); got != "Step 1: do the thing" {
		t.Errorf("questionText(ExitPlanMode) = %q", got)
	}

	if got := questionText(map[string]interface{}{"tool_input": map[string]interface{}{}}); got != "" {
		t.Errorf("questionText(empty) = %q, want empty", got)
	}
}

// runTriggerHookInfoForTest feeds payload on stdin to runTriggerHook with status
// files redirected into a temp dir, and returns the parsed status.json (nil if
// none was written).
func runTriggerHookInfoForTest(t *testing.T, agentType, event string, payload map[string]interface{}) *api.AgentStatusInfo {
	t.Helper()
	dir := t.TempDir()
	statusPath := filepath.Join(dir, "status.json")
	t.Setenv("HYDRA_STATUS_PATH", statusPath)
	t.Setenv("HYDRA_STATUS_LOG_PATH", filepath.Join(dir, "status_log.jsonl"))
	t.Setenv("HYDRA_SUBAGENTS_DIR", filepath.Join(dir, "subagents"))

	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	in := filepath.Join(dir, "stdin.json")
	if err := os.WriteFile(in, raw, 0644); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(in)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	orig := os.Stdin
	os.Stdin = f
	defer func() { os.Stdin = orig }()

	if err := runTriggerHook(agentType, event, nil, io.Discard); err != nil {
		t.Fatalf("runTriggerHook: %v", err)
	}

	data, err := os.ReadFile(statusPath)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	var info api.AgentStatusInfo
	if err := json.Unmarshal(data, &info); err != nil {
		t.Fatal(err)
	}
	return &info
}

// TestTriggerHookQuestionNotSuggested covers a user-input tool's PreToolUse: the
// status flips to needs_input and the question becomes last_message, but it must
// NOT be flagged as a suggested next message - it's a question the agent is
// asking, not an instruction you'd send back, even though its shape looks terse.
func TestTriggerHookQuestionNotSuggested(t *testing.T) {
	info := runTriggerHookInfoForTest(t, "claude", "", map[string]interface{}{
		"hook_event_name": "PreToolUse",
		"tool_name":       "AskUserQuestion",
		"tool_input": map[string]interface{}{
			"questions": []interface{}{
				map[string]interface{}{"question": "Where should the app binary be distributed first?"},
			},
		},
	})
	if info == nil {
		t.Fatal("no status.json written")
	}
	if info.Status != api.NeedsInput {
		t.Errorf("status = %q, want needs_input", info.Status)
	}
	if info.LastMessage == nil || *info.LastMessage != "Where should the app binary be distributed first?" {
		t.Errorf("last_message = %v", info.LastMessage)
	}
	if info.LastMessageIsSuggestedNextMessage != nil {
		t.Errorf("last_message_is_suggested_next_message = %v, want nil for a question", *info.LastMessageIsSuggestedNextMessage)
	}
}

// runTriggerHookStatusFileForTest is like runTriggerHookInfoForTest but decodes
// the full on-disk StatusFile, so tests can assert internal-only fields such as
// notification_type. Returns nil if no status.json was written.
func runTriggerHookStatusFileForTest(t *testing.T, agentType, event string, payload map[string]interface{}) *heads.StatusFile {
	t.Helper()
	dir := t.TempDir()
	statusPath := filepath.Join(dir, "status.json")
	t.Setenv("HYDRA_STATUS_PATH", statusPath)
	t.Setenv("HYDRA_STATUS_LOG_PATH", filepath.Join(dir, "status_log.jsonl"))
	t.Setenv("HYDRA_SUBAGENTS_DIR", filepath.Join(dir, "subagents"))

	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	in := filepath.Join(dir, "stdin.json")
	if err := os.WriteFile(in, raw, 0644); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(in)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	orig := os.Stdin
	os.Stdin = f
	defer func() { os.Stdin = orig }()

	if err := runTriggerHook(agentType, event, nil, io.Discard); err != nil {
		t.Fatalf("runTriggerHook: %v", err)
	}

	data, err := os.ReadFile(statusPath)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	var file heads.StatusFile
	if err := json.Unmarshal(data, &file); err != nil {
		t.Fatal(err)
	}
	return &file
}

// TestTriggerHookExitPlanModeAutoApproves covers the plan-mode auto-approval: a
// Hydra head runs fully autonomously in a throwaway sandbox, so the ExitPlanMode
// permission gate is pure friction. The PermissionRequest hook must emit Claude's
// "allow" decision on stdout (so the user is never prompted) and report the agent
// as running - it proceeds straight into the work rather than waiting.
func TestTriggerHookExitPlanModeAutoApproves(t *testing.T) {
	dir := t.TempDir()
	statusPath := filepath.Join(dir, "status.json")
	t.Setenv("HYDRA_STATUS_PATH", statusPath)
	t.Setenv("HYDRA_STATUS_LOG_PATH", filepath.Join(dir, "status_log.jsonl"))
	t.Setenv("HYDRA_SUBAGENTS_DIR", filepath.Join(dir, "subagents"))

	raw, err := json.Marshal(map[string]interface{}{
		"hook_event_name": "PermissionRequest",
		"tool_name":       "ExitPlanMode",
		"tool_input":      map[string]interface{}{"plan": "Step 1: build the thing"},
	})
	if err != nil {
		t.Fatal(err)
	}
	in := filepath.Join(dir, "stdin.json")
	if err := os.WriteFile(in, raw, 0644); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(in)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	orig := os.Stdin
	os.Stdin = f
	defer func() { os.Stdin = orig }()

	var stdout bytes.Buffer
	if err := runTriggerHook("claude", "", nil, &stdout); err != nil {
		t.Fatalf("runTriggerHook: %v", err)
	}

	// stdout must carry exactly Claude's PermissionRequest "allow" decision.
	var out struct {
		HookSpecificOutput struct {
			HookEventName string `json:"hookEventName"`
			Decision      struct {
				Behavior string `json:"behavior"`
			} `json:"decision"`
		} `json:"hookSpecificOutput"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &out); err != nil {
		t.Fatalf("stdout %q is not valid approval JSON: %v", stdout.String(), err)
	}
	if out.HookSpecificOutput.HookEventName != "PermissionRequest" {
		t.Errorf("hookEventName = %q, want PermissionRequest", out.HookSpecificOutput.HookEventName)
	}
	if out.HookSpecificOutput.Decision.Behavior != "allow" {
		t.Errorf("decision.behavior = %q, want allow", out.HookSpecificOutput.Decision.Behavior)
	}

	// The agent proceeds into the work, so it's running, not waiting on the user.
	data, err := os.ReadFile(statusPath)
	if err != nil {
		t.Fatal(err)
	}
	var info api.AgentStatusInfo
	if err := json.Unmarshal(data, &info); err != nil {
		t.Fatal(err)
	}
	if info.Status != api.Running {
		t.Errorf("ExitPlanMode status = %q, want running", info.Status)
	}
}

// TestTriggerHookPermissionRequest covers a non-ExitPlanMode permission prompt: a
// genuinely non-bypassable prompt still means the agent is explicitly blocked on
// the user (needs_input) and is only observed - no approval is written to stdout.
func TestTriggerHookPermissionRequest(t *testing.T) {
	other := runTriggerHookInfoForTest(t, "claude", "", map[string]interface{}{
		"hook_event_name": "PermissionRequest",
		"tool_name":       "Bash",
		"tool_input":      map[string]interface{}{"command": "rm -rf /"},
	})
	if other == nil || other.Status != api.NeedsInput {
		t.Errorf("non-plan PermissionRequest status = %v, want needs_input", other)
	}
	if other != nil && other.LastMessage != nil {
		t.Errorf("non-plan PermissionRequest last_message = %v, want none", *other.LastMessage)
	}
}

// TestTriggerHookNotificationTypes covers the AskUserQuestion fix: the
// notification_type drives the status. An explicit prompt (permission_prompt /
// elicitation_dialog) becomes needs_input - the red "the agent needs you now"
// state the poller flags at once; the idle nudge (idle_prompt / unrecognised)
// becomes the softer waiting; an answered elicitation goes back to running;
// auth_success writes nothing.
func TestTriggerHookNotificationTypes(t *testing.T) {
	cases := []struct {
		notificationType string
		wantStatus       api.AgentStatus // "" means no status.json written
	}{
		{"idle_prompt", api.Waiting},
		{"permission_prompt", api.NeedsInput},
		{"elicitation_dialog", api.NeedsInput},
		{"elicitation_complete", api.Running},
		{"elicitation_response", api.Running},
		{"auth_success", ""},
		{"", api.Waiting}, // unrecognised/missing type defaults to waiting (deferred)
	}
	for _, c := range cases {
		payload := map[string]interface{}{
			"hook_event_name": "Notification",
			"message":         "something",
		}
		if c.notificationType != "" {
			payload["notification_type"] = c.notificationType
		}
		file := runTriggerHookStatusFileForTest(t, "claude", "", payload)
		if c.wantStatus == "" {
			if file != nil {
				t.Errorf("notification_type %q: wrote status %q, want no write", c.notificationType, file.Status)
			}
			continue
		}
		if file == nil {
			t.Errorf("notification_type %q: no status.json written, want %q", c.notificationType, c.wantStatus)
			continue
		}
		if file.Status != c.wantStatus {
			t.Errorf("notification_type %q: status = %q, want %q", c.notificationType, file.Status, c.wantStatus)
		}
	}
}

// fireHook runs runTriggerHook once against caller-provided status/subagents
// paths so a multi-hook sequence (SubagentStart ... Stop) shares the same files
// across calls. Returns the persisted status.json status ("" if none was written).
func fireHook(t *testing.T, statusPath, subagentsDir, event string, payload map[string]interface{}) api.AgentStatus {
	t.Helper()
	t.Setenv("HYDRA_STATUS_PATH", statusPath)
	t.Setenv("HYDRA_STATUS_LOG_PATH", statusPath+".log")
	t.Setenv("HYDRA_SUBAGENTS_DIR", subagentsDir)

	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	in := filepath.Join(t.TempDir(), "stdin.json")
	if err := os.WriteFile(in, raw, 0644); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(in)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	orig := os.Stdin
	os.Stdin = f
	defer func() { os.Stdin = orig }()

	if err := runTriggerHook("claude", event, nil, io.Discard); err != nil {
		t.Fatalf("runTriggerHook(%q): %v", event, err)
	}

	data, err := os.ReadFile(statusPath)
	if os.IsNotExist(err) {
		return ""
	}
	if err != nil {
		t.Fatal(err)
	}
	var info api.AgentStatusInfo
	if err := json.Unmarshal(data, &info); err != nil {
		t.Fatal(err)
	}
	return info.Status
}

// TestTriggerHookSubagentDoesNotClobberParent covers the sub-agent status bug: a
// Claude sub-agent (Task tool) fires the same hooks against the head's shared
// status.json, but its tool activity must NOT rewrite the parent agent's status
// - otherwise a still-running sub-agent flips a needs_input/finished parent back
// to running. Sub-agent hooks are identified by the agent_id field the main
// agent's hooks lack.
func TestTriggerHookSubagentDoesNotClobberParent(t *testing.T) {
	dir := t.TempDir()
	statusPath := filepath.Join(dir, "status.json")
	subagents := filepath.Join(dir, "subagents")

	// The parent asked the user a question.
	seed, err := json.Marshal(api.AgentStatusInfo{Status: api.NeedsInput})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(statusPath, seed, 0644); err != nil {
		t.Fatal(err)
	}

	// A sub-agent's PostToolUse (carries agent_id) must leave the parent alone.
	if got := fireHook(t, statusPath, subagents, "", map[string]interface{}{
		"hook_event_name": "PostToolUse",
		"tool_name":       "Bash",
		"agent_id":        "aabbccddeeff00112",
	}); got != api.NeedsInput {
		t.Errorf("parent status after sub-agent PostToolUse = %q, want needs_input (unchanged)", got)
	}

	// A main-agent PostToolUse (no agent_id) still updates the parent to running.
	if got := fireHook(t, statusPath, subagents, "", map[string]interface{}{
		"hook_event_name": "PostToolUse",
		"tool_name":       "Bash",
	}); got != api.Running {
		t.Errorf("parent status after main PostToolUse = %q, want running", got)
	}
}

// TestTriggerHookStopAwaitsSubagents covers finished-vs-still-working: when the
// main turn ends (Stop) while sub-agents it launched are still running, the head
// isn't done - it reports running, not finished. Once the sub-agents stop, the
// next Stop is a genuine finish. This is what makes "finished" reliable enough to
// gate auto-merge on.
func TestTriggerHookStopAwaitsSubagents(t *testing.T) {
	dir := t.TempDir()
	statusPath := filepath.Join(dir, "status.json")
	subagents := filepath.Join(dir, "subagents")
	if err := os.MkdirAll(subagents, 0755); err != nil {
		t.Fatal(err)
	}

	fireHook(t, statusPath, subagents, "", map[string]interface{}{
		"hook_event_name": "SubagentStart",
		"agent_id":        "sub1",
	})
	if got := fireHook(t, statusPath, subagents, "", map[string]interface{}{
		"hook_event_name": "Stop",
	}); got != api.Running {
		t.Errorf("Stop with a live sub-agent = %q, want running", got)
	}

	fireHook(t, statusPath, subagents, "", map[string]interface{}{
		"hook_event_name": "SubagentStop",
		"agent_id":        "sub1",
	})
	if got := fireHook(t, statusPath, subagents, "", map[string]interface{}{
		"hook_event_name": "Stop",
	}); got != api.Finished {
		t.Errorf("Stop after sub-agents done = %q, want finished", got)
	}
}

// TestTriggerHookSuggestedNextMessage covers a terse closing message on turn end:
// it's flagged as a suggested next message so the UI marks it with a caret.
func TestTriggerHookSuggestedNextMessage(t *testing.T) {
	info := runTriggerHookInfoForTest(t, "claude", "", map[string]interface{}{
		"hook_event_name":        "Stop",
		"last_assistant_message": "run it",
	})
	if info == nil {
		t.Fatal("no status.json written")
	}
	if info.LastMessage == nil || *info.LastMessage != "run it" {
		t.Errorf("last_message = %v", info.LastMessage)
	}
	if info.LastMessageIsSuggestedNextMessage == nil || !*info.LastMessageIsSuggestedNextMessage {
		t.Errorf("last_message_is_suggested_next_message = %v, want true", info.LastMessageIsSuggestedNextMessage)
	}
}
