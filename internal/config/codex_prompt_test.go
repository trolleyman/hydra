package config

import (
	"strings"
	"testing"

	"github.com/trolleyman/hydra/internal/sandbox"
)

func TestCodexPrePromptRequestsBashDescriptions(t *testing.T) {
	codex := BuildFinalPrePrompt(Config{}, string(sandbox.AgentTypeCodex))
	if !strings.Contains(codex, "# Inspect the usage handlers") {
		t.Fatalf("Codex pre-prompt has no Bash description convention")
	}
	claude := BuildFinalPrePrompt(Config{}, string(sandbox.AgentTypeClaude))
	if strings.Contains(claude, "# Inspect the usage handlers") {
		t.Fatalf("Codex-only Bash description convention leaked into Claude's pre-prompt")
	}
}

// The persistent-shell rules describe Claude's Bash tool and lean on the
// Claude-only advice hook, so they must not reach an agent that has neither.
func TestShellCwdPrePromptIsClaudeOnly(t *testing.T) {
	const marker = "Shell cwd is now"
	claude := BuildFinalPrePrompt(Config{}, string(sandbox.AgentTypeClaude))
	if !strings.Contains(claude, marker) {
		t.Fatalf("Claude pre-prompt does not explain the persistent Bash shell's cwd")
	}
	for _, other := range []sandbox.AgentType{sandbox.AgentTypeCodex, sandbox.AgentTypeGemini} {
		if got := BuildFinalPrePrompt(Config{}, string(other)); strings.Contains(got, marker) {
			t.Fatalf("Claude-only shell cwd rules leaked into %s's pre-prompt", other)
		}
	}
}
