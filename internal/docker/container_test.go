package docker

import (
	"encoding/json"
	"testing"
)

func TestBuildClaudeSettings(t *testing.T) {
	existing := []byte(`{"custom": "value"}`)
	data, err := buildClaudeSettings(existing)
	if err != nil {
		t.Fatalf("buildClaudeSettings failed: %v", err)
	}

	var settings map[string]interface{}
	if err := json.Unmarshal(data, &settings); err != nil {
		t.Fatalf("failed to unmarshal results: %v", err)
	}

	if settings["custom"] != "value" {
		t.Errorf("expected custom: value, got %v", settings["custom"])
	}

	if settings["skipDangerousModePermissionPrompt"] != true {
		t.Errorf("expected skipDangerousModePermissionPrompt: true")
	}

	if _, ok := settings["hooks"]; !ok {
		t.Errorf("expected hooks to be present")
	}

	if _, ok := settings["projects"]; ok {
		t.Errorf("expected projects NOT to be present in settings.json anymore")
	}
}

func TestBuildClaudeConfig(t *testing.T) {
	existing := []byte(`{"projects": {"/old/path": {"hasTrustDialogAccepted": true}}}`)
	worktreePath := "/new/path"
	data, err := buildClaudeConfig(existing, worktreePath)
	if err != nil {
		t.Fatalf("buildClaudeConfig failed: %v", err)
	}

	var config map[string]interface{}
	if err := json.Unmarshal(data, &config); err != nil {
		t.Fatalf("failed to unmarshal results: %v", err)
	}

	projects, ok := config["projects"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected projects map")
	}

	if _, ok := projects["/old/path"]; !ok {
		t.Errorf("expected /old/path to still be present")
	}

	newProject, ok := projects["/new/path"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected /new/path map")
	}

	if newProject["hasTrustDialogAccepted"] != true {
		t.Errorf("expected hasTrustDialogAccepted: true for /new/path")
	}
}
