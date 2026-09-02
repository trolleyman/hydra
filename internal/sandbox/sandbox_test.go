package sandbox

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/trolleyman/hydra/internal/gate"
)

func TestNetworkModeSynonyms(t *testing.T) {
	// "on" is an accepted synonym that canonicalises to hard.
	if got := NormalizeNetworkMode("on"); got != NetHard {
		t.Errorf(`NormalizeNetworkMode("on") = %q, want %q`, got, NetHard)
	}
	// Canonical values and empty pass through unchanged.
	for _, m := range []NetworkMode{"", NetOff, NetUnrestricted, NetAdvisory, NetHard} {
		if got := NormalizeNetworkMode(string(m)); got != m {
			t.Errorf("NormalizeNetworkMode(%q) = %q, want %q", m, got, m)
		}
	}
	// Both canonical modes and the "on" synonym validate; junk does not.
	for _, ok := range []string{"", "off", "unrestricted", "advisory", "hard", "on"} {
		if !ValidNetworkMode(ok) {
			t.Errorf("ValidNetworkMode(%q) = false, want true", ok)
		}
	}
	if ValidNetworkMode("bogus") {
		t.Error(`ValidNetworkMode("bogus") = true, want false`)
	}
}

func TestGitIsolationMode(t *testing.T) {
	for _, ok := range []string{"", "off", "readonly"} {
		if !ValidGitIsolation(ok) {
			t.Errorf("ValidGitIsolation(%q) = false, want true", ok)
		}
	}
	for _, bad := range []string{"refs", "clone", "bogus"} {
		if ValidGitIsolation(bad) {
			t.Errorf("ValidGitIsolation(%q) = true, want false", bad)
		}
	}
	// Only readonly locks .git in the sandbox, so only it needs host-mediated commits.
	for m, want := range map[GitIsolationMode]bool{
		GitIsolationOff: false, GitIsolationReadonly: true,
	} {
		if got := m.HostMediatedCommit(); got != want {
			t.Errorf("%q.HostMediatedCommit() = %v, want %v", m, got, want)
		}
	}
}

func TestExpandPath(t *testing.T) {
	home := "/home/u"
	cases := map[string]string{
		"~":            "/home/u",
		"~/.ssh":       "/home/u/.ssh",
		"$HOME/.cache": "/home/u/.cache",
		"/tmp":         "/tmp",
		"":             "",
	}
	for in, want := range cases {
		if got := expandPath(in, home); got != want {
			t.Errorf("expandPath(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestRuntimeEnvUsesSandboxVisibleTempDir(t *testing.T) {
	hostTmp := filepath.Join(t.TempDir(), "head-tmp")
	got := RuntimeEnv([]string{
		"PATH=/usr/bin",
		"TMPDIR=/shared/one",
		"TMP=/shared/two",
		"TEMP=/shared/three",
		"TMPDIR=/duplicate",
		"GOCACHE=/shared/go-build",
		"GOMODCACHE=/shared/go-mod",
		"GOPATH=/shared/go",
		"GOBIN=/shared/go/bin",
		"XDG_CACHE_HOME=/shared/cache",
		"MISE_CACHE_DIR=/shared/mise-cache",
	}, hostTmp)
	wantTmp := SandboxTempDir(hostTmp)
	wants := map[string]string{
		"TMPDIR":         wantTmp,
		"TMP":            wantTmp,
		"TEMP":           wantTmp,
		"XDG_CACHE_HOME": filepath.Join(wantTmp, "cache"),
		"XDG_STATE_HOME": filepath.Join(wantTmp, "state"),
		"GOCACHE":        filepath.Join(wantTmp, "cache", "go-build"),
		"GOMODCACHE":     filepath.Join(wantTmp, "go", "pkg", "mod"),
		"GOPATH":         filepath.Join(wantTmp, "go"),
		"GOBIN":          filepath.Join(wantTmp, "go", "bin"),
		"MAGEFILE_CACHE": filepath.Join(wantTmp, "cache", "mage"),
		"MISE_CACHE_DIR": filepath.Join(wantTmp, "cache", "mise"),
		"MISE_STATE_DIR": filepath.Join(wantTmp, "state", "mise"),
	}
	for key, want := range wants {
		prefix := key + "="
		matches := make([]string, 0, 1)
		for _, entry := range got {
			if strings.HasPrefix(entry, prefix) {
				matches = append(matches, entry)
			}
		}
		if len(matches) != 1 || matches[0] != prefix+want {
			t.Errorf("%s entries = %v, want [%s]", key, matches, prefix+want)
		}
	}
	if !slices.Contains(got, "PATH=/usr/bin") {
		t.Errorf("RuntimeEnv dropped unrelated environment: %v", got)
	}
	if got := SandboxPreSpawnEnvFile(hostTmp); got != filepath.Join(wantTmp, PreSpawnEnvFileName) {
		t.Errorf("SandboxPreSpawnEnvFile() = %q, want %q", got, filepath.Join(wantTmp, PreSpawnEnvFileName))
	}
}

// claudeArgv is the fixed head of every Claude argv - the skip-permissions flag
// plus the inline --mcp-config that carries the Hydra control server - followed
// by whatever the case under test adds. The MCP flag is built rather than
// spelled out so these cases stay about the flags they are testing; its content
// is asserted on its own in TestAgentArgvCarriesHydraMCPServer.
func claudeArgv(extra ...string) []string {
	argv := append([]string{"claude", "--dangerously-skip-permissions"}, claudeMCPConfigArgs("claude")...)
	return append(argv, extra...)
}

func TestAgentArgv(t *testing.T) {
	cases := []struct {
		agent     AgentType
		resume    bool
		prompt    string
		sessionID string
		want      []string
	}{
		// Codex disables its own sandbox/approvals (it runs inside Hydra's
		// sandbox); the task is a positional argument and resume names the
		// persisted conversation explicitly when available.
		{AgentTypeCodex, false, "do a thing", "", []string{"codex", "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "do a thing"}},
		{AgentTypeCodex, false, "", "", []string{"codex", "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust"}},
		{AgentTypeCodex, true, "ignored on resume", "thread-123", []string{"codex", "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "resume", "thread-123"}},
		{AgentTypeCodex, true, "ignored on resume", "", []string{"codex", "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "resume", "--last"}},
	}
	for _, c := range cases {
		got, err := AgentArgv(c.agent, c.resume, "system prompt is ignored for codex", c.prompt, "", false, c.sessionID, "", "")
		if err != nil {
			t.Fatalf("AgentArgv(%q, resume=%v) error: %v", c.agent, c.resume, err)
		}
		if strings.Join(got, "\x00") != strings.Join(c.want, "\x00") {
			t.Errorf("AgentArgv(%q, resume=%v, prompt=%q) = %v, want %v", c.agent, c.resume, c.prompt, got, c.want)
		}
	}

	if _, err := AgentArgv(AgentType("nope"), false, "", "", "", false, "", "", ""); err == nil {
		t.Error("AgentArgv with unknown agent type: expected error, got nil")
	}
}

// TestAgentArgvChatAndResumeSession covers the chat-mode stream-json argv and
// the explicit --resume <id> resume path (which is what lets a head toggled
// from chat mode back to terminal mode restore its conversation - the TUI's
// --continue can't see -p-recorded sessions).
func TestAgentArgvChatAndResumeSession(t *testing.T) {
	chatFlags := []string{
		"-p", "--input-format", "stream-json", "--output-format", "stream-json",
		"--verbose", "--replay-user-messages", "--include-partial-messages",
		"--permission-prompt-tool", "stdio",
	}
	cases := []struct {
		name      string
		resume    bool
		chatMode  bool
		sessionID string
		want      []string
	}{
		{"chat fresh", false, true, "", claudeArgv(chatFlags...)},
		{"chat resume no id", true, true, "", append(claudeArgv(chatFlags...), "--continue")},
		{"chat resume with id", true, true, "abc-123", append(claudeArgv(chatFlags...), "--resume", "abc-123")},
		{"terminal resume with id", true, false, "abc-123", claudeArgv("--resume", "abc-123")},
		{"terminal resume no id", true, false, "", claudeArgv("--continue")},
		// The session id only matters on resume; a fresh spawn ignores it.
		{"fresh ignores id", false, false, "abc-123", claudeArgv()},
	}
	for _, c := range cases {
		got, err := AgentArgv(AgentTypeClaude, c.resume, "", "", "", c.chatMode, c.sessionID, "", "")
		if err != nil {
			t.Fatalf("%s: AgentArgv error: %v", c.name, err)
		}
		if strings.Join(got, "\x00") != strings.Join(c.want, "\x00") {
			t.Errorf("%s: AgentArgv = %v, want %v", c.name, got, c.want)
		}
	}

	if _, err := AgentArgv(AgentTypeGemini, false, "", "", "", true, "", "", ""); err == nil {
		t.Error("chat mode for gemini: expected error, got nil")
	}
}

// TestAgentArgvCarriesHydraMCPServer pins the fix for heads launching with no
// hydra tools at all: the control server must reach Claude through argv, not
// only through the seeded ~/.claude.json, because that file is a bind mount the
// host can drop by replacing the path (see claudeMCPConfigArgs).
func TestAgentArgvCarriesHydraMCPServer(t *testing.T) {
	for _, chatMode := range []bool{false, true} {
		for _, resume := range []bool{false, true} {
			argv, err := AgentArgv(AgentTypeClaude, resume, "sys", "task", "opus", chatMode, "sess-1", "", "")
			if err != nil {
				t.Fatalf("chat=%v resume=%v: %v", chatMode, resume, err)
			}
			i := slices.Index(argv, "--mcp-config")
			if i < 0 || i == len(argv)-1 {
				t.Fatalf("chat=%v resume=%v: no --mcp-config value in %q", chatMode, resume, argv)
			}
			// Variadic flag: whatever follows the value must be another flag (or
			// nothing), else Claude reads it as a second config path.
			if next := i + 2; next < len(argv) && !strings.HasPrefix(argv[next], "-") {
				t.Errorf("chat=%v resume=%v: --mcp-config value is followed by %q, which it would swallow", chatMode, resume, argv[next])
			}
			var cfg struct {
				MCPServers map[string]struct {
					Type    string   `json:"type"`
					Command string   `json:"command"`
					Args    []string `json:"args"`
				} `json:"mcpServers"`
			}
			if err := json.Unmarshal([]byte(argv[i+1]), &cfg); err != nil {
				t.Fatalf("chat=%v resume=%v: --mcp-config value is not JSON: %v", chatMode, resume, err)
			}
			srv, ok := cfg.MCPServers[gate.HydraControlServer]
			if !ok {
				t.Fatalf("chat=%v resume=%v: %q missing from %s", chatMode, resume, gate.HydraControlServer, argv[i+1])
			}
			if srv.Type != "stdio" || srv.Command != HydraBinPath || !slices.Equal(srv.Args, []string{"mcp", "claude"}) {
				t.Errorf("chat=%v resume=%v: server spec = %+v, want stdio %s mcp claude", chatMode, resume, srv, HydraBinPath)
			}
		}
	}

	// Strict mode swaps the inline server for the rendered config file, which
	// then supplies the control server too - so the inline JSON must be gone,
	// not doubled up.
	for _, chatMode := range []bool{false, true} {
		argv, err := AgentArgv(AgentTypeClaude, false, "sys", "task", "", chatMode, "", "/tmp/hydra-mcp-config.json", "")
		if err != nil {
			t.Fatalf("chat=%v: %v", chatMode, err)
		}
		i := slices.Index(argv, "--mcp-config")
		if i < 0 || argv[i+1] != "/tmp/hydra-mcp-config.json" {
			t.Fatalf("chat=%v: want --mcp-config /tmp/hydra-mcp-config.json, got %q", chatMode, argv)
		}
		if !slices.Contains(argv, "--strict-mcp-config") {
			t.Errorf("chat=%v: --strict-mcp-config missing from %q", chatMode, argv)
		}
		if strings.Contains(strings.Join(argv, " "), "mcpServers") {
			t.Errorf("chat=%v: inline server config still present alongside the strict file: %q", chatMode, argv)
		}
	}
	argv, err := AgentArgv(AgentTypeClaude, false, "", "", "", false, "", "/seed/mcp.json", "user")
	if err != nil || !slices.Contains(argv, "--setting-sources") || !slices.Contains(argv, "user") {
		t.Fatalf("Claude setting-source isolation argv = %q, %v", argv, err)
	}

	// Only Claude takes the flag; the others are configured by seeded files.
	for _, a := range []AgentType{AgentTypeGemini, AgentTypeCodex, AgentTypeBash} {
		argv, err := AgentArgv(a, false, "", "task", "", false, "", "", "")
		if err != nil {
			t.Fatalf("%s: %v", a, err)
		}
		if slices.Contains(argv, "--mcp-config") {
			t.Errorf("%s: unexpected --mcp-config in %q", a, argv)
		}
	}
}

func TestAgentArgvCodexChat(t *testing.T) {
	for _, resume := range []bool{false, true} {
		got, err := AgentArgv(AgentTypeCodex, resume, "", "ignored", "ignored", true, "", "", "")
		if err != nil {
			t.Fatal(err)
		}
		want := []string{"codex", "--dangerously-bypass-hook-trust", "--enable", "default_mode_request_user_input", "app-server", "--listen", "stdio://"}
		if !slices.Equal(got, want) {
			t.Fatalf("resume=%v: got %q, want %q", resume, got, want)
		}
	}
}

// TestAgentArgvModel verifies --model is passed on a fresh spawn but omitted on
// resume (so the agent restores its transcript's model / any /model change).
func TestAgentArgvModel(t *testing.T) {
	cases := []struct {
		agent  AgentType
		resume bool
		want   []string
	}{
		{AgentTypeClaude, false, claudeArgv("--model", "opus")},
		{AgentTypeClaude, true, claudeArgv("--continue")},
		{AgentTypeGemini, false, []string{"gemini", "--approval-mode=yolo", "--model", "opus"}},
		{AgentTypeGemini, true, []string{"gemini", "--approval-mode=yolo", "--resume", "latest"}},
		{AgentTypeCodex, false, []string{"codex", "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "--model", "opus"}},
		{AgentTypeCodex, true, []string{"codex", "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "resume", "--last"}},
	}
	for _, c := range cases {
		got, err := AgentArgv(c.agent, c.resume, "", "", "opus", false, "", "", "")
		if err != nil {
			t.Fatalf("AgentArgv(%q, resume=%v) error: %v", c.agent, c.resume, err)
		}
		if strings.Join(got, "\x00") != strings.Join(c.want, "\x00") {
			t.Errorf("AgentArgv(%q, resume=%v, model=opus) = %v, want %v", c.agent, c.resume, got, c.want)
		}
	}
}

func TestExpandAllDedupes(t *testing.T) {
	got := expandAll([]string{"~/.cache", "$HOME/.cache", "", "/tmp"}, "/home/u")
	want := []string{"/home/u/.cache", "/tmp"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("expandAll[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestEnsureWritableDir(t *testing.T) {
	home := t.TempDir()

	// A HOME-anchored path that does not exist yet is created (including parents).
	nested := filepath.Join(home, ".local", "share", "aube")
	ensureWritableDir(nested, home)
	if fi, err := os.Stat(nested); err != nil || !fi.IsDir() {
		t.Errorf("ensureWritableDir did not create HOME-anchored path %q: err=%v", nested, err)
	}

	// An existing path is left untouched (no error, still a dir).
	ensureWritableDir(nested, home)
	if fi, err := os.Stat(nested); err != nil || !fi.IsDir() {
		t.Errorf("ensureWritableDir disturbed existing path %q: err=%v", nested, err)
	}

	// A path OUTSIDE HOME is never created, so a config typo cannot litter the
	// wider filesystem.
	outside := filepath.Join(t.TempDir(), "not-under-home")
	ensureWritableDir(outside, home)
	if _, err := os.Stat(outside); !os.IsNotExist(err) {
		t.Errorf("ensureWritableDir created a non-HOME path %q (err=%v); want it left missing", outside, err)
	}

	// Empty inputs are no-ops (must not panic or create anything).
	ensureWritableDir("", home)
	ensureWritableDir(nested, "")
}
