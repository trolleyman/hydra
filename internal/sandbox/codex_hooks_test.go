package sandbox

import (
	"encoding/json"
	"testing"
)

func TestBuildCodexHooksMergesExistingGroups(t *testing.T) {
	existing := []byte(`{"description":"mine","hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"mine"}]}]}}`)
	data, err := BuildCodexHooks(existing, "/tmp/hydra-internal")
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
	if got.Description != "mine" || len(got.Hooks["PreToolUse"]) != 2 {
		t.Fatalf("merged hooks = %s", data)
	}
	for _, event := range []string{"SessionStart", "UserPromptSubmit", "PostToolUse", "PermissionRequest", "Stop", "SubagentStart", "SubagentStop"} {
		if len(got.Hooks[event]) != 1 {
			t.Errorf("%s hooks = %d", event, len(got.Hooks[event]))
		}
	}
}

func TestBuildCodexHooksRejectsInvalidHostFile(t *testing.T) {
	if _, err := BuildCodexHooks([]byte(`{nope`), "/hydra"); err == nil {
		t.Fatal("expected invalid hooks error")
	}
}
