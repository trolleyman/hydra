package sandbox

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestBuildCodexHooksMergesExistingGroups(t *testing.T) {
	existing := []byte(`{"description":"mine","hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"mine"}]}]}}`)
	data, err := BuildCodexHooks(existing, "/tmp/hydra-internal", true)
	if err != nil {
		t.Fatal(err)
	}
	var got struct {
		Description string                       `json:"description"`
		Hooks       map[string][]json.RawMessage `json:"hooks"`
	}
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatal(err)
	}
	if got.Description != "mine" || len(got.Hooks["PreToolUse"]) != 3 {
		t.Fatalf("merged hooks = %s", data)
	}
	for _, event := range []string{"SessionStart", "UserPromptSubmit", "PostToolUse", "PermissionRequest", "Stop", "SubagentStart", "SubagentStop"} {
		want := 1
		if event == "PostToolUse" {
			want = 2
		}
		if len(got.Hooks[event]) != want {
			t.Errorf("%s hooks = %d, want %d", event, len(got.Hooks[event]), want)
		}
	}
}

func TestBuildCodexHooksRejectsInvalidHostFile(t *testing.T) {
	if _, err := BuildCodexHooks([]byte(`{nope`), "/hydra", true); err == nil {
		t.Fatal("expected invalid hooks error")
	}
}

func TestBuildCodexHooksOmitsGateWhenDisabled(t *testing.T) {
	data, err := BuildCodexHooks(nil, "/hydra", false)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), `"command": "/hydra gate codex"`) {
		t.Fatalf("disabled gate present in hooks: %s", data)
	}
}
