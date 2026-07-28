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

// TestSeedHeadClaudeConfigIsPerHead pins two properties of the seeded
// ~/.claude.json: it declares the Hydra control server (the file half of the
// belt-and-braces with AgentArgv's --mcp-config), and it is per-head. It used to
// be one file for the whole project, which every spawn and resume rewrote from
// scratch - so one head's launch truncated the very file its siblings' sandboxes
// were reading through this bind.
func TestSeedHeadClaudeConfigIsPerHead(t *testing.T) {
	projectRoot := t.TempDir()
	home := t.TempDir()

	seedOne := func(id string) *seedResult {
		t.Helper()
		worktree := filepath.Join(projectRoot, "wt", id)
		if err := os.MkdirAll(worktree, 0o755); err != nil {
			t.Fatal(err)
		}
		res, err := seedHead(projectRoot, id, sandbox.AgentTypeClaude, worktree, home, "", gate.Policy{}, sandbox.GitIsolationOff)
		if err != nil {
			t.Fatalf("seedHead(%s): %v", id, err)
		}
		return res
	}

	// The bind that puts the seeded config at ~/.claude.json inside the sandbox.
	configSource := func(res *seedResult) string {
		t.Helper()
		target := path.Join(home, ".claude.json")
		for _, b := range res.Binds {
			if b.Target == target {
				return b.Source
			}
		}
		t.Fatalf("no bind for %s in %+v", target, res.Binds)
		return ""
	}

	first, second := configSource(seedOne("head-one")), configSource(seedOne("head-two"))
	if first == second {
		t.Errorf("both heads seeded the same config file %q; it must be per-head", first)
	}
	for _, p := range []string{first, second} {
		data, err := os.ReadFile(p)
		if err != nil {
			t.Fatalf("read %s: %v", p, err)
		}
		var cfg struct {
			MCPServers map[string]struct {
				Command string   `json:"command"`
				Args    []string `json:"args"`
			} `json:"mcpServers"`
		}
		if err := json.Unmarshal(data, &cfg); err != nil {
			t.Fatalf("unmarshal %s: %v", p, err)
		}
		srv, ok := cfg.MCPServers[gate.HydraControlServer]
		if !ok {
			t.Fatalf("%s: no %q server in %v", p, gate.HydraControlServer, cfg.MCPServers)
		}
		if srv.Command != SandboxHydraBinPath {
			t.Errorf("%s: server command = %q, want %q", p, srv.Command, SandboxHydraBinPath)
		}
	}
}
