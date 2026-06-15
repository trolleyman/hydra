package config

import (
	"strings"
	"testing"

	"github.com/BurntSushi/toml"
)

func strPtr(s string) *string { return &s }

// TestPreSpawnScriptRoundTrip checks that a pre_spawn_script survives a
// marshal -> TOML -> parse round-trip and resolves for an agent.
func TestPreSpawnScriptRoundTrip(t *testing.T) {
	cfg := Config{
		Defaults: AgentConfig{
			Sandbox: &SandboxConfig{PreSpawnScript: strPtr("mise trust\necho ready")},
		},
	}

	tomlStr := marshalConfig(cfg)
	if !strings.Contains(tomlStr, "pre_spawn_script = ") {
		t.Fatalf("marshalled config missing pre_spawn_script:\n%s", tomlStr)
	}

	parsed := Config{}
	if _, err := toml.Decode(tomlStr, &parsed); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if parsed.Defaults.Sandbox == nil || parsed.Defaults.Sandbox.PreSpawnScript == nil {
		t.Fatalf("parsed config lost pre_spawn_script: %+v", parsed.Defaults.Sandbox)
	}
	if got := *parsed.Defaults.Sandbox.PreSpawnScript; got != "mise trust\necho ready" {
		t.Fatalf("round-tripped script mismatch: %q", got)
	}

	// ResolveSandboxOptions surfaces the default script for any agent type.
	_, _, _, _, preSpawn := parsed.ResolveSandboxOptions("claude")
	if preSpawn != "mise trust\necho ready" {
		t.Fatalf("resolved preSpawn mismatch: %q", preSpawn)
	}
}

// TestPreSpawnScriptAgentOverride checks per-agent override wins over defaults.
func TestPreSpawnScriptAgentOverride(t *testing.T) {
	cfg := Config{
		Defaults: AgentConfig{Sandbox: &SandboxConfig{PreSpawnScript: strPtr("default")}},
		Agents: map[string]AgentConfig{
			"claude": {Sandbox: &SandboxConfig{PreSpawnScript: strPtr("claude-only")}},
		},
	}
	if _, _, _, _, ps := cfg.ResolveSandboxOptions("claude"); ps != "claude-only" {
		t.Fatalf("claude override: got %q", ps)
	}
	if _, _, _, _, ps := cfg.ResolveSandboxOptions("gemini"); ps != "default" {
		t.Fatalf("gemini inherits default: got %q", ps)
	}
}
