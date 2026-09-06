package sandbox

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/trolleyman/hydra/internal/gate"
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

func TestBuildStandaloneClaudeSettingsContainsOnlyGateHook(t *testing.T) {
	data, err := BuildStandaloneClaudeSettings("/tmp/hydra-agent-host", []string{"github"})
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	if !strings.Contains(text, "gate claude") || strings.Contains(text, "trigger-hook") || strings.Contains(text, "SessionStart") {
		t.Fatalf("standalone Claude settings:\n%s", data)
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
	data, err := BuildClaudeConfig(existing, "/work/tree", []string{"github", "playwright"}, "/usr/bin/hydra", "claude")
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
	if _, ok := top["hydra"]; !ok {
		t.Error("hydra control server should always be injected")
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
	// No hydra injection (empty hydraBin) so this isolates the stripping behaviour.
	data, err := BuildClaudeConfig(existing, "/work/tree", nil, "", "")
	if err != nil {
		t.Fatal(err)
	}
	var cfg map[string]any
	_ = json.Unmarshal(data, &cfg)
	if servers, ok := cfg["mcpServers"].(map[string]any); ok && len(servers) != 0 {
		t.Errorf("empty allow-list should strip every server, got %v", servers)
	}
}

func TestBuildClaudeConfigInjectsHydraServer(t *testing.T) {
	// Even with no existing servers and an empty allow-list, the hydra control
	// server is injected with the mcp subcommand for the agent type.
	data, err := BuildClaudeConfig(nil, "/work/tree", nil, "/usr/bin/hydra", "claude")
	if err != nil {
		t.Fatal(err)
	}
	var cfg map[string]any
	if err := json.Unmarshal(data, &cfg); err != nil {
		t.Fatal(err)
	}
	hydra, ok := cfg["mcpServers"].(map[string]any)["hydra"].(map[string]any)
	if !ok {
		t.Fatalf("hydra server not injected: %v", cfg["mcpServers"])
	}
	if hydra["command"] != "/usr/bin/hydra" {
		t.Errorf("hydra command = %v, want /usr/bin/hydra", hydra["command"])
	}
	args, _ := hydra["args"].([]any)
	if len(args) != 2 || args[0] != "mcp" || args[1] != "claude" {
		t.Errorf("hydra args = %v, want [mcp claude]", args)
	}
}

func TestListMCPServers(t *testing.T) {
	claude := []byte(`{
	  "mcpServers": {"github": {"command": "gh-mcp"}, "linear": {"command": "x"}},
	  "projects": {"/some/proj": {"mcpServers": {"playwright": {"command": "p"}, "github": {"command": "y"}}}}
	}`)
	mcp := []byte(`{"mcpServers": {"sentry": {"command": "s"}, "playwright": {"command": "z"}}}`)

	got := ListMCPServers(claude, mcp)
	// Expect de-duplicated, name-sorted: github(user), linear(user),
	// playwright(project), sentry(project).
	want := []MCPServer{
		{Name: "github", Source: "user"},
		{Name: "linear", Source: "user"},
		{Name: "playwright", Source: "project"},
		{Name: "sentry", Source: "project"},
	}
	if len(got) != len(want) {
		t.Fatalf("got %d servers %+v, want %d", len(got), got, len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("server[%d] = %+v, want %+v", i, got[i], want[i])
		}
	}
}

func TestListMCPServersMalformed(t *testing.T) {
	if got := ListMCPServers([]byte("not json"), nil); len(got) != 0 {
		t.Errorf("malformed claude.json should yield no servers, got %+v", got)
	}
	if got := ListMCPServers(nil, nil); len(got) != 0 {
		t.Errorf("nil inputs should yield no servers, got %+v", got)
	}
}

func TestMCPServerSpecs(t *testing.T) {
	claude := []byte(`{
	  "mcpServers": {
	    "github": {"command": "gh-mcp", "args": ["--stdio"], "env": {"TOKEN": "x"}},
	    "remote": {"type": "http", "url": "https://example.com"}
	  }
	}`)
	specs := MCPServerSpecs(claude, nil, []string{"github", "remote", "absent"})
	if len(specs) != 1 {
		t.Fatalf("got %d specs, want 1 (stdio only): %+v", len(specs), specs)
	}
	s := specs[0]
	if s.Name != "github" || s.Command != "gh-mcp" || len(s.Args) != 1 || s.Args[0] != "--stdio" {
		t.Errorf("unexpected spec: %+v", s)
	}
	if s.Env["TOKEN"] != "x" {
		t.Errorf("env not captured: %+v", s.Env)
	}
}

// TestBuildStrictMCPConfig covers the config strict mode launches with: the
// allow-listed servers, copied verbatim so transports MCPServerSpecs can't
// render (http/sse) survive, plus the control server, and nothing else.
func TestBuildStrictMCPConfig(t *testing.T) {
	claude := []byte(`{
	  "mcpServers": {
	    "github": {"command": "gh-mcp", "args": ["--stdio"], "env": {"TOKEN": "x"}},
	    "remote": {"type": "http", "url": "https://example.com", "headers": {"X-Key": "secret"}},
	    "notallowed": {"command": "nope"}
	  },
	  "projects": {
	    "/some/worktree": {"mcpServers": {"perproject": {"command": "pp"}}}
	  }
	}`)
	mcpJSON := []byte(`{"mcpServers": {"sentry": {"command": "sentry-mcp"}}}`)

	data, err := BuildStrictMCPConfig(claude, mcpJSON, []string{"github", "remote", "perproject", "sentry"}, "/tmp/hydra-internal", "claude")
	if err != nil {
		t.Fatal(err)
	}
	var cfg struct {
		MCPServers map[string]map[string]any `json:"mcpServers"`
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		t.Fatalf("output is not JSON: %v", err)
	}

	for _, name := range []string{"github", "remote", "perproject", "sentry", gate.HydraControlServer} {
		if _, ok := cfg.MCPServers[name]; !ok {
			t.Errorf("%q missing from strict config %s", name, data)
		}
	}
	if _, ok := cfg.MCPServers["notallowed"]; ok {
		t.Errorf("non-allow-listed server survived: %s", data)
	}
	// The remote server is the case this exists for: no command to re-derive, so
	// it has to come through as it was written, headers and all.
	remote := cfg.MCPServers["remote"]
	if remote["url"] != "https://example.com" || remote["type"] != "http" {
		t.Errorf("remote server not copied verbatim: %+v", remote)
	}
	if hdrs, _ := remote["headers"].(map[string]any); hdrs["X-Key"] != "secret" {
		t.Errorf("remote headers lost: %+v", remote)
	}
	if hydra := cfg.MCPServers[gate.HydraControlServer]; hydra["command"] != "/tmp/hydra-internal" {
		t.Errorf("control server = %+v, want command /tmp/hydra-internal", hydra)
	}
}

func TestBuildStrictMCPConfigCanOmitHydraControlServer(t *testing.T) {
	data, err := BuildStrictMCPConfig([]byte(`{"mcpServers":{"github":{"command":"gh"}}}`), nil, []string{"github"}, "", "claude")
	if err != nil {
		t.Fatal(err)
	}
	var config struct {
		Servers map[string]json.RawMessage `json:"mcpServers"`
	}
	if err := json.Unmarshal(data, &config); err != nil {
		t.Fatal(err)
	}
	if _, ok := config.Servers["github"]; !ok {
		t.Fatalf("filtered config omitted allowed server: %s", data)
	}
	if _, ok := config.Servers[gate.HydraControlServer]; ok {
		t.Fatalf("standalone config injected Hydra control server: %s", data)
	}
}

// TestBuildStrictMCPConfigDegrades: an unreadable source must not cost the head
// its control server - that would be the very failure this work is about.
func TestBuildStrictMCPConfigDegrades(t *testing.T) {
	for _, src := range [][]byte{nil, []byte("not json"), []byte(`{"mcpServers": null}`)} {
		data, err := BuildStrictMCPConfig(src, nil, []string{"github"}, "/tmp/hydra-internal", "claude")
		if err != nil {
			t.Fatalf("source %q: %v", src, err)
		}
		var cfg struct {
			MCPServers map[string]map[string]any `json:"mcpServers"`
		}
		if err := json.Unmarshal(data, &cfg); err != nil {
			t.Fatalf("source %q: output is not JSON: %v", src, err)
		}
		if len(cfg.MCPServers) != 1 || cfg.MCPServers[gate.HydraControlServer] == nil {
			t.Errorf("source %q: want only the control server, got %s", src, data)
		}
	}
}
