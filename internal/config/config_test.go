package config

import (
	"os"
	"path/filepath"
	"testing"
)

func ptr(s string) *string { return &s }

func TestMarshalConfig_MultiLineStrings(t *testing.T) {
	prePrompt := "You are an agent.\n- Do stuff\n- More stuff\n"

	cfg := Config{
		Defaults: AgentConfig{
			PrePrompt: ptr(prePrompt),
		},
	}

	out := marshalConfig(cfg)

	// Should contain triple-quoted strings
	if !contains(out, `"""`) {
		t.Errorf("expected triple-quoted strings in output, got:\n%s", out)
	}
	// Should not contain escaped newlines
	if contains(out, `\n`) {
		t.Errorf("expected no escaped newlines in output, got:\n%s", out)
	}
}

func TestMarshalConfig_NoIndentation(t *testing.T) {
	prePrompt := "You are an agent.\n- Do stuff\n"
	cfg := Config{
		Defaults: AgentConfig{PrePrompt: ptr(prePrompt)},
		Agents:   map[string]AgentConfig{"claude": {PrePrompt: ptr(prePrompt)}},
	}

	out := marshalConfig(cfg)

	for _, line := range splitLines(out) {
		if len(line) > 0 && (line[0] == ' ' || line[0] == '\t') {
			t.Errorf("unexpected indentation in line: %q\nfull output:\n%s", line, out)
		}
	}
}

func TestSaveLoadRoundTrip(t *testing.T) {
	prePrompt := "You are an agent.\n- Do stuff\n- More stuff\n"
	enabled := false

	cfg := Config{
		Defaults: AgentConfig{
			PrePrompt: ptr(prePrompt),
			Sandbox: &SandboxConfig{
				WritablePaths: []string{"~/.cache", "/tmp"},
				MaskedPaths:   []string{"~/.ssh"},
				RestoreRO:     []string{"~/.config/git"},
				Network:       &NetworkConfig{Enabled: &enabled, AllowedHosts: []string{"example.com"}},
			},
		},
		Agents: map[string]AgentConfig{
			"claude": {PrePrompt: ptr(prePrompt), SharedMounts: []string{"~/shared"}},
		},
	}

	path := filepath.Join(t.TempDir(), "config.toml")
	if err := SaveToFile(path, cfg); err != nil {
		t.Fatalf("SaveToFile: %v", err)
	}

	data, _ := os.ReadFile(path)
	t.Logf("Generated TOML:\n%s", data)

	loaded, err := LoadFile(path)
	if err != nil {
		t.Fatalf("LoadFile: %v", err)
	}

	if *loaded.Defaults.PrePrompt != prePrompt {
		t.Errorf("PrePrompt mismatch\ngot:  %q\nwant: %q", *loaded.Defaults.PrePrompt, prePrompt)
	}
	if loaded.Defaults.Sandbox == nil {
		t.Fatal("sandbox config not round-tripped")
	}
	if len(loaded.Defaults.Sandbox.MaskedPaths) != 1 || loaded.Defaults.Sandbox.MaskedPaths[0] != "~/.ssh" {
		t.Errorf("MaskedPaths mismatch: %v", loaded.Defaults.Sandbox.MaskedPaths)
	}
	if loaded.Defaults.Sandbox.Network == nil || loaded.Defaults.Sandbox.Network.Enabled == nil || *loaded.Defaults.Sandbox.Network.Enabled != false {
		t.Errorf("network policy not round-tripped: %+v", loaded.Defaults.Sandbox.Network)
	}
	if *loaded.Agents["claude"].PrePrompt != prePrompt {
		t.Errorf("claude.PrePrompt mismatch")
	}
}

func TestArtifactsRoundTrip(t *testing.T) {
	cfg := Config{
		Artifacts: []ArtifactScript{
			{Name: "web screenshots", Command: "bun run shots.ts", TimeoutSec: 600},
			{Name: "docs", Command: "make docs-png"},
		},
	}

	path := filepath.Join(t.TempDir(), "config.toml")
	if err := SaveToFile(path, cfg); err != nil {
		t.Fatalf("SaveToFile: %v", err)
	}

	loaded, err := LoadFile(path)
	if err != nil {
		t.Fatalf("LoadFile: %v", err)
	}
	if loaded == nil || len(loaded.Artifacts) != 2 {
		t.Fatalf("expected 2 artifacts, got %+v", loaded)
	}
	if loaded.Artifacts[0].Name != "web screenshots" || loaded.Artifacts[0].Command != "bun run shots.ts" || loaded.Artifacts[0].TimeoutSec != 600 {
		t.Errorf("artifact[0] mismatch: %+v", loaded.Artifacts[0])
	}
	if loaded.Artifacts[1].Name != "docs" || loaded.Artifacts[1].TimeoutSec != 0 {
		t.Errorf("artifact[1] mismatch: %+v", loaded.Artifacts[1])
	}
}

func TestArtifactsMergeReplaces(t *testing.T) {
	base := Config{Artifacts: []ArtifactScript{{Name: "a", Command: "x"}}}
	base.Merge(Config{Artifacts: []ArtifactScript{{Name: "b", Command: "y"}}})
	if len(base.Artifacts) != 1 || base.Artifacts[0].Name != "b" {
		t.Errorf("expected merge to replace artifacts, got %+v", base.Artifacts)
	}
	// Merging a config without artifacts leaves the existing list intact.
	base.Merge(Config{})
	if len(base.Artifacts) != 1 || base.Artifacts[0].Name != "b" {
		t.Errorf("expected artifacts preserved, got %+v", base.Artifacts)
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || len(sub) == 0 ||
		func() bool {
			for i := 0; i <= len(s)-len(sub); i++ {
				if s[i:i+len(sub)] == sub {
					return true
				}
			}
			return false
		}())
}

func splitLines(s string) []string {
	var lines []string
	start := 0
	for i, c := range s {
		if c == '\n' {
			lines = append(lines, s[start:i])
			start = i + 1
		}
	}
	if start < len(s) {
		lines = append(lines, s[start:])
	}
	return lines
}
