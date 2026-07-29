package heads

import (
	"encoding/json"
	"os"
	"path"
	"path/filepath"
	"testing"

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
