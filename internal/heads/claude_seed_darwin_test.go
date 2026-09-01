//go:build darwin

package heads

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/trolleyman/hydra/internal/gate"
	"github.com/trolleyman/hydra/internal/paths"
	"github.com/trolleyman/hydra/internal/sandbox"
)

func TestSeedClaudeHeadUsesDarwinRedirectedStateAndImmutableInputs(t *testing.T) {
	projectRoot := t.TempDir()
	home := t.TempDir()
	hostConfigDir := filepath.Join(home, ".claude")
	worktree := filepath.Join(projectRoot, "worktree")
	for _, dir := range []string{hostConfigDir, worktree, filepath.Join(hostConfigDir, "skills")} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	if err := os.WriteFile(filepath.Join(hostConfigDir, ".credentials.json"), []byte("host-auth"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(hostConfigDir, "settings.json"), []byte(`{"model":"test-model"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(hostConfigDir, "CLAUDE.md"), []byte("host instructions\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".claude.json"), []byte(`{"theme":"dark"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	res, err := seedHead(projectRoot, "claude-head", sandbox.AgentTypeClaude, worktree, home, "hydra instructions", gate.Policy{GateEnabled: true}, sandbox.GitIsolationOff)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Binds) != 0 || len(res.ROOverlays) != 0 {
		t.Fatalf("Darwin Claude seed retained mount inputs: binds=%+v overlays=%+v", res.Binds, res.ROOverlays)
	}

	runtimeConfigDir := envValue(res.Env, "CLAUDE_CONFIG_DIR")
	wantDir := filepath.Join(paths.GetProviderStateDirFromProjectRoot(projectRoot, "claude-head"), "claude")
	if runtimeConfigDir != wantDir {
		t.Fatalf("CLAUDE_CONFIG_DIR = %q, want %q", runtimeConfigDir, wantDir)
	}
	if auth, err := os.ReadFile(filepath.Join(runtimeConfigDir, ".credentials.json")); err != nil || string(auth) != "host-auth" {
		t.Fatalf("per-head auth = %q, %v", auth, err)
	}
	if target, err := os.Readlink(filepath.Join(runtimeConfigDir, "skills")); err != nil || target != filepath.Join(hostConfigDir, "skills") {
		t.Fatalf("shared skills link = %q, %v", target, err)
	}
	if target, err := os.Readlink(filepath.Join(runtimeConfigDir, "CLAUDE.md")); err != nil || target != filepath.Join(hostConfigDir, "CLAUDE.md") {
		t.Fatalf("shared CLAUDE.md link = %q, %v", target, err)
	}

	settingsPath := filepath.Join(runtimeConfigDir, "settings.json")
	if !stringInSlice(res.ImmutablePaths, settingsPath) {
		t.Fatalf("generated Claude settings are not immutable: %v", res.ImmutablePaths)
	}
	var settings map[string]any
	settingsData, err := os.ReadFile(settingsPath)
	if err != nil || json.Unmarshal(settingsData, &settings) != nil || settings["model"] != "test-model" || settings["hooks"] == nil {
		t.Fatalf("generated settings = %s, %v", settingsData, err)
	}
	configPath := filepath.Join(runtimeConfigDir, ".claude.json")
	if stringInSlice(res.ImmutablePaths, configPath) {
		t.Fatalf("provider-owned .claude.json must remain writable: %v", res.ImmutablePaths)
	}
	if srv := readMCPServer(t, configPath, gate.HydraControlServer); srv["command"] != res.HydraBinPath {
		t.Errorf("control server = %+v, want command %q", srv, res.HydraBinPath)
	}
	if !strings.HasPrefix(res.MCPConfigPath, paths.GetSeedDirFromProjectRoot(projectRoot, "claude-head")+string(os.PathSeparator)) || !stringInSlice(res.ImmutablePaths, res.MCPConfigPath) {
		t.Fatalf("strict MCP config = %q, immutable=%v", res.MCPConfigPath, res.ImmutablePaths)
	}
	for _, key := range []string{gate.EnvPolicyPath, gate.EnvMCPCatalogPath} {
		value := envValue(res.Env, key)
		if !strings.HasPrefix(value, paths.GetSeedDirFromProjectRoot(projectRoot, "claude-head")+string(os.PathSeparator)) || !stringInSlice(res.ImmutablePaths, value) {
			t.Errorf("%s = %q, immutable=%v", key, value, res.ImmutablePaths)
		}
	}

	tmpDir := filepath.Join(paths.GetProjectStateDirFromProjectRoot(projectRoot), "tmp", "claude-head")
	if err := os.MkdirAll(tmpDir, 0o700); err != nil {
		t.Fatal(err)
	}
	spec, err := sandbox.BuildSpec(sandbox.Options{
		AgentType:      sandbox.AgentTypeClaude,
		WorktreePath:   worktree,
		Home:           home,
		TmpDir:         tmpDir,
		WritablePaths:  res.WritablePaths,
		ImmutablePaths: res.ImmutablePaths,
		Env:            res.Env,
		Argv:           []string{"/usr/bin/true"},
		HydraBinPath:   res.HydraBinPath,
	})
	if err != nil {
		t.Fatalf("BuildSpec with Darwin-native Claude seed: %v", err)
	}
	defer spec.Cleanup()
	profile, err := os.ReadFile(spec.Args[2])
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(profile), `(deny file-write* `+sandboxPathRuleForTest(settingsPath)+`)`) {
		t.Fatalf("Seatbelt profile does not protect generated Claude settings:\n%s", profile)
	}

	// Re-seeding preserves credentials Claude may have refreshed and atomically
	// replaces generated files instead of following a provider-created symlink.
	if err := os.WriteFile(filepath.Join(runtimeConfigDir, ".credentials.json"), []byte("refreshed"), 0o600); err != nil {
		t.Fatal(err)
	}
	victim := filepath.Join(home, "must-not-change")
	if err := os.WriteFile(victim, []byte("safe"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(settingsPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(victim, settingsPath); err != nil {
		t.Fatal(err)
	}
	if _, err := seedHead(projectRoot, "claude-head", sandbox.AgentTypeClaude, worktree, home, "hydra instructions", gate.Policy{GateEnabled: true}, sandbox.GitIsolationOff); err != nil {
		t.Fatal(err)
	}
	if auth, err := os.ReadFile(filepath.Join(runtimeConfigDir, ".credentials.json")); err != nil || string(auth) != "refreshed" {
		t.Fatalf("resume seed overwrote per-head auth: %q, %v", auth, err)
	}
	if data, err := os.ReadFile(victim); err != nil || string(data) != "safe" {
		t.Fatalf("resume followed a generated-settings symlink: %q, %v", data, err)
	}
}

func TestSeedClaudeHeadClonesLegacyTranscriptOnce(t *testing.T) {
	projectRoot := t.TempDir()
	home := t.TempDir()
	worktree := filepath.Join(projectRoot, "worktree")
	legacy := filepath.Join(home, ".claude", "projects", paths.ClaudeProjectsSlug(worktree))
	if err := os.MkdirAll(legacy, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(legacy, "old-session.jsonl"), []byte("old\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(worktree, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	if _, err := seedHead(projectRoot, "legacy", sandbox.AgentTypeClaude, worktree, home, "", gate.Policy{}, sandbox.GitIsolationOff); err != nil {
		t.Fatal(err)
	}
	target := paths.ClaudeProjectDirForSession(projectRoot, "legacy", home, worktree)
	if data, err := os.ReadFile(filepath.Join(target, "old-session.jsonl")); err != nil || string(data) != "old\n" {
		t.Fatalf("cloned transcript = %q, %v", data, err)
	}
	if err := os.WriteFile(filepath.Join(target, "new-session.jsonl"), []byte("new\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := seedHead(projectRoot, "legacy", sandbox.AgentTypeClaude, worktree, home, "", gate.Policy{}, sandbox.GitIsolationOff); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(filepath.Join(target, "new-session.jsonl")); err != nil || string(data) != "new\n" {
		t.Fatalf("resume replaced provider transcript: %q, %v", data, err)
	}
}
