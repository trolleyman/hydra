package heads

import (
	"encoding/json"
	"os"
	"path"
	"path/filepath"
	"strings"
	"testing"

	toml "github.com/pelletier/go-toml/v2"
	"github.com/trolleyman/hydra/internal/gate"
	"github.com/trolleyman/hydra/internal/sandbox"
)

// seedClaudeHead seeds one Claude head under projectRoot and returns its result.
func seedClaudeHead(t *testing.T, projectRoot, home, id string, policy gate.Policy) *seedResult {
	t.Helper()
	worktree := filepath.Join(projectRoot, "wt", id)
	if err := os.MkdirAll(worktree, 0o755); err != nil {
		t.Fatal(err)
	}
	res, err := seedHead(projectRoot, id, sandbox.AgentTypeClaude, worktree, home, "", policy, sandbox.GitIsolationOff)
	if err != nil {
		t.Fatalf("seedHead(%s): %v", id, err)
	}
	return res
}

// bindSource returns the source of the bind landing on target, or fails.
func bindSource(t *testing.T, res *seedResult, target string) string {
	t.Helper()
	for _, b := range res.Binds {
		if b.Target == target {
			return b.Source
		}
	}
	t.Fatalf("no bind for %s in %+v", target, res.Binds)
	return ""
}

// TestSeedHeadClaudeConfigIsPerHead pins two properties of the seeded
// ~/.claude.json: it declares the Hydra control server (the file half of the
// belt-and-braces with AgentArgv's --mcp-config), and it is per-head. It used to
// be one file for the whole project, which every spawn and resume rewrote from
// scratch - so one head's launch truncated the very file its siblings' sandboxes
// were reading through this bind.
func TestSeedHeadClaudeConfigIsPerHead(t *testing.T) {
	projectRoot, home := t.TempDir(), t.TempDir()
	target := path.Join(home, ".claude.json")

	first := bindSource(t, seedClaudeHead(t, projectRoot, home, "head-one", gate.Policy{}), target)
	second := bindSource(t, seedClaudeHead(t, projectRoot, home, "head-two", gate.Policy{}), target)
	if first == second {
		t.Errorf("both heads seeded the same config file %q; it must be per-head", first)
	}
	for _, p := range []string{first, second} {
		if srv := readMCPServer(t, p, gate.HydraControlServer); srv["command"] != SandboxHydraBinPath {
			t.Errorf("%s: control server = %+v, want command %q", p, srv, SandboxHydraBinPath)
		}
	}
}

func TestSeedHeadAgentCollaborationEnv(t *testing.T) {
	root, home := t.TempDir(), t.TempDir()
	seeded := seedClaudeHead(t, root, home, "agent", gate.Policy{})
	contains := func(env []string, want string) bool {
		for _, value := range env {
			if value == want || strings.HasPrefix(value, want+"=") {
				return true
			}
		}
		return false
	}
	if !contains(seeded.Env, "HYDRA_AGENT_REQ_DIR") {
		t.Fatal("collaboration channel was not seeded")
	}
	if contains(seeded.Env, "HYDRA_AGENT_MESSAGING") {
		t.Fatal("launch-time messaging policy was seeded")
	}
}

// TestSeedHeadStrictMCPConfig covers the strict-mode seed: a per-head config
// rendered from the allow-list, bound READ-ONLY under the head's own /tmp (not
// over a host-owned path, whose bind the host can detach), and handed to
// AgentArgv so the launch can pass --strict-mcp-config.
func TestSeedHeadStrictMCPConfig(t *testing.T) {
	projectRoot, home := t.TempDir(), t.TempDir()

	off := seedClaudeHead(t, projectRoot, home, "lenient", gate.Policy{})
	if off.MCPConfigPath != "" {
		t.Errorf("non-strict policy set MCPConfigPath = %q, want empty", off.MCPConfigPath)
	}

	res := seedClaudeHead(t, projectRoot, home, "strict-head", gate.Policy{StrictMCP: true})
	if res.MCPConfigPath != strictMCPConfigSandboxPath {
		t.Fatalf("MCPConfigPath = %q, want %q", res.MCPConfigPath, strictMCPConfigSandboxPath)
	}
	var bind *sandbox.Bind
	for i, b := range res.Binds {
		if b.Target == strictMCPConfigSandboxPath {
			bind = &res.Binds[i]
		}
	}
	if bind == nil {
		t.Fatalf("no bind for %s in %+v", strictMCPConfigSandboxPath, res.Binds)
	}
	if !bind.ReadOnly {
		t.Errorf("strict MCP config is bound writable; the agent must not be able to grant itself a server")
	}
	if want := filepath.Join(projectRoot, ".hydra", "local", "cache", "strict-head-mcp-config.json"); bind.Source != want {
		t.Errorf("bind source = %q, want the per-head %q", bind.Source, want)
	}
	if srv := readMCPServer(t, bind.Source, gate.HydraControlServer); srv["command"] != SandboxHydraBinPath {
		t.Errorf("control server = %+v, want command %q", srv, SandboxHydraBinPath)
	}
}

func TestSeedHeadCodexGateAndFilteredMCP(t *testing.T) {
	projectRoot, home := t.TempDir(), t.TempDir()
	worktree := filepath.Join(projectRoot, "wt", "codex-head")
	if err := os.MkdirAll(filepath.Join(home, ".codex"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(worktree, 0o755); err != nil {
		t.Fatal(err)
	}
	hostConfig := []byte(`
[mcp_servers.keep]
command = "keep"
[mcp_servers.drop]
command = "drop"
`)
	if err := os.WriteFile(filepath.Join(home, ".codex", "config.toml"), hostConfig, 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := seedHead(projectRoot, "codex-head", sandbox.AgentTypeCodex, worktree, home, "", gate.Policy{
		GateEnabled: true,
		MCPAllowed:  []string{"keep"},
	}, sandbox.GitIsolationReadonly)
	if err != nil {
		t.Fatal(err)
	}

	configTarget := path.Join(home, ".codex", "config.toml")
	configSource := bindSource(t, res, configTarget)
	var cfg map[string]any
	data, err := os.ReadFile(configSource)
	if err != nil {
		t.Fatal(err)
	}
	if err := toml.Unmarshal(data, &cfg); err != nil {
		t.Fatal(err)
	}
	servers, _ := cfg["mcp_servers"].(map[string]any)
	if servers["keep"] == nil || servers["hydra"] == nil || servers["drop"] != nil {
		t.Fatalf("filtered Codex servers = %#v", servers)
	}

	hooksSource := bindSource(t, res, path.Join(home, ".codex", "hooks.json"))
	hooks, err := os.ReadFile(hooksSource)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(hooks), "gate codex") {
		t.Fatalf("Codex gate missing from hooks: %s", hooks)
	}
	if bind := bindForTarget(res, configTarget); bind == nil || !bind.ReadOnly {
		t.Fatalf("Codex config bind must be read-only: %+v", bind)
	}
	if bind := bindForTarget(res, path.Join(home, ".codex", "hooks.json")); bind == nil || !bind.ReadOnly {
		t.Fatalf("Codex hooks bind must be read-only: %+v", bind)
	}
	if !envHasPrefix(res.Env, gate.EnvPolicyPath+"=") || !envHasPrefix(res.Env, gate.EnvApprovalDir+"=") {
		t.Fatalf("Codex gate environment missing: %v", res.Env)
	}
}

func TestSeededInstructionFilesArePerSession(t *testing.T) {
	projectRoot, home := t.TempDir(), t.TempDir()
	for _, dir := range []string{".codex", ".copilot", ".gemini"} {
		if err := os.MkdirAll(filepath.Join(home, dir), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	// Force Gemini onto its context-file fallback instead of probing a host CLI.
	t.Setenv("PATH", "")
	tests := []struct {
		name      string
		agentType sandbox.AgentType
		target    string
	}{
		{"codex", sandbox.AgentTypeCodex, path.Join(home, ".codex", "AGENTS.md")},
		{"copilot", sandbox.AgentTypeCopilot, path.Join(home, ".copilot", "copilot-instructions.md")},
		{"gemini", sandbox.AgentTypeGemini, path.Join(home, ".gemini", "GEMINI.md")},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			seed := func(id, prompt string) *seedResult {
				worktree := filepath.Join(projectRoot, "wt", id)
				if err := os.MkdirAll(worktree, 0o755); err != nil {
					t.Fatal(err)
				}
				res, err := seedHead(projectRoot, id, tt.agentType, worktree, home, prompt, gate.Policy{}, sandbox.GitIsolationOff)
				if err != nil {
					t.Fatalf("seedHead(%s): %v", id, err)
				}
				return res
			}

			headSource := bindSource(t, seed("head", "author instructions"), tt.target)
			reviewSource := bindSource(t, seed(ReviewSessionID("head"), reviewSystemPrompt), tt.target)
			if headSource == reviewSource {
				t.Fatalf("head and review slot share instruction source %q", headSource)
			}
			headData, err := os.ReadFile(headSource)
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(string(headData), "author instructions") || strings.Contains(string(headData), reviewSystemPrompt) {
				t.Fatalf("head instructions were clobbered by reviewer: %s", headData)
			}
		})
	}
}

func bindForTarget(res *seedResult, target string) *sandbox.Bind {
	for i := range res.Binds {
		if res.Binds[i].Target == target {
			return &res.Binds[i]
		}
	}
	return nil
}

func envHasPrefix(env []string, prefix string) bool {
	for _, entry := range env {
		if strings.HasPrefix(entry, prefix) {
			return true
		}
	}
	return false
}

// readMCPServer reads one server's definition out of an mcpServers document.
func readMCPServer(t *testing.T, path, name string) map[string]any {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var cfg struct {
		MCPServers map[string]map[string]any `json:"mcpServers"`
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		t.Fatalf("unmarshal %s: %v", path, err)
	}
	srv, ok := cfg.MCPServers[name]
	if !ok {
		t.Fatalf("%s: no %q server in %v", path, name, cfg.MCPServers)
	}
	return srv
}
