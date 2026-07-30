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
