package config

import (
	"strings"
	"testing"
)

func TestInheritedEnvRoundTripAndResolve(t *testing.T) {
	cfg := Config{
		Defaults: AgentConfig{Sandbox: &SandboxConfig{InheritEnv: []string{"ANDROID_HOME"}}},
		Agents: map[string]AgentConfig{
			"claude": {Sandbox: &SandboxConfig{InheritEnv: []string{"SSH_AUTH_SOCK"}}},
		},
	}
	rendered := renderConfig(nil, cfg)
	if !strings.Contains(rendered, `inherit_env = ["ANDROID_HOME"]`) || !strings.Contains(rendered, `inherit_env = ["SSH_AUTH_SOCK"]`) {
		t.Fatalf("rendered config missing inherit_env:\n%s", rendered)
	}
	parsed, err := decodeConfig([]byte(rendered))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	got := parsed.ResolveInheritedEnv("claude")
	if strings.Join(got, ",") != "ANDROID_HOME,SSH_AUTH_SOCK" {
		t.Fatalf("resolved inherit_env = %v", got)
	}
}

func TestInheritedEnvRejectsInvalidAndManagedNames(t *testing.T) {
	for _, name := range []string{"", "1TOKEN", "BAD-NAME", "HYDRA_STATE_DIR", "HOME", "HTTP_PROXY", "CODEX_HOME"} {
		t.Run(name, func(t *testing.T) {
			if err := ValidateInheritedEnvName(name); err == nil {
				t.Fatalf("ValidateInheritedEnvName(%q) succeeded", name)
			}
		})
	}
	for _, name := range []string{"ANDROID_HOME", "SSH_AUTH_SOCK", "PRIVATE_REGISTRY_TOKEN"} {
		if err := ValidateInheritedEnvName(name); err != nil {
			t.Errorf("ValidateInheritedEnvName(%q): %v", name, err)
		}
	}

	_, err := decodeConfig([]byte("[sandbox]\ninherit_env = [\"HYDRA_STATE_DIR\"]\n"))
	if err == nil || !strings.Contains(err.Error(), "managed by Hydra") {
		t.Fatalf("decode reserved inherit_env error = %v", err)
	}
}
