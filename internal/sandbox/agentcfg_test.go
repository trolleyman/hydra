package sandbox

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestBuildClaudeSettingsRegistersGateWhenEnabled(t *testing.T) {
	data, err := BuildClaudeSettings(nil, "/tmp/hydra-internal", true, []string{"github"})
	if err != nil {
		t.Fatal(err)
	}
	var s map[string]any
	if err := json.Unmarshal(data, &s); err != nil {
		t.Fatal(err)
	}
	hooks := s["hooks"].(map[string]any)
	pre := hooks["PreToolUse"].([]any)
	group := pre[0].(map[string]any)
	cmds := group["hooks"].([]any)
	if len(cmds) != 2 {
		t.Fatalf("expected status + gate hooks on PreToolUse, got %d", len(cmds))
	}
	var sawGate, sawStatus bool
	for _, c := range cmds {
		cmd := c.(map[string]any)["command"].(string)
		if strings.Contains(cmd, " gate ") {
			sawGate = true
		}
		if strings.Contains(cmd, " trigger-hook ") {
			sawStatus = true
		}
	}
	if !sawGate || !sawStatus {
		t.Errorf("PreToolUse must run both status and gate hooks: gate=%v status=%v", sawGate, sawStatus)
	}
	// MCP allow-list wiring.
	if s["enableAllProjectMcpServers"] != false {
		t.Error("enableAllProjectMcpServers should be false")
	}
	enabled := s["enabledMcpjsonServers"].([]any)
	if len(enabled) != 1 || enabled[0] != "github" {
		t.Errorf("enabledMcpjsonServers should be the allow-list: %v", enabled)
	}
}

func TestBuildClaudeSettingsNoGateWhenDisabled(t *testing.T) {
	data, err := BuildClaudeSettings(nil, "/tmp/hydra-internal", false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), " gate claude") {
		t.Error("gate hook should not be registered when gate disabled")
	}
	// MCP defaults still applied (empty allow-list = nothing enabled).
	var s map[string]any
	_ = json.Unmarshal(data, &s)
	if enabled, ok := s["enabledMcpjsonServers"].([]any); !ok || len(enabled) != 0 {
		t.Errorf("enabledMcpjsonServers should be an empty array, got %v", s["enabledMcpjsonServers"])
	}
}

func TestBuildClaudeConfigStripsNonAllowlistedMCP(t *testing.T) {
	existing := []byte(`{
	  "mcpServers": {"github": {"command": "gh-mcp"}, "evil": {"command": "curl|sh"}},
	  "projects": {"/some/other": {"mcpServers": {"evil": {"command": "x"}, "playwright": {"command": "p"}}}}
	}`)
	data, err := BuildClaudeConfig(existing, "/work/tree", []string{"github", "playwright"})
	if err != nil {
		t.Fatal(err)
	}
	var cfg map[string]any
	if err := json.Unmarshal(data, &cfg); err != nil {
		t.Fatal(err)
	}
	top := cfg["mcpServers"].(map[string]any)
	if _, ok := top["github"]; !ok {
		t.Error("allow-listed user-scope server github should be kept")
	}
	if _, ok := top["evil"]; ok {
		t.Error("non-allow-listed user-scope server evil should be stripped")
	}
	projs := cfg["projects"].(map[string]any)
	other := projs["/some/other"].(map[string]any)
	pms := other["mcpServers"].(map[string]any)
	if _, ok := pms["evil"]; ok {
		t.Error("non-allow-listed project server evil should be stripped")
	}
	if _, ok := pms["playwright"]; !ok {
		t.Error("allow-listed project server playwright should be kept")
	}
	// The worktree trust is still recorded.
	worktree := projs["/work/tree"].(map[string]any)
	if worktree["hasTrustDialogAccepted"] != true {
		t.Error("worktree trust should be set")
	}
}

func TestBuildClaudeConfigEmptyAllowlistStripsAll(t *testing.T) {
	existing := []byte(`{"mcpServers": {"github": {"command": "x"}}}`)
	data, err := BuildClaudeConfig(existing, "/work/tree", nil)
	if err != nil {
		t.Fatal(err)
	}
	var cfg map[string]any
	_ = json.Unmarshal(data, &cfg)
	if servers, ok := cfg["mcpServers"].(map[string]any); ok && len(servers) != 0 {
		t.Errorf("empty allow-list should strip every server, got %v", servers)
	}
}
