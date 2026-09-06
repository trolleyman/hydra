package agenthost

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/trolleyman/hydra/internal/agenthostapi"
	"github.com/trolleyman/hydra/internal/policyapi"
	"github.com/trolleyman/hydra/internal/sandbox"
)

func TestAllowedMCPServersRequiresExplicitGrant(t *testing.T) {
	servers := map[string]policyapi.MCPServerPolicy{
		"all": {Decision: policyapi.PolicyAllow},
		"partial": {Decision: policyapi.PolicyAsk, Tools: map[string]policyapi.MCPToolPolicy{
			"read": {Decision: policyapi.PolicyAllow},
		}},
		"ask": {Decision: policyapi.PolicyAsk},
		"deny": {Decision: policyapi.PolicyDeny, Tools: map[string]policyapi.MCPToolPolicy{
			"read": {Decision: policyapi.PolicyAllow},
		}},
	}
	got := strings.Join(allowedMCPServers(servers), ",")
	if got != "all,partial" {
		t.Fatalf("allowed MCP servers = %q, want all,partial", got)
	}
}

func TestProviderGatePolicyMapsCoreAndMCPDecisions(t *testing.T) {
	read, bash := policyapi.PolicyDeny, policyapi.PolicyAsk
	policy := policyapi.EffectivePolicy{
		UserHome: "/home/test", Workspace: "/workspace",
		Network: policyapi.EffectiveNetworkPolicy{Mode: policyapi.NetworkHard, AllowedHosts: []string{"docs.example"}},
		Tools: policyapi.ToolPolicy{
			Core: &policyapi.CoreToolPolicy{Read: &read, Bash: &bash},
			Mcp: map[string]policyapi.MCPServerPolicy{
				"all":  {Decision: policyapi.PolicyAllow},
				"none": {Decision: policyapi.PolicyDeny},
				"partial": {Decision: policyapi.PolicyAsk, Tools: map[string]policyapi.MCPToolPolicy{
					"read": {Decision: policyapi.PolicyAllow}, "write": {Decision: policyapi.PolicyDeny},
				}},
			},
		},
	}
	got := providerGatePolicy(policy, sandbox.AgentTypeCodex)
	if got.ToolDecisions["read"] != "deny" || got.ToolDecisions["bash"] != "ask" {
		t.Fatalf("core decisions = %+v", got.ToolDecisions)
	}
	if strings.Join(got.MCPAllowed, ",") != "all" || strings.Join(got.MCPBlocked, ",") != "none" {
		t.Fatalf("MCP server policy = allowed %v blocked %v", got.MCPAllowed, got.MCPBlocked)
	}
	if strings.Join(got.MCPToolsAllowed, ",") != "partial__read" || strings.Join(got.MCPToolsBlocked, ",") != "partial__write" {
		t.Fatalf("MCP tool policy = allowed %v blocked %v", got.MCPToolsAllowed, got.MCPToolsBlocked)
	}
}

func TestProviderSeedsFilterMCPAndStandingPrompt(t *testing.T) {
	home, workspace, conversation := t.TempDir(), t.TempDir(), t.TempDir()
	if err := os.MkdirAll(filepath.Join(home, ".codex"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".codex", "config.toml"), []byte("[mcp_servers.keep]\ncommand = \"keep\"\n[mcp_servers.drop]\ncommand = \"drop\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".codex", "AGENTS.md"), []byte("Host instructions\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	init := testInitialize(home, workspace, conversation, policyapi.ProviderCodex)
	init.Policy.Prompt = "Profile instructions"
	init.Policy.Tools.Mcp = map[string]policyapi.MCPServerPolicy{"keep": {Decision: policyapi.PolicyAllow}}
	seedDir := filepath.Join(conversation, "seed")
	if err := os.Mkdir(seedDir, 0o700); err != nil {
		t.Fatal(err)
	}
	binds, _, err := providerSeeds(init, sandbox.AgentTypeCodex, seedDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(binds) != 3 {
		t.Fatalf("bind count = %d, want 3", len(binds))
	}
	config := string(readFile(filepath.Join(seedDir, "codex-config.toml")))
	if !strings.Contains(config, "[mcp_servers.keep]") || strings.Contains(config, "mcp_servers.drop") || strings.Contains(config, "mcp_servers.hydra") {
		t.Fatalf("filtered Codex config:\n%s", config)
	}
	instructions := string(readFile(filepath.Join(seedDir, "codex-AGENTS.md")))
	if instructions != "Profile instructions\n\nHost instructions\n" {
		t.Fatalf("combined instructions = %q", instructions)
	}
}

func TestProviderCowMountsArePrivateAndWorkspaceScoped(t *testing.T) {
	workspace, conversation := t.TempDir(), t.TempDir()
	target := filepath.Join(workspace, "cache")
	if err := os.Mkdir(target, 0o700); err != nil {
		t.Fatal(err)
	}
	init := testInitialize(t.TempDir(), workspace, conversation, policyapi.ProviderCodex)
	init.Policy.Filesystem.CopyOnWrite = []string{target}
	mounts, err := providerCowMounts(init, filepath.Join(conversation, "private"))
	if err != nil {
		t.Fatal(err)
	}
	if len(mounts) != 1 || mounts[0].Lower != target || mounts[0].Dest != target {
		t.Fatalf("COW mounts = %+v", mounts)
	}
	if !pathCovered(mounts[0].Upper, []string{filepath.Join(conversation, "private")}) {
		t.Fatalf("COW upper is outside private conversation state: %s", mounts[0].Upper)
	}

	init.Policy.Filesystem.CopyOnWrite = []string{t.TempDir()}
	if _, err := providerCowMounts(init, filepath.Join(conversation, "private")); err == nil {
		t.Fatal("accepted copy_on_write path outside workspace")
	}
}

func TestProviderStateDoesNotCreateMissingHostPaths(t *testing.T) {
	home, privateDir := t.TempDir(), t.TempDir()
	writable, binds, err := providerState(home, privateDir, sandbox.AgentTypeClaude)
	if err != nil {
		t.Fatal(err)
	}
	if len(writable) != 0 || len(binds) != 2 {
		t.Fatalf("provider state writable = %v, binds = %+v", writable, binds)
	}
	for _, target := range []string{filepath.Join(home, ".claude"), filepath.Join(home, ".claude.json")} {
		if _, err := os.Lstat(target); !os.IsNotExist(err) {
			t.Fatalf("missing host provider path was created: %s", target)
		}
	}
	if info, err := os.Stat(binds[0].Source); err != nil || !info.IsDir() {
		t.Fatalf("private provider directory = %+v, %v", info, err)
	}
	if info, err := os.Stat(binds[1].Source); err != nil || !info.Mode().IsRegular() {
		t.Fatalf("private provider registry = %+v, %v", info, err)
	}
}

func TestPersistClaudeSessionID(t *testing.T) {
	dir := t.TempDir()
	persistClaudeSessionID(dir, []byte(`{"type":"system","subtype":"init","session_id":"claude-session"}`))
	data, err := os.ReadFile(filepath.Join(dir, "provider.json"))
	if err != nil {
		t.Fatal(err)
	}
	var stored struct {
		Sessions map[string]string `json:"sessions"`
	}
	if err := json.Unmarshal(data, &stored); err != nil || stored.Sessions["claude"] != "claude-session" {
		t.Fatalf("provider metadata = %s, err = %v", data, err)
	}
}

func testInitialize(home, workspace, conversation string, provider policyapi.ProviderKind) agenthostapi.InitializeCommand {
	return agenthostapi.InitializeCommand{
		Workspace: workspace, ConversationDir: conversation,
		Policy: policyapi.EffectivePolicy{
			Profile: "test", Provider: provider, Workspace: workspace, UserHome: home,
			Filesystem: policyapi.EffectiveFilesystemPolicy{Readable: []string{workspace}, Writable: []string{workspace}, CopyOnWrite: []string{}, Masked: []string{}},
			Network:    policyapi.EffectiveNetworkPolicy{Mode: policyapi.NetworkOff, AllowedHosts: []string{}, BlockedHosts: []string{}},
			Tools:      policyapi.ToolPolicy{}, Git: policyapi.GitPolicy{},
		},
	}
}
