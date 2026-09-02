package heads

import (
	"encoding/json"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"

	toml "github.com/pelletier/go-toml/v2"
	"github.com/trolleyman/hydra/internal/gate"
	"github.com/trolleyman/hydra/internal/paths"
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

	firstSeed := seedClaudeHead(t, projectRoot, home, "head-one", gate.Policy{})
	secondSeed := seedClaudeHead(t, projectRoot, home, "head-two", gate.Policy{})
	var first, second string
	if runtime.GOOS == "darwin" {
		first = filepath.Join(envValue(firstSeed.Env, "CLAUDE_CONFIG_DIR"), ".claude.json")
		second = filepath.Join(envValue(secondSeed.Env, "CLAUDE_CONFIG_DIR"), ".claude.json")
	} else {
		first = bindSource(t, firstSeed, target)
		second = bindSource(t, secondSeed, target)
	}
	if first == second {
		t.Errorf("both heads seeded the same config file %q; it must be per-head", first)
	}
	for i, p := range []string{first, second} {
		want := []*seedResult{firstSeed, secondSeed}[i].HydraBinPath
		if srv := readMCPServer(t, p, gate.HydraControlServer); srv["command"] != want {
			t.Errorf("%s: control server = %+v, want command %q", p, srv, want)
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
	if runtime.GOOS != "darwin" && off.MCPConfigPath != "" {
		t.Errorf("non-strict policy set MCPConfigPath = %q, want empty", off.MCPConfigPath)
	}

	res := seedClaudeHead(t, projectRoot, home, "strict-head", gate.Policy{StrictMCP: true})
	if runtime.GOOS == "darwin" {
		if !strings.HasPrefix(res.MCPConfigPath, paths.GetSeedDirFromProjectRoot(projectRoot, "strict-head")+string(os.PathSeparator)) {
			t.Fatalf("MCPConfigPath = %q, want native seed path", res.MCPConfigPath)
		}
		if !slices.Contains(res.ImmutablePaths, res.MCPConfigPath) {
			t.Fatalf("native strict MCP config is not immutable: %v", res.ImmutablePaths)
		}
		if srv := readMCPServer(t, res.MCPConfigPath, gate.HydraControlServer); srv["command"] != res.HydraBinPath {
			t.Errorf("control server = %+v, want command %q", srv, res.HydraBinPath)
		}
		return
	}
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
	if want := filepath.Join(paths.GetCacheDirFromProjectRoot(projectRoot), "strict-head-mcp-config.json"); bind.Source != want {
		t.Errorf("bind source = %q, want the per-head %q", bind.Source, want)
	}
	if srv := readMCPServer(t, bind.Source, gate.HydraControlServer); srv["command"] != res.HydraBinPath {
		t.Errorf("control server = %+v, want command %q", srv, res.HydraBinPath)
	}
}

func TestSeedHeadCodexGateAndFilteredMCP(t *testing.T) {
	projectRoot, home := t.TempDir(), t.TempDir()
	t.Setenv("CODEX_HOME", filepath.Join(home, ".codex"))
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
	configSource := deliveredCodexSource(t, res, configTarget)
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

	hooksTarget := path.Join(home, ".codex", "hooks.json")
	hooksSource := deliveredCodexSource(t, res, hooksTarget)
	hooks, err := os.ReadFile(hooksSource)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(hooks), "gate codex") {
		t.Fatalf("Codex gate missing from hooks: %s", hooks)
	}
	if !deliveredReadOnly(res, configTarget, configSource) {
		t.Fatalf("Codex config is not delivered read-only: target=%q source=%q", configTarget, configSource)
	}
	if !deliveredReadOnly(res, hooksTarget, hooksSource) {
		t.Fatalf("Codex hooks are not delivered read-only: target=%q source=%q", hooksTarget, hooksSource)
	}
	if !envHasPrefix(res.Env, gate.EnvPolicyPath+"=") || !envHasPrefix(res.Env, gate.EnvApprovalDir+"=") {
		t.Fatalf("Codex gate environment missing: %v", res.Env)
	}
}

func TestSeededInstructionFilesArePerSession(t *testing.T) {
	projectRoot, home := t.TempDir(), t.TempDir()
	t.Setenv("CODEX_HOME", filepath.Join(home, ".codex"))
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

			headSeed := seed("head", "author instructions")
			reviewSeed := seed(ReviewSessionID("head"), reviewSystemPrompt)
			var headSource, reviewSource string
			if tt.agentType == sandbox.AgentTypeCodex {
				headSource = deliveredCodexSource(t, headSeed, tt.target)
				reviewSource = deliveredCodexSource(t, reviewSeed, tt.target)
			} else {
				headSource = bindSource(t, headSeed, tt.target)
				reviewSource = bindSource(t, reviewSeed, tt.target)
			}
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

func deliveredCodexSource(t *testing.T, res *seedResult, target string) string {
	t.Helper()
	if bind := bindForTarget(res, target); bind != nil {
		return bind.Source
	}
	runtimeHome := envValue(res.Env, "CODEX_HOME")
	if runtimeHome == "" {
		t.Fatalf("Codex seed has neither a bind for %q nor CODEX_HOME: %+v", target, res)
	}
	return filepath.Join(runtimeHome, filepath.Base(target))
}

func deliveredReadOnly(res *seedResult, target, source string) bool {
	if bind := bindForTarget(res, target); bind != nil {
		return bind.ReadOnly
	}
	for _, immutable := range res.ImmutablePaths {
		if immutable == source {
			return true
		}
	}
	return false
}

func envValue(env []string, key string) string {
	prefix := key + "="
	for _, entry := range env {
		if strings.HasPrefix(entry, prefix) {
			return strings.TrimPrefix(entry, prefix)
		}
	}
	return ""
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
