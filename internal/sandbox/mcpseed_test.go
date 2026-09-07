package sandbox

import (
	"encoding/json"
	"strings"
	"testing"

	toml "github.com/pelletier/go-toml/v2"
	"github.com/trolleyman/hydra/internal/gate"
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
	data, err := BuildCodexConfig(existing, "/opt/hydra", nil)
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
	if features, _ := cfg["features"].(map[string]any); features["hooks"] != true {
		t.Errorf("codex hooks feature not forced on: %v", cfg["features"])
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
		"HYDRA_AGENT_REQ_DIR",
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
	if _, err := BuildCodexConfig([]byte("this = = not toml"), "/opt/hydra", nil); err == nil {
		t.Error("malformed host config should error (so the caller skips rather than clobbers)")
	}
}

func TestBuildCodexConfigFiltersMCPServers(t *testing.T) {
	existing := []byte(`
[mcp_servers.keep]
command = "keep"
[mcp_servers.drop]
command = "drop"
`)
	data, err := BuildCodexConfig(existing, "/opt/hydra", []string{"keep"})
	if err != nil {
		t.Fatal(err)
	}
	var cfg map[string]any
	if err := toml.Unmarshal(data, &cfg); err != nil {
		t.Fatal(err)
	}
	servers, _ := cfg["mcp_servers"].(map[string]any)
	if servers["keep"] == nil || servers["hydra"] == nil || servers["drop"] != nil {
		t.Fatalf("filtered servers = %#v", servers)
	}
}

func TestBuildCodexConfigCanOmitHydraControlServer(t *testing.T) {
	existing := []byte("[mcp_servers.keep]\ncommand = \"keep\"\n")
	data, err := BuildCodexConfig(existing, "", []string{"keep"})
	if err != nil {
		t.Fatal(err)
	}
	servers := ListCodexMCPServers(data)
	if len(servers) != 1 || servers[0].Name != "keep" {
		t.Fatalf("standalone MCP servers = %+v; config:\n%s", servers, data)
	}
	if strings.Contains(string(data), gate.HydraControlServer) {
		t.Fatalf("standalone config injected Hydra control server:\n%s", data)
	}
	if !strings.Contains(string(data), "hooks = false") {
		t.Fatalf("standalone config did not disable provider hooks:\n%s", data)
	}
}

func TestBuildStandaloneCodexHooksAndConfig(t *testing.T) {
	hooks, err := BuildStandaloneCodexHooks("/tmp/hydra-agent-host")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(hooks), "gate codex") || strings.Contains(string(hooks), "trigger-hook") {
		t.Fatalf("standalone Codex hooks:\n%s", hooks)
	}
	config, err := BuildStandaloneCodexConfig(nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(config), "hooks = true") || strings.Contains(string(config), gate.HydraControlServer) {
		t.Fatalf("standalone Codex config:\n%s", config)
	}
}

func TestListCodexMCPServers(t *testing.T) {
	got := ListCodexMCPServers([]byte(`
[mcp_servers.zed]
command = "z"
[mcp_servers.alpha]
url = "https://example.test/mcp"
[mcp_servers.hydra]
command = "/hydra"
`))
	if len(got) != 2 || got[0].Name != "alpha" || got[1].Name != "zed" {
		t.Fatalf("servers = %#v", got)
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
