package heads

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/gate"
	"github.com/trolleyman/hydra/internal/paths"
	"github.com/trolleyman/hydra/internal/sandbox"
)

func TestLocalSeedUsesHostPathsWithoutChangingUserConfig(t *testing.T) {
	for _, provider := range []sandbox.AgentType{sandbox.AgentTypeClaude, sandbox.AgentTypeCodex} {
		t.Run(string(provider), func(t *testing.T) {
			project, home := t.TempDir(), t.TempDir()
			t.Setenv("CLAUDE_CONFIG_DIR", "")
			t.Setenv("CODEX_HOME", "")
			worktree := filepath.Join(project, "wt")
			if err := os.MkdirAll(worktree, 0o700); err != nil {
				t.Fatal(err)
			}
			userConfig := filepath.Join(home, ".claude.json")
			original := []byte(`{"custom":"user setting"}`)
			if err := os.WriteFile(userConfig, original, 0o600); err != nil {
				t.Fatal(err)
			}
			res, err := seedHead(project, "local-head", provider, worktree, home, "local instructions", gate.Policy{}, sandbox.GitIsolationOff, true)
			if err != nil {
				t.Fatal(err)
			}
			if len(res.Binds) != 0 || len(res.ROOverlays) != 0 {
				t.Fatalf("local seed requires mounts: %+v", res)
			}
			if _, err := os.Stat(res.HydraBinPath); err != nil {
				t.Fatalf("hook binary: %v", err)
			}
			for _, env := range res.Env {
				_, value, _ := strings.Cut(env, "=")
				if strings.HasPrefix(value, "/tmp/hydra-") {
					t.Fatalf("sandbox-only path: %s", env)
				}
			}
			providerDir := filepath.Join(paths.GetProviderStateDirFromProjectRoot(project, "local-head"), string(provider))
			configName := "settings.json"
			if provider == sandbox.AgentTypeCodex {
				configName = "config.toml"
			}
			if _, err := os.Stat(filepath.Join(providerDir, configName)); err != nil {
				t.Fatalf("private provider config: %v", err)
			}
			after, err := os.ReadFile(userConfig)
			if err != nil || string(after) != string(original) {
				t.Fatalf("user config changed: %s (%v)", after, err)
			}
			// Resume must reuse private provider state and preserve authentication.
			if _, err := seedHead(project, "local-head", provider, worktree, home, "local instructions", gate.Policy{}, sandbox.GitIsolationOff, true); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestLocalExecutionPrompt(t *testing.T) {
	prompt := config.DefaultPrePrompt + "\nProject instructions stay here."
	got := localExecutionPrompt(prompt, true)
	if strings.Contains(got, "locked-down OS sandbox") || strings.Contains(got, "## Sandbox rules") || strings.Contains(got, "<run-mode>") {
		t.Fatalf("sandbox instructions remain: %s", got)
	}
	if !strings.Contains(got, "Project instructions stay here.") || !strings.Contains(got, "## Workflow") || !strings.Contains(got, config.RunModeLine(true)) {
		t.Fatal("lost project, workflow, or run-mode instructions")
	}
	if EffectiveGitIsolation(Head{Local: true, GitIsolation: "readonly"}) != sandbox.GitIsolationOff {
		t.Fatal("local heads must report Git isolation off")
	}
}

func TestLocalComposerCommand(t *testing.T) {
	root := t.TempDir()
	result, err := RunShellCommand(context.Background(), root, root, "local-command", sandbox.AgentTypeCodex, ShellCommandPolicy{Local: true}, "printf local-command", nil)
	if err != nil {
		t.Fatal(err)
	}
	if result.ExitCode != 0 || result.Output != "local-command" {
		t.Fatalf("local command: %+v", result)
	}
}
