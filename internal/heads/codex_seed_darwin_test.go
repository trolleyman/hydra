//go:build darwin

package heads

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/trolleyman/hydra/internal/gate"
	"github.com/trolleyman/hydra/internal/paths"
	"github.com/trolleyman/hydra/internal/sandbox"
)

func TestSeedCodexHeadUsesDarwinRedirectedHomeAndImmutableInputs(t *testing.T) {
	projectRoot := t.TempDir()
	home := t.TempDir()
	hostCodexHome := filepath.Join(home, ".codex")
	worktree := filepath.Join(projectRoot, "worktree")
	for _, dir := range []string{hostCodexHome, worktree, filepath.Join(hostCodexHome, "skills")} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("CODEX_HOME", hostCodexHome)
	if err := os.WriteFile(filepath.Join(hostCodexHome, "auth.json"), []byte("host-auth"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(hostCodexHome, "config.toml"), []byte("model = 'test-model'\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(hostCodexHome, "AGENTS.md"), []byte("host instructions\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	res, err := seedHead(projectRoot, "codex-head", sandbox.AgentTypeCodex, worktree, home, "hydra instructions", gate.Policy{GateEnabled: true}, sandbox.GitIsolationOff)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Binds) != 0 || len(res.ROOverlays) != 0 {
		t.Fatalf("Darwin Codex seed retained mount inputs: binds=%+v overlays=%+v", res.Binds, res.ROOverlays)
	}

	runtimeHome := envValue(res.Env, "CODEX_HOME")
	wantHome := filepath.Join(paths.GetProviderStateDirFromProjectRoot(projectRoot, "codex-head"), "codex")
	if runtimeHome != wantHome {
		t.Fatalf("CODEX_HOME = %q, want %q", runtimeHome, wantHome)
	}
	if auth, err := os.ReadFile(filepath.Join(runtimeHome, "auth.json")); err != nil || string(auth) != "host-auth" {
		t.Fatalf("per-head auth = %q, %v", auth, err)
	}
	if info, err := os.Stat(filepath.Join(runtimeHome, "auth.json")); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("per-head auth mode = %v, %v", info, err)
	}
	if target, err := os.Readlink(filepath.Join(runtimeHome, "skills")); err != nil || target != filepath.Join(hostCodexHome, "skills") {
		t.Fatalf("shared skills link = %q, %v", target, err)
	}

	for _, name := range []string{"AGENTS.md", "config.toml", "hooks.json"} {
		generated := filepath.Join(runtimeHome, name)
		if _, err := os.Stat(generated); err != nil {
			t.Fatalf("generated %s: %v", name, err)
		}
		if !stringInSlice(res.ImmutablePaths, generated) {
			t.Errorf("generated %s is not immutable: %v", name, res.ImmutablePaths)
		}
	}
	if !stringInSlice(res.ImmutablePaths, hostCodexHome) {
		t.Fatalf("shared host CODEX_HOME is not read-only: %v", res.ImmutablePaths)
	}
	seedDir := paths.GetSeedDirFromProjectRoot(projectRoot, "codex-head")
	for _, key := range []string{gate.EnvPolicyPath, gate.EnvMCPCatalogPath} {
		value := envValue(res.Env, key)
		if !strings.HasPrefix(value, seedDir+string(os.PathSeparator)) {
			t.Errorf("%s = %q, want a path under %q", key, value, seedDir)
		}
		if !stringInSlice(res.ImmutablePaths, value) {
			t.Errorf("%s path is not immutable: %v", key, res.ImmutablePaths)
		}
	}
	tmpDir := filepath.Join(paths.GetProjectStateDirFromProjectRoot(projectRoot), "tmp", "codex-head")
	if err := os.MkdirAll(tmpDir, 0o700); err != nil {
		t.Fatal(err)
	}
	spec, err := sandbox.BuildSpec(sandbox.Options{
		AgentType:      sandbox.AgentTypeCodex,
		WorktreePath:   worktree,
		Home:           home,
		TmpDir:         tmpDir,
		WritablePaths:  res.WritablePaths,
		ImmutablePaths: res.ImmutablePaths,
		Env:            res.Env,
		Argv:           []string{"/bin/true"},
		HydraBinPath:   res.HydraBinPath,
	})
	if err != nil {
		t.Fatalf("BuildSpec with Darwin-native Codex seed: %v", err)
	}
	defer spec.Cleanup()
	profile, err := os.ReadFile(spec.Args[2])
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(profile), `(deny file-write* `+sandboxPathRuleForTest(filepath.Join(runtimeHome, "config.toml"))+`)`) {
		t.Fatalf("Seatbelt profile does not protect generated Codex config:\n%s", profile)
	}

	// Re-seeding the same head must not overwrite auth state Codex may have
	// refreshed since its first launch.
	if err := os.WriteFile(filepath.Join(runtimeHome, "auth.json"), []byte("refreshed"), 0o600); err != nil {
		t.Fatal(err)
	}
	victim := filepath.Join(home, "must-not-change")
	if err := os.WriteFile(victim, []byte("safe"), 0o600); err != nil {
		t.Fatal(err)
	}
	generatedConfig := filepath.Join(runtimeHome, "config.toml")
	if err := os.Remove(generatedConfig); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(victim, generatedConfig); err != nil {
		t.Fatal(err)
	}
	if _, err := seedHead(projectRoot, "codex-head", sandbox.AgentTypeCodex, worktree, home, "hydra instructions", gate.Policy{GateEnabled: true}, sandbox.GitIsolationOff); err != nil {
		t.Fatal(err)
	}
	if auth, err := os.ReadFile(filepath.Join(runtimeHome, "auth.json")); err != nil || string(auth) != "refreshed" {
		t.Fatalf("resume seed overwrote per-head auth: %q, %v", auth, err)
	}
	if data, err := os.ReadFile(victim); err != nil || string(data) != "safe" {
		t.Fatalf("resume followed a generated-config symlink: %q, %v", data, err)
	}
	if info, err := os.Lstat(generatedConfig); err != nil || info.Mode()&os.ModeSymlink != 0 {
		t.Fatalf("generated config was not atomically restored: %v, %v", info, err)
	}
}

func sandboxPathRuleForTest(path string) string {
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		path = resolved
	}
	info, err := os.Stat(path)
	if err == nil && !info.IsDir() {
		return `(literal "` + path + `")`
	}
	return `(subpath "` + path + `")`
}

func stringInSlice(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func TestSeedCodexHeadRejectsMalformedRequiredConfigOnDarwin(t *testing.T) {
	projectRoot := t.TempDir()
	home := t.TempDir()
	hostCodexHome := filepath.Join(home, ".codex")
	worktree := filepath.Join(projectRoot, "worktree")
	for _, dir := range []string{hostCodexHome, worktree} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("CODEX_HOME", hostCodexHome)
	if err := os.WriteFile(filepath.Join(hostCodexHome, "config.toml"), []byte("this = [is invalid"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := seedHead(projectRoot, "bad-config", sandbox.AgentTypeCodex, worktree, home, "prompt", gate.Policy{}, sandbox.GitIsolationOff)
	if err == nil || !strings.Contains(err.Error(), "required macOS Codex config") {
		t.Fatalf("seedHead malformed config error = %v", err)
	}
}
