package heads

import (
	"slices"
	"testing"

	"github.com/trolleyman/hydra/internal/sandbox"
)

func TestClaudeRenderingEnv(t *testing.T) {
	// Default (fullscreen off): force the classic renderer so the web terminal
	// keeps its native scrollbar + select-to-copy and skips the opt-in prompt.
	if got := claudeRenderingEnv(sandbox.AgentTypeClaude, false); !slices.Equal(got, []string{"CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1"}) {
		t.Errorf("claude/off env = %v", got)
	}
	// Opted in: enable fullscreen explicitly so the saved tui setting can't win.
	if got := claudeRenderingEnv(sandbox.AgentTypeClaude, true); !slices.Equal(got, []string{"CLAUDE_CODE_NO_FLICKER=1"}) {
		t.Errorf("claude/on env = %v", got)
	}
	// Non-Claude agents have no such mode and must get nothing either way.
	for _, at := range []sandbox.AgentType{sandbox.AgentTypeGemini, sandbox.AgentTypeCopilot, sandbox.AgentTypeCodex, sandbox.AgentTypeBash} {
		if got := claudeRenderingEnv(at, false); got != nil {
			t.Errorf("%s/off env = %v, want nil", at, got)
		}
		if got := claudeRenderingEnv(at, true); got != nil {
			t.Errorf("%s/on env = %v, want nil", at, got)
		}
	}
}
