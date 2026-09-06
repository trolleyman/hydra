//go:build linux

package heads

import (
	"path/filepath"
	"slices"
	"testing"
)

func TestLinuxProviderSeedLayoutsMakeCustomStateWritable(t *testing.T) {
	home := t.TempDir()

	codexHome := filepath.Join(t.TempDir(), "codex-home")
	t.Setenv("CODEX_HOME", codexHome)
	codex := &seedResult{}
	if _, err := prepareCodexSeedLayout("", t.TempDir(), "head", home, codex); err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(codex.WritablePaths, codexHome) {
		t.Fatalf("custom CODEX_HOME is not writable: %v", codex.WritablePaths)
	}

	claudeHome := filepath.Join(t.TempDir(), "claude-home")
	t.Setenv("CLAUDE_CONFIG_DIR", claudeHome)
	claude := &seedResult{}
	if _, err := prepareClaudeSeedLayout("", "", home, "", claude); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{claudeHome, filepath.Join(claudeHome, ".claude.json")} {
		if !slices.Contains(claude.WritablePaths, want) {
			t.Errorf("custom Claude state %q is not writable: %v", want, claude.WritablePaths)
		}
	}
}
