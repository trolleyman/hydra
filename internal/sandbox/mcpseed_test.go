package sandbox

import (
	"encoding/json"
	"strings"
	"testing"

	toml "github.com/pelletier/go-toml/v2"
)

func TestHydraMCPServerSpec(t *testing.T) {
	name, cmd, args := HydraMCPServer("/opt/hydra", "codex")
	if name != "hydra" || cmd != "/opt/hydra" || strings.Join(args, " ") != "mcp codex" {
		t.Errorf("HydraMCPServer = %q %q %v, want hydra /opt/hydra [mcp codex]", name, cmd, args)
	}
}

func TestBuildGeminiSettingsInjectsMCP(t *testing.T) {
	data, err := BuildGeminiSettings([]byte(`{"theme":"dark"}`), "/opt/hydra")
	if err != nil {
		t.Fatal(err)
	}
	var s map[string]any
	if err := json.Unmarshal(data, &s); err != nil {
		t.Fatal(err)
	}
	if s["theme"] != "dark" {
		t.Errorf("existing gemini settings not preserved: %v", s["theme"])
	}
	srv, _ := s["mcpServers"].(map[string]any)
	hydra, _ := srv["hydra"].(map[string]any)
	if hydra["command"] != "/opt/hydra" {
		t.Errorf("gemini mcpServers.hydra missing/wrong: %v", srv)
	}
}

func TestBuildCodexConfigMergesAndPreserves(t *testing.T) {
	existing := []byte("model = \"gpt-5\"\n[some_section]\nkey = \"val\"\n")
	data, err := BuildCodexConfig(existing, "/opt/hydra")
	if err != nil {
		t.Fatal(err)
	}
	var cfg map[string]any
	if err := toml.Unmarshal(data, &cfg); err != nil {
		t.Fatalf("result not valid TOML: %v\n%s", err, data)
	}
	if cfg["model"] != "gpt-5" {
		t.Errorf("existing codex config not preserved: model=%v", cfg["model"])
	}
	if sec, _ := cfg["some_section"].(map[string]any); sec["key"] != "val" {
		t.Errorf("existing codex section dropped: %v", cfg["some_section"])
	}
	servers, _ := cfg["mcp_servers"].(map[string]any)
	hydra, _ := servers["hydra"].(map[string]any)
	if hydra["command"] != "/opt/hydra" {
		t.Errorf("codex mcp_servers.hydra missing/wrong: %v", servers)
	}
	args, _ := hydra["args"].([]any)
	if len(args) != 2 || args[0] != "mcp" || args[1] != "codex" {
		t.Errorf("codex hydra args = %v, want [mcp codex]", args)
	}
	envVars, _ := hydra["env_vars"].([]any)
	gotEnv := make(map[string]bool, len(envVars))
	for _, raw := range envVars {
		if name, ok := raw.(string); ok {
			gotEnv[name] = true
		}
	}
	for _, name := range []string{
		"HYDRA_WORKTREE",
		"HYDRA_BRANCH",
		"HYDRA_GITOPS_DIR",
		"HYDRA_REVIEW_PATH",
		"HYDRA_REVIEW_REQ_DIR",
		"HYDRA_APPROVAL_DIR",
		"HYDRA_GATE_POLICY_PATH",
		"HYDRA_MCP_CATALOG_PATH",
	} {
		if !gotEnv[name] {
			t.Errorf("codex hydra env_vars missing %s: %v", name, envVars)
		}
	}
}

func TestBuildCodexConfigRejectsMalformed(t *testing.T) {
	if _, err := BuildCodexConfig([]byte("this = = not toml"), "/opt/hydra"); err == nil {
		t.Error("malformed host config should error (so the caller skips rather than clobbers)")
	}
}

func TestAgentSupportsGitTools(t *testing.T) {
	for _, a := range []AgentType{AgentTypeClaude, AgentTypeCodex, AgentTypeGemini} {
		if !AgentSupportsGitTools(a) {
			t.Errorf("%s should support git tools", a)
		}
	}
	for _, a := range []AgentType{AgentTypeCopilot, AgentTypeBash} {
		if AgentSupportsGitTools(a) {
			t.Errorf("%s should NOT support git tools (no hydra MCP server seeded)", a)
		}
	}
}
