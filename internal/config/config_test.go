package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func ptr(s string) *string { return &s }

func TestResolveFullscreen(t *testing.T) {
	// Unset → disabled (the safe default that forces the classic renderer).
	if (Config{}).ResolveFullscreen("claude") {
		t.Error("fullscreen should default to false")
	}
	// Accepted only under [claude].
	on := Config{Agents: map[string]AgentConfig{"claude": {Fullscreen: boolPtr(true)}}}
	if !on.ResolveFullscreen("claude") {
		t.Error("[claude] fullscreen=true should resolve true")
	}
	off := Config{Agents: map[string]AgentConfig{"claude": {Fullscreen: boolPtr(false)}}}
	if off.ResolveFullscreen("claude") {
		t.Error("[claude] fullscreen=false should resolve false")
	}
	// A value at the defaults level is ignored — fullscreen is Claude-table-only.
	def := Config{Defaults: AgentConfig{Fullscreen: boolPtr(true)}}
	if def.ResolveFullscreen("claude") {
		t.Error("defaults fullscreen should NOT apply (only [claude] is accepted)")
	}
	// Non-Claude agents never get fullscreen, even if set under their table.
	gem := Config{Agents: map[string]AgentConfig{"gemini": {Fullscreen: boolPtr(true)}}}
	if gem.ResolveFullscreen("gemini") {
		t.Error("fullscreen is Claude-only; gemini must resolve false")
	}
}

func TestFullscreenRenderRoundTrip(t *testing.T) {
	// The empty template documents fullscreen as a commented-out default, and it
	// lives under the [claude] section — never at the root.
	tmpl := renderConfig(nil, Config{})
	if !strings.Contains(tmpl, docPrefix+" enable Claude Code's fullscreen") {
		t.Errorf("template missing fullscreen doc line:\n%s", tmpl)
	}
	if !strings.Contains(tmpl, "# fullscreen = false") {
		t.Errorf("template missing commented fullscreen default:\n%s", tmpl)
	}
	// The fullscreen line must come after the [claude] header, not in the root
	// defaults block (before [sandbox]).
	if fsIdx, claudeIdx := strings.Index(tmpl, "fullscreen ="), strings.Index(tmpl, "[claude]"); fsIdx < claudeIdx {
		t.Errorf("fullscreen rendered outside the [claude] section:\n%s", tmpl)
	}

	// An explicit [claude] override renders active under [claude] and survives a
	// decode→render round-trip (i.e. it is not dropped on save).
	cfg := Config{Agents: map[string]AgentConfig{"claude": {Fullscreen: boolPtr(true)}}}
	out := renderConfig(nil, cfg)
	if !strings.Contains(out, "[claude]") || !strings.Contains(out, "fullscreen = true") {
		t.Errorf("claude fullscreen override not rendered:\n%s", out)
	}
	decoded, err := decodeConfig([]byte(out))
	if err != nil {
		t.Fatalf("decode rendered config: %v", err)
	}
	if c := decoded.Agents["claude"]; c.Fullscreen == nil || !*c.Fullscreen {
		t.Errorf("claude fullscreen lost on round-trip: %+v", decoded.Agents["claude"])
	}

	// A defaults-level fullscreen is Claude-only and must be dropped on render —
	// it never appears outside [claude].
	dropped := renderConfig(nil, Config{Defaults: AgentConfig{Fullscreen: boolPtr(true)}})
	if strings.Contains(dropped, "fullscreen = true") {
		t.Errorf("defaults-level fullscreen should not be emitted:\n%s", dropped)
	}
}

func TestMarshalConfig_MultiLineStrings(t *testing.T) {
	prePrompt := "You are an agent.\n- Do stuff\n- More stuff\n"

	cfg := Config{
		Defaults: AgentConfig{
			PrePrompt: ptr(prePrompt),
		},
	}

	out := renderConfig(nil, cfg)

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

	out := renderConfig(nil, cfg)

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
				CowPaths:      []string{"pipeline/out", "pipeline/build/input"},
				Network:       &NetworkConfig{Enabled: &enabled, AllowedHosts: []string{"example.com"}},
			},
		},
		Agents: map[string]AgentConfig{
			"claude": {PrePrompt: ptr(prePrompt), Sandbox: &SandboxConfig{WritablePaths: []string{"~/shared"}}},
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
	if got := loaded.Defaults.Sandbox.CowPaths; len(got) != 2 || got[0] != "pipeline/out" || got[1] != "pipeline/build/input" {
		t.Errorf("CowPaths not round-tripped: %v", got)
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

// TestArtifactCommentSurvivesMultilineCommand guards a save round-trip where an
// artifact's command is a multi-line string that itself contains shell "#"
// comments and a "name=" assignment. Those must not be mistaken for the block's
// interior comments or its name, which previously filed the user's real comment
// under the wrong key and dropped it on save.
func TestArtifactCommentSurvivesMultilineCommand(t *testing.T) {
	command := `out_dir="x"
# a shell comment inside the command
name=$(basename "$f")
echo hi
`
	existing := "[[artifacts]]\n" +
		"# Render the screenshot tests and collect the PNGs.\n" +
		"# Second line of the user comment.\n" +
		`name = "screenshots"` + "\n" +
		"command = \"\"\"\n" + command + "\"\"\"\n" +
		"timeout_sec = 900\n"

	path := filepath.Join(t.TempDir(), "config.toml")
	if err := os.WriteFile(path, []byte(existing), 0o644); err != nil {
		t.Fatalf("write existing: %v", err)
	}

	cfg := Config{Artifacts: []ArtifactScript{
		{Name: "screenshots", Command: command, TimeoutSec: 900},
	}}
	if err := SaveToFile(path, cfg); err != nil {
		t.Fatalf("SaveToFile: %v", err)
	}

	saved, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read saved: %v", err)
	}
	for _, want := range []string{
		"# Render the screenshot tests and collect the PNGs.",
		"# Second line of the user comment.",
		`name = "screenshots"`,
	} {
		if !strings.Contains(string(saved), want) {
			t.Errorf("saved config missing %q:\n%s", want, saved)
		}
	}
}

// TestKeyCommentSurvivesMultilineArray guards that a user comment above a
// managed key whose value spans multiple lines (a formatted array) is attributed
// to that key and re-emitted, rather than being swallowed by the array body.
func TestKeyCommentSurvivesMultilineArray(t *testing.T) {
	existing := "[sandbox]\n" +
		"# keep this note above writable_paths\n" +
		"writable_paths = [\n  \"~/.cache\",\n  \"~/.npm\",\n]\n"

	path := filepath.Join(t.TempDir(), "config.toml")
	if err := os.WriteFile(path, []byte(existing), 0o644); err != nil {
		t.Fatalf("write existing: %v", err)
	}

	cfg := Config{Defaults: AgentConfig{
		Sandbox: &SandboxConfig{WritablePaths: []string{"~/.cache", "~/.npm"}},
	}}
	if err := SaveToFile(path, cfg); err != nil {
		t.Fatalf("SaveToFile: %v", err)
	}
	saved, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read saved: %v", err)
	}
	if !strings.Contains(string(saved), "# keep this note above writable_paths") {
		t.Errorf("saved config dropped the key comment:\n%s", saved)
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

func TestArtifactsAtProjectTOML(t *testing.T) {
	// Isolate from any real user config so the result is deterministic.
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	content := []byte(`
[[artifacts]]
name = "home"
command = "shot home"

[[artifacts]]
name = "about"
command = "shot about"
timeout_sec = 30
`)
	got, err := ArtifactsAtProjectTOML(content)
	if err != nil {
		t.Fatalf("ArtifactsAtProjectTOML: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("got %d artifacts, want 2: %+v", len(got), got)
	}
	if got[0].Name != "home" || got[0].Command != "shot home" {
		t.Errorf("artifact[0] = %+v", got[0])
	}
	if got[1].Name != "about" || got[1].TimeoutSec != 30 {
		t.Errorf("artifact[1] = %+v", got[1])
	}

	// A config without an [[artifacts]] section yields none (no user config here).
	none, err := ArtifactsAtProjectTOML([]byte("[defaults]\n"))
	if err != nil {
		t.Fatalf("ArtifactsAtProjectTOML(empty): %v", err)
	}
	if len(none) != 0 {
		t.Errorf("expected no artifacts, got %+v", none)
	}

	// Empty content (file absent at a ref) is not an error.
	if _, err := ArtifactsAtProjectTOML(nil); err != nil {
		t.Errorf("ArtifactsAtProjectTOML(nil): %v", err)
	}

	// Malformed TOML surfaces an error.
	if _, err := ArtifactsAtProjectTOML([]byte("this is not = = toml")); err == nil {
		t.Error("expected error for malformed TOML, got nil")
	}
}

const legacyConfig = `[defaults]
pre_prompt = """
- Use bun
- Check mage build"""

[defaults.sandbox]
writable_paths = ["~/.cache/go-build", "~/.magefile"]

[agents.claude]
[agents.claude.sandbox]
masked_paths = ["~/.secret"]

# A hand-written note about screenshots.
[[artifacts]]
name = "screenshots"
command = "bun shots.ts"
timeout_sec = 900
`

func TestDecodeLegacyFormat(t *testing.T) {
	cfg, err := decodeConfig([]byte(legacyConfig))
	if err != nil {
		t.Fatalf("decodeConfig: %v", err)
	}
	if cfg.Defaults.PrePrompt == nil || !strings.Contains(*cfg.Defaults.PrePrompt, "Use bun") {
		t.Errorf("defaults pre_prompt not decoded: %+v", cfg.Defaults.PrePrompt)
	}
	if cfg.Defaults.Sandbox == nil || len(cfg.Defaults.Sandbox.WritablePaths) != 2 {
		t.Errorf("defaults sandbox not decoded: %+v", cfg.Defaults.Sandbox)
	}
	claude := cfg.Agents["claude"]
	if claude.Sandbox == nil || len(claude.Sandbox.MaskedPaths) != 1 || claude.Sandbox.MaskedPaths[0] != "~/.secret" {
		t.Errorf("agent claude sandbox not decoded: %+v", claude.Sandbox)
	}
	if len(cfg.Artifacts) != 1 || cfg.Artifacts[0].Name != "screenshots" {
		t.Errorf("artifacts not decoded: %+v", cfg.Artifacts)
	}
}

func TestResumeContinueMessage(t *testing.T) {
	// Unset → built-in default.
	if got := (Config{}).ResumeContinueMessage(); got != DefaultResumePrompt {
		t.Errorf("unset resume_prompt: got %q, want %q", got, DefaultResumePrompt)
	}
	// Empty string → disabled (no nudge).
	empty := ""
	if got := (Config{ResumePrompt: &empty}).ResumeContinueMessage(); got != "" {
		t.Errorf("empty resume_prompt: got %q, want \"\"", got)
	}
	// Custom string → used verbatim.
	custom := "Please resume the task."
	if got := (Config{ResumePrompt: &custom}).ResumeContinueMessage(); got != custom {
		t.Errorf("custom resume_prompt: got %q, want %q", got, custom)
	}
}

func TestDecodeResumePrompt(t *testing.T) {
	cfg, err := decodeConfig([]byte("resume_prompt = \"keep going\"\n"))
	if err != nil {
		t.Fatalf("decodeConfig: %v", err)
	}
	if cfg.ResumePrompt == nil || *cfg.ResumePrompt != "keep going" {
		t.Fatalf("resume_prompt not decoded: %+v", cfg.ResumePrompt)
	}
	if got := cfg.ResumeContinueMessage(); got != "keep going" {
		t.Errorf("ResumeContinueMessage: got %q", got)
	}
	// A bare resume_prompt key must not be mistaken for an agent table.
	if _, ok := cfg.Agents["resume_prompt"]; ok {
		t.Error("resume_prompt leaked into agents map")
	}
}

func TestRenderResumePrompt(t *testing.T) {
	// Unset → commented-out documented default.
	if got := renderConfig(nil, Config{}); !strings.Contains(got, `# resume_prompt = "Continue"`) {
		t.Errorf("unset resume_prompt not documented:\n%s", got)
	}

	// Explicitly set → emitted as a live key and decodes back unchanged.
	set := "keep going"
	rendered := renderConfig(nil, Config{ResumePrompt: &set})
	if !strings.Contains(rendered, `resume_prompt = "keep going"`) {
		t.Errorf("set resume_prompt not emitted:\n%s", rendered)
	}
	back, err := decodeConfig([]byte(rendered))
	if err != nil {
		t.Fatalf("re-decode: %v", err)
	}
	if back.ResumePrompt == nil || *back.ResumePrompt != "keep going" {
		t.Errorf("round-trip lost resume_prompt: %+v", back.ResumePrompt)
	}

	// A structured save that omits resume_prompt (cfg.ResumePrompt == nil) must
	// preserve the value already in the file rather than dropping it.
	existing := []byte("resume_prompt = \"from disk\"\n")
	preserved := renderConfig(existing, Config{})
	if !strings.Contains(preserved, `resume_prompt = "from disk"`) {
		t.Errorf("resume_prompt not preserved across structured save:\n%s", preserved)
	}
	// And it must not be duplicated.
	if strings.Count(preserved, "resume_prompt =") != 1 {
		t.Errorf("resume_prompt emitted more than once:\n%s", preserved)
	}
}

func TestDecodeNewFormat(t *testing.T) {
	const newCfg = `pre_prompt = "hello"

[sandbox]
writable_paths = ["~/.cache"]

[sandbox.network]
enabled = false

[claude]
pre_prompt = "claude-only"

[claude.sandbox]
masked_paths = ["~/.secret"]

[[artifacts]]
name = "shots"
command = "run"
`
	cfg, err := decodeConfig([]byte(newCfg))
	if err != nil {
		t.Fatalf("decodeConfig: %v", err)
	}
	if cfg.Defaults.PrePrompt == nil || *cfg.Defaults.PrePrompt != "hello" {
		t.Errorf("defaults pre_prompt: %+v", cfg.Defaults.PrePrompt)
	}
	if cfg.Defaults.Sandbox == nil || cfg.Defaults.Sandbox.Network == nil ||
		cfg.Defaults.Sandbox.Network.Enabled == nil || *cfg.Defaults.Sandbox.Network.Enabled {
		t.Errorf("defaults sandbox/network: %+v", cfg.Defaults.Sandbox)
	}
	claude := cfg.Agents["claude"]
	if claude.PrePrompt == nil || *claude.PrePrompt != "claude-only" {
		t.Errorf("agent pre_prompt: %+v", claude.PrePrompt)
	}
	if claude.Sandbox == nil || len(claude.Sandbox.MaskedPaths) != 1 {
		t.Errorf("agent sandbox: %+v", claude.Sandbox)
	}
	if len(cfg.Artifacts) != 1 || cfg.Artifacts[0].Name != "shots" {
		t.Errorf("artifacts: %+v", cfg.Artifacts)
	}
}

func TestRenderMigratesLegacyToNew(t *testing.T) {
	cfg, err := decodeConfig([]byte(legacyConfig))
	if err != nil {
		t.Fatalf("decodeConfig: %v", err)
	}
	out := renderConfig([]byte(legacyConfig), cfg)
	t.Logf("rendered:\n%s", out)

	for _, bad := range []string{"[defaults]", "[defaults.sandbox]", "[agents.claude]"} {
		if strings.Contains(out, bad) {
			t.Errorf("output still contains legacy table %q:\n%s", bad, out)
		}
	}
	for _, want := range []string{"[sandbox]", "[claude]", "[claude.sandbox]", "[[artifacts]]"} {
		if !strings.Contains(out, want) {
			t.Errorf("output missing new-format table %q:\n%s", want, out)
		}
	}
	// Managed value preserved, user artifact comment migrated with its block.
	if !strings.Contains(out, `writable_paths = ["~/.cache/go-build", "~/.magefile"]`) {
		t.Errorf("writable_paths not preserved:\n%s", out)
	}
	if !strings.Contains(out, "# A hand-written note about screenshots.") {
		t.Errorf("user artifact comment not preserved:\n%s", out)
	}
	// Round-trips back to the same logical config.
	reloaded, err := decodeConfig([]byte(out))
	if err != nil {
		t.Fatalf("decode rendered: %v", err)
	}
	if reloaded.Agents["claude"].Sandbox == nil || len(reloaded.Agents["claude"].Sandbox.MaskedPaths) != 1 {
		t.Errorf("agent config lost in migration: %+v", reloaded.Agents["claude"])
	}
}

func TestRenderIdempotent(t *testing.T) {
	cfg, err := decodeConfig([]byte(legacyConfig))
	if err != nil {
		t.Fatalf("decodeConfig: %v", err)
	}
	first := renderConfig([]byte(legacyConfig), cfg)
	cfg2, err := decodeConfig([]byte(first))
	if err != nil {
		t.Fatalf("decode first: %v", err)
	}
	second := renderConfig([]byte(first), cfg2)
	if first != second {
		t.Errorf("render not idempotent:\n--- first ---\n%s\n--- second ---\n%s", first, second)
	}
}

func TestCommentPreservationAcrossSave(t *testing.T) {
	const existing = `[sandbox]
# keep this note
writable_paths = ["~/.cache"]
`
	cfg, err := decodeConfig([]byte(existing))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	out := renderConfig([]byte(existing), cfg)
	if !strings.Contains(out, "# keep this note") {
		t.Errorf("user comment dropped:\n%s", out)
	}
	idx := strings.Index(out, "# keep this note")
	if w := strings.Index(out, "writable_paths ="); w < idx {
		t.Errorf("comment not above its key:\n%s", out)
	}
}

func TestArtifactsAuthoritativeEditAndDelete(t *testing.T) {
	const existing = `[sandbox]
writable_paths = ["~/.cache"]

# leading note
[[artifacts]]
# inner note about shots
name = "shots"
command = "bun shots.ts"
timeout_sec = 900

[[artifacts]]
name = "docs"
command = "make docs"
`
	// Simulate an editor save: artifacts sent explicitly. "shots" is edited,
	// "docs" is deleted, and a brand-new "extra" is added.
	cfg := Config{Artifacts: []ArtifactScript{
		{Name: "shots", Command: "bun newshots.ts", TimeoutSec: 120},
		{Name: "extra", Command: "echo hi"},
	}}
	out := renderConfig([]byte(existing), cfg)
	t.Logf("rendered:\n%s", out)

	loaded, err := decodeConfig([]byte(out))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(loaded.Artifacts) != 2 {
		t.Fatalf("want 2 artifacts, got %+v", loaded.Artifacts)
	}
	if loaded.Artifacts[0].Name != "shots" || loaded.Artifacts[0].Command != "bun newshots.ts" || loaded.Artifacts[0].TimeoutSec != 120 {
		t.Errorf("edit not applied: %+v", loaded.Artifacts[0])
	}
	if loaded.Artifacts[1].Name != "extra" {
		t.Errorf("new artifact missing: %+v", loaded.Artifacts)
	}
	if strings.Contains(out, `"docs"`) {
		t.Errorf("deleted artifact still present:\n%s", out)
	}
	// Hand-written comments for a surviving artifact are preserved by name.
	if !strings.Contains(out, "# leading note") || !strings.Contains(out, "# inner note about shots") {
		t.Errorf("comments for surviving artifact dropped:\n%s", out)
	}

	// Idempotent re-render.
	second := renderConfig([]byte(out), loaded)
	if second != out {
		t.Errorf("authoritative render not idempotent:\n--first--\n%s\n--second--\n%s", out, second)
	}
}

func TestArtifactsAuthoritativeEmptyClears(t *testing.T) {
	const existing = `[[artifacts]]
name = "shots"
command = "bun shots.ts"
`
	// An explicit empty (non-nil) list clears all artifacts.
	out := renderConfig([]byte(existing), Config{Artifacts: []ArtifactScript{}})
	loaded, err := decodeConfig([]byte(out))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(loaded.Artifacts) != 0 {
		t.Errorf("expected artifacts cleared, got %+v", loaded.Artifacts)
	}
	if !strings.Contains(out, "# [[artifacts]]") {
		t.Errorf("commented example should appear after clearing:\n%s", out)
	}
}

func TestArtifactConcurrencyRender(t *testing.T) {
	num := func(n int) *int { return &n }

	// A positive value is written authoritatively.
	out := renderConfig(nil, Config{ArtifactConcurrency: num(5)})
	if !strings.Contains(out, "artifact_concurrency = 5") {
		t.Errorf("expected explicit value, got:\n%s", out)
	}
	loaded, err := decodeConfig([]byte(out))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if loaded.ResolveArtifactConcurrency() != 5 {
		t.Errorf("want 5, got %d", loaded.ResolveArtifactConcurrency())
	}

	// 0 is a real, distinct value: unlimited. It must survive a round-trip (not be
	// confused with unset, which would resolve to the default).
	unlimited := renderConfig(nil, Config{ArtifactConcurrency: num(0)})
	if !strings.Contains(unlimited, "artifact_concurrency = 0") {
		t.Errorf("expected 'artifact_concurrency = 0' for unlimited, got:\n%s", unlimited)
	}
	loadedU, err := decodeConfig([]byte(unlimited))
	if err != nil {
		t.Fatalf("decode unlimited: %v", err)
	}
	if loadedU.ArtifactConcurrency == nil || *loadedU.ArtifactConcurrency != 0 || loadedU.ResolveArtifactConcurrency() != 0 {
		t.Errorf("0 (unlimited) should round-trip as a set value, got %v", loadedU.ArtifactConcurrency)
	}

	// Clearing it (nil) resets to the default: the existing file's value is NOT
	// preserved — the line is re-emitted commented-out, so a later load falls back
	// to DefaultArtifactConcurrency. This is what makes the UI's "clear" work.
	const existing = `artifact_concurrency = 7
`
	reset := renderConfig([]byte(existing), Config{ArtifactConcurrency: nil})
	if strings.Contains(reset, "\nartifact_concurrency = 7") || strings.Contains(reset, "\nartifact_concurrency = ") {
		t.Errorf("clearing should not preserve the old value:\n%s", reset)
	}
	if !strings.Contains(reset, "# artifact_concurrency = 2") {
		t.Errorf("clearing should re-emit the commented default:\n%s", reset)
	}
	loaded2, err := decodeConfig([]byte(reset))
	if err != nil {
		t.Fatalf("decode reset: %v", err)
	}
	if loaded2.ArtifactConcurrency != nil || loaded2.ResolveArtifactConcurrency() != DefaultArtifactConcurrency {
		t.Errorf("after reset want unset (default), got %v", loaded2.ArtifactConcurrency)
	}
}

func TestArtifactsSurviveDefaultsOnlySave(t *testing.T) {
	const existing = `[sandbox]
writable_paths = ["~/.cache"]

# my screenshot generator
[[artifacts]]
name = "shots"
command = "bun shots.ts"
timeout_sec = 900
`
	// Simulate a UI save: only defaults are sent, Artifacts is nil.
	enabled := true
	cfg := Config{Defaults: AgentConfig{Sandbox: &SandboxConfig{
		WritablePaths: []string{"~/.cache", "/tmp"},
		Network:       &NetworkConfig{Enabled: &enabled},
	}}}
	out := renderConfig([]byte(existing), cfg)
	t.Logf("rendered:\n%s", out)

	loaded, err := decodeConfig([]byte(out))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(loaded.Artifacts) != 1 || loaded.Artifacts[0].Name != "shots" || loaded.Artifacts[0].TimeoutSec != 900 {
		t.Fatalf("artifacts not preserved on defaults-only save: %+v", loaded.Artifacts)
	}
	if !strings.Contains(out, "# my screenshot generator") {
		t.Errorf("artifact comment dropped:\n%s", out)
	}
	if !strings.Contains(out, `writable_paths = ["~/.cache", "/tmp"]`) {
		t.Errorf("updated writable_paths missing:\n%s", out)
	}
}

func TestCommentedDefaultsForUnsetSettings(t *testing.T) {
	out := renderConfig(nil, Config{})
	t.Logf("template:\n%s", out)

	wants := []string{
		"[sandbox]",
		docPrefix + " extra paths made writable in the sandbox",
		"# writable_paths = [",
		"# masked_paths = [",
		"[sandbox.network]",
		"# enabled = true",
		// Each well-known agent type gets a documented, commented-out mention.
		docPrefix + " Claude-specific overrides",
		"# [claude]",
		docPrefix + " Gemini-specific overrides",
		"# [gemini]",
		docPrefix + " Copilot-specific overrides",
		"# [copilot]",
		docPrefix + " Codex-specific overrides",
		"# [codex]",
		// Artifacts documentation + commented example are always present.
		docPrefix + " [[artifacts]]:",
		"# [[artifacts]]",
		`# name = "screenshots"`,
	}
	for _, w := range wants {
		if !strings.Contains(out, w) {
			t.Errorf("template missing %q:\n%s", w, out)
		}
	}
	// A fully-commented template activates nothing: the (empty) tables decode
	// but carry no values, and there are no artifacts.
	cfg, err := decodeConfig([]byte(out))
	if err != nil {
		t.Fatalf("decode template: %v", err)
	}
	if cfg.Defaults.PrePrompt != nil || sandboxHasContent(cfg.Defaults.Sandbox) || len(cfg.Artifacts) != 0 {
		t.Errorf("commented template should activate nothing, got: %+v", cfg)
	}
}

func TestDocAboveSetValuesAndConfiguredAgent(t *testing.T) {
	cfg := Config{
		Defaults: AgentConfig{Sandbox: &SandboxConfig{WritablePaths: []string{"~/.cache"}}},
		Agents:   map[string]AgentConfig{"claude": {PrePrompt: strPtr("be terse")}},
	}
	out := renderConfig(nil, cfg)
	t.Logf("rendered:\n%s", out)

	// A set value still carries its Hydra doc line directly above it.
	docIdx := strings.Index(out, docPrefix+" extra paths made writable in the sandbox")
	valIdx := strings.Index(out, "writable_paths = [")
	if docIdx < 0 || valIdx < 0 || docIdx > valIdx {
		t.Errorf("doc line not directly above set writable_paths:\n%s", out)
	}
	// A configured agent gets its real table preceded by the agent doc line, and
	// no commented-out placeholder for it.
	if !strings.Contains(out, docPrefix+" Claude-specific overrides") || !strings.Contains(out, "[claude]") {
		t.Errorf("configured claude table/doc missing:\n%s", out)
	}
	if strings.Contains(out, "# [claude]") {
		t.Errorf("configured claude should not also have a commented placeholder:\n%s", out)
	}
	// The other known agents still get commented placeholders.
	if !strings.Contains(out, "# [gemini]") || !strings.Contains(out, "# [copilot]") {
		t.Errorf("unconfigured agent placeholders missing:\n%s", out)
	}
}

func TestMultiLineValueParsing(t *testing.T) {
	// A triple-quoted pre_prompt whose body contains '#' and 'key =' lines must
	// not confuse the parser, and a following user comment must be preserved.
	const existing = "[sandbox]\n" +
		"pre_spawn_script = \"\"\"\n" +
		"# not a comment\n" +
		"writable_paths = tricky\n" +
		"\"\"\"\n" +
		"# real comment\n" +
		"writable_paths = [\"~/.cache\"]\n"
	cfg, err := decodeConfig([]byte(existing))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	out := renderConfig([]byte(existing), cfg)
	if !strings.Contains(out, "# real comment") {
		t.Errorf("comment after multi-line value lost:\n%s", out)
	}
	if cfg.Defaults.Sandbox == nil || len(cfg.Defaults.Sandbox.WritablePaths) != 1 {
		t.Errorf("writable_paths after multi-line value not decoded: %+v", cfg.Defaults.Sandbox)
	}
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
