package heads

import (
	"testing"

	"github.com/trolleyman/hydra/internal/config"
)

// TestResolveGitIsolationDowngradesUnsupported checks that readonly (host-mediated)
// falls back to off for agents without the git tools, but is kept for those with.
func TestResolveGitIsolationDowngradesUnsupported(t *testing.T) {
	cfg := config.Config{}
	cases := []struct {
		agent    string
		override string
		want     string
	}{
		{"claude", "readonly", "readonly"},
		{"codex", "readonly", "readonly"},
		{"gemini", "readonly", "readonly"},
		{"copilot", "readonly", "off"}, // no git tools -> downgrade
		{"bash", "readonly", "off"},    // no git tools -> downgrade
		{"copilot", "off", "off"},
		{"claude", "", "readonly"}, // default when nothing set
		{"copilot", "", "off"},     // ...downgraded for an agent without the git tools
	}
	for _, c := range cases {
		if got := string(resolveGitIsolation(cfg, c.agent, c.override)); got != c.want {
			t.Errorf("resolveGitIsolation(%s, %q) = %q, want %q", c.agent, c.override, got, c.want)
		}
	}
}
