package cli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/trolleyman/hydra/internal/api"
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

	if err := runTriggerHook(agentType, event, nil); err != nil {
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
// "running" — otherwise a resumed agent lingers as "running" after a daemon
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
