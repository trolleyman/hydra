package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/trolleyman/hydra/internal/sandbox"
)

func ptr(s string) *string { return &s }

func TestDefaultPrePromptRequiresStructuredQuestions(t *testing.T) {
	for _, tool := range []string{"AskUserQuestion", "request_user_input"} {
		if !strings.Contains(DefaultPrePrompt, tool) {
			t.Errorf("DefaultPrePrompt does not name the %s question tool", tool)
		}
	}
	if !strings.Contains(DefaultPrePrompt, "Do not ask the question only in a plain chat message") {
		t.Error("DefaultPrePrompt does not require structured questions instead of plain chat")
	}
}

func TestFinalPrePromptDocumentsOutputSections(t *testing.T) {
	prompt := BuildFinalPrePrompt(Config{}, string(sandbox.AgentTypeClaude))
	for _, command := range []string{"--- <text> ---", "--- [file] <path> ---", "--- [dir] <path> ---"} {
		if !strings.Contains(prompt, command) {
			t.Errorf("final pre-prompt does not document %q", command)
		}
	}
	if strings.Contains(prompt, "--- [text]") {
		t.Error("final pre-prompt still asks agents to tag ordinary text headings")
	}
	for _, guidance := range []string{"immediately before every command", "including the first", "Keep file reads bounded"} {
		if !strings.Contains(prompt, guidance) {
			t.Errorf("final pre-prompt does not document output-section guidance %q", guidance)
		}
	}
	if !strings.Contains(prompt, "`git diff`") {
		t.Error("final pre-prompt does not tell agents that unified diffs need no marker")
	}
}

func TestDefaultPrePromptAllowsGuardedHeadCollaboration(t *testing.T) {
	for _, want := range []string{
		"discover live heads in this project",
		"when messaging is enabled by policy, send them attributed messages",
		"must not spawn, kill, merge, attach, or resume heads",
	} {
		if !strings.Contains(DefaultPrePrompt, want) {
			t.Errorf("DefaultPrePrompt does not contain collaboration guardrail %q", want)
		}
	}
}

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
	// A value at the defaults level is ignored - fullscreen is Claude-table-only.
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
	// lives under the [claude] section - never at the root.
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

	// A defaults-level fullscreen is Claude-only and must be dropped on render -
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

	// Should contain triple-apostrophe literal strings (no escaping needed)
	if !contains(out, `'''`) {
		t.Errorf("expected triple-apostrophe strings in output, got:\n%s", out)
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
			{Name: "web screenshots", Script: "bun run shots.ts", TimeoutSec: 600},
			{Name: "docs", Script: "make docs-png"},
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
	if loaded.Artifacts[0].Name != "web screenshots" || loaded.Artifacts[0].Script != "bun run shots.ts" || loaded.Artifacts[0].TimeoutSec != 600 {
		t.Errorf("artifact[0] mismatch: %+v", loaded.Artifacts[0])
	}
	if loaded.Artifacts[1].Name != "docs" || loaded.Artifacts[1].TimeoutSec != 0 {
		t.Errorf("artifact[1] mismatch: %+v", loaded.Artifacts[1])
	}
}

// TestPreviewRoundTrip covers the [previews.<name>] fields: command,
// idle_timeout_sec and ready_timeout_sec must survive a save/load cycle, and a
// media artifact saved alongside must stay in the artifacts section.
func TestPreviewRoundTrip(t *testing.T) {
	ports := "26610-26620"
	cfg := Config{
		Artifacts:    []ArtifactScript{{Name: "shots", Script: "bun run shots.ts"}},
		Previews:     []PreviewScript{{Name: "demo", Script: "run-demo.sh", IdleTimeoutSec: 60, ReadyTimeoutSec: 120}},
		PreviewPorts: &ports,
	}

	path := filepath.Join(t.TempDir(), "config.toml")
	if err := SaveToFile(path, cfg); err != nil {
		t.Fatalf("SaveToFile: %v", err)
	}
	loaded, err := LoadFile(path)
	if err != nil {
		t.Fatalf("LoadFile: %v", err)
	}
	if len(loaded.Previews) != 1 {
		t.Fatalf("expected 1 preview, got %+v", loaded.Previews)
	}
	demo := loaded.Previews[0]
	if demo.Script != "run-demo.sh" || demo.IdleTimeoutSec != 60 || demo.ReadyTimeoutSec != 120 {
		t.Errorf("preview mismatch: %+v", demo)
	}
	if len(loaded.Artifacts) != 1 || loaded.Artifacts[0].Name != "shots" {
		t.Errorf("artifacts mismatch: %+v", loaded.Artifacts)
	}
	if lo, hi := loaded.ResolvePreviewPortRange(); lo != 26610 || hi != 26620 {
		t.Errorf("preview port range = %d-%d, want 26610-26620", lo, hi)
	}
}

// TestServerArtifactUpgradesToPreview covers the back-compat path: a config
// still spelling a preview as an [artifacts.<name>] with type = "server" is
// read as a PreviewScript (fields and all), leaves the artifacts list holding
// only real media scripts, and is rewritten under [previews.<name>] on save.
func TestServerArtifactUpgradesToPreview(t *testing.T) {
	const legacy = `
[artifacts.demo]
type = "server"
command = "run-demo.sh"
idle_timeout_sec = 60
ready_timeout_sec = 120

[artifacts.shots]
command = "bun run shots.ts"
`
	cfg, err := decodeConfig([]byte(legacy))
	if err != nil {
		t.Fatalf("decodeConfig: %v", err)
	}
	if len(cfg.Previews) != 1 {
		t.Fatalf("expected the server artifact to become a preview, got %+v", cfg.Previews)
	}
	demo := cfg.Previews[0]
	if demo.Name != "demo" || demo.Script != "run-demo.sh" || demo.IdleTimeoutSec != 60 || demo.ReadyTimeoutSec != 120 {
		t.Errorf("upgraded preview mismatch: %+v", demo)
	}
	if !cfg.PreviewsNamed {
		t.Error("PreviewsNamed should follow the artifacts syntax that carried the entry")
	}
	if len(cfg.Artifacts) != 1 || cfg.Artifacts[0].Name != "shots" {
		t.Errorf("server entry left in artifacts: %+v", cfg.Artifacts)
	}

	// Saving the upgraded config migrates the file.
	path := filepath.Join(t.TempDir(), "config.toml")
	if err := SaveToFile(path, cfg); err != nil {
		t.Fatalf("SaveToFile: %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	out := string(data)
	if !strings.Contains(out, "[previews.demo]") {
		t.Errorf("saved config has no [previews.demo]:\n%s", out)
	}
	if strings.Contains(out, "[artifacts.demo]") {
		t.Errorf("saved config still has [artifacts.demo]:\n%s", out)
	}
	// The doc block mentions the legacy spelling, so only an uncommented
	// assignment counts as "still written".
	for ln := range strings.SplitSeq(out, "\n") {
		if strings.HasPrefix(strings.TrimSpace(ln), "type =") {
			t.Errorf("saved config still writes the legacy type key: %q\n%s", ln, out)
		}
	}
}

// TestMediaTypeIsDropped covers the other half of the type key's retirement:
// artifacts have no kinds any more, so an explicit type = "media" is consumed on
// read and gone from [artifacts.<name>] on the next save, exactly as a
// type = "server" is (that one having moved to [previews.<name>]).
func TestMediaTypeIsDropped(t *testing.T) {
	for _, typ := range []string{`type = "media"`, `type = ""`, `type = "typoe"`} {
		cfg, err := decodeConfig([]byte("[artifacts.shots]\n" + typ + "\ncommand = \"x\"\n"))
		if err != nil {
			t.Fatalf("decodeConfig %s: %v", typ, err)
		}
		if len(cfg.Artifacts) != 1 {
			t.Fatalf("%s: expected the entry to stay an artifact, got %+v", typ, cfg.Artifacts)
		}
		if cfg.Artifacts[0].Type != "" {
			t.Errorf("%s: Type survived decode as %q", typ, cfg.Artifacts[0].Type)
		}

		path := filepath.Join(t.TempDir(), "config.toml")
		if err := SaveToFile(path, cfg); err != nil {
			t.Fatalf("SaveToFile: %v", err)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("ReadFile: %v", err)
		}
		for ln := range strings.SplitSeq(string(data), "\n") {
			if strings.HasPrefix(strings.TrimSpace(ln), "type =") {
				t.Errorf("%s: saved config still writes %q", typ, ln)
			}
		}
	}
}

// TestCommandKeyUpgradesToScript covers the `command` -> `script` rename across
// all four script sections: the old key still parses (a diffed git ref's config
// can be arbitrarily old), lands in Script, and is gone from the file after a
// save. `script` wins when an entry sets both.
func TestCommandKeyUpgradesToScript(t *testing.T) {
	const legacy = `
[artifacts.shots]
command = "render.sh"

[previews.demo]
command = "serve.sh"

[services.pool]
command = "pool.sh"

[tests.unit]
command = "go test ./..."
`
	cfg, err := decodeConfig([]byte(legacy))
	if err != nil {
		t.Fatalf("decodeConfig: %v", err)
	}
	for _, tc := range []struct{ name, got, want string }{
		{"artifact", cfg.Artifacts[0].Script, "render.sh"},
		{"preview", cfg.Previews[0].Script, "serve.sh"},
		{"service", cfg.Services[0].Script, "pool.sh"},
		{"test", cfg.Tests[0].Script, "go test ./..."},
	} {
		if tc.got != tc.want {
			t.Errorf("%s: Script = %q, want %q", tc.name, tc.got, tc.want)
		}
	}
	if c := cfg.Artifacts[0].LegacyCommand; c != "" {
		t.Errorf("LegacyCommand survived decode: %q", c)
	}

	path := filepath.Join(t.TempDir(), "config.toml")
	if err := SaveToFile(path, cfg); err != nil {
		t.Fatalf("SaveToFile: %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	out := string(data)
	for ln := range strings.SplitSeq(out, "\n") {
		if strings.HasPrefix(strings.TrimSpace(ln), "command =") {
			t.Errorf("saved config still writes the legacy key: %q", ln)
		}
	}
	if n := strings.Count(out, "script = "); n < 4 {
		t.Errorf("expected 4 rendered script keys, got %d:\n%s", n, out)
	}

	// script wins over a same-entry command, and the fold is idempotent.
	both, err := decodeConfig([]byte("[tests.unit]\ncommand = \"old\"\nscript = \"new\"\n"))
	if err != nil {
		t.Fatalf("decodeConfig both: %v", err)
	}
	if both.Tests[0].Script != "new" {
		t.Errorf("script should win over command, got %q", both.Tests[0].Script)
	}
}

// TestPreviewPatchViaArtifactsEntry covers the layering escape hatch: a later
// layer disabling a preview writes a plain [artifacts.<name>] table (that is how
// such overrides were always written), so Merge must route it to the preview of
// that name rather than dropping it into the artifacts list.
func TestPreviewPatchViaArtifactsEntry(t *testing.T) {
	base, err := decodeConfig([]byte("[previews.demo]\ncommand = \"run-demo.sh\"\n"))
	if err != nil {
		t.Fatalf("decodeConfig base: %v", err)
	}
	over, err := decodeConfig([]byte("[artifacts.demo]\nenabled = false\n"))
	if err != nil {
		t.Fatalf("decodeConfig over: %v", err)
	}
	base.Merge(over)

	if len(base.Previews) != 1 || base.Previews[0].IsEnabled() {
		t.Errorf("preview not disabled by the artifacts-shaped override: %+v", base.Previews)
	}
	if base.Previews[0].Script != "run-demo.sh" {
		t.Errorf("override clobbered the inherited command: %+v", base.Previews[0])
	}
	if len(base.Artifacts) != 0 {
		t.Errorf("override leaked into the artifacts list: %+v", base.Artifacts)
	}
}

func TestResolvePreviewPortRangeDefaults(t *testing.T) {
	if lo, hi := (Config{}).ResolvePreviewPortRange(); lo != 26601 || hi != 26699 {
		t.Errorf("default range = %d-%d, want 26601-26699", lo, hi)
	}
	bad := "9000-badport"
	if lo, hi := (Config{PreviewPorts: &bad}).ResolvePreviewPortRange(); lo != 26601 || hi != 26699 {
		t.Errorf("malformed range resolved to %d-%d, want default 26601-26699", lo, hi)
	}
	single := "9000"
	if lo, hi := (Config{PreviewPorts: &single}).ResolvePreviewPortRange(); lo != 9000 || hi != 9000 {
		t.Errorf("single port resolved to %d-%d, want 9000-9000", lo, hi)
	}
	for _, s := range []string{"0-10", "10-5", "1-70000", "", "a-b"} {
		if _, _, err := ParsePortRange(s); err == nil {
			t.Errorf("ParsePortRange(%q) unexpectedly succeeded", s)
		}
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
		{Name: "screenshots", Script: command, TimeoutSec: 900},
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
		"[artifacts.screenshots]",
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
	base := Config{Artifacts: []ArtifactScript{{Name: "a", Script: "x"}}}
	base.Merge(Config{Artifacts: []ArtifactScript{{Name: "b", Script: "y"}}})
	if len(base.Artifacts) != 1 || base.Artifacts[0].Name != "b" {
		t.Errorf("expected merge to replace artifacts, got %+v", base.Artifacts)
	}
	// Merging a config without artifacts leaves the existing list intact.
	base.Merge(Config{})
	if len(base.Artifacts) != 1 || base.Artifacts[0].Name != "b" {
		t.Errorf("expected artifacts preserved, got %+v", base.Artifacts)
	}
}

func TestTestsRoundTrip(t *testing.T) {
	cfg := Config{
		Tests: []TestScript{
			{Name: "go", Script: "gotestsum --junitfile $HYDRA_TEST_OUTPUT/go.xml ./...", TimeoutSec: 600},
			{Name: "web", Script: "bun vitest run", Strict: boolPtr(false), Enabled: boolPtr(false)},
		},
		TestConcurrency: intPtr(2),
	}

	path := filepath.Join(t.TempDir(), "config.toml")
	if err := SaveToFile(path, cfg); err != nil {
		t.Fatalf("SaveToFile: %v", err)
	}
	loaded, err := LoadFile(path)
	if err != nil {
		t.Fatalf("LoadFile: %v", err)
	}
	if loaded == nil || len(loaded.Tests) != 2 {
		t.Fatalf("expected 2 tests, got %+v", loaded)
	}
	if loaded.Tests[0].Name != "go" || loaded.Tests[0].TimeoutSec != 600 || !loaded.Tests[0].IsStrict() {
		t.Errorf("test[0] mismatch: %+v", loaded.Tests[0])
	}
	if loaded.Tests[1].Name != "web" || loaded.Tests[1].IsStrict() || loaded.Tests[1].IsEnabled() {
		t.Errorf("test[1] mismatch (strict/enabled should be false): %+v", loaded.Tests[1])
	}
	if loaded.ResolveTestConcurrency() != 2 {
		t.Errorf("test_concurrency = %d, want 2", loaded.ResolveTestConcurrency())
	}
}

func TestTestsMergeReplaces(t *testing.T) {
	base := Config{Tests: []TestScript{{Name: "a", Script: "x"}}}
	base.Merge(Config{Tests: []TestScript{{Name: "b", Script: "y"}}})
	if len(base.Tests) != 1 || base.Tests[0].Name != "b" {
		t.Errorf("expected merge to replace tests, got %+v", base.Tests)
	}
	base.Merge(Config{})
	if len(base.Tests) != 1 || base.Tests[0].Name != "b" {
		t.Errorf("expected tests preserved, got %+v", base.Tests)
	}
}

// TestNamedTestsDecode verifies the canonical [tests.<name>] form decodes with
// the table key as the name (an explicit name field overriding it), preserves
// document order, and marks the section named so it layer-merges by name.
func TestNamedTestsDecode(t *testing.T) {
	cfg, err := decodeConfig([]byte(`
[tests.go]
command = "go test ./..."
timeout_sec = 600
auto_run = "settled"

[tests."web lint"]
command = "eslint ."

[tests.aliased]
name = "real-name"
command = "x"
`))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !cfg.TestsNamed {
		t.Error("TestsNamed not set for named-table syntax")
	}
	if len(cfg.Tests) != 3 {
		t.Fatalf("expected 3 tests, got %+v", cfg.Tests)
	}
	if cfg.Tests[0].Name != "go" || cfg.Tests[0].TimeoutSec != 600 || cfg.Tests[0].AutoRun != "settled" {
		t.Errorf("tests[0] mismatch: %+v", cfg.Tests[0])
	}
	if cfg.Tests[1].Name != "web lint" || cfg.Tests[1].Script != "eslint ." {
		t.Errorf("tests[1] (quoted key) mismatch: %+v", cfg.Tests[1])
	}
	if cfg.Tests[2].Name != "real-name" {
		t.Errorf("explicit name field should override the key: %+v", cfg.Tests[2])
	}

	// The legacy array form still parses and is NOT marked named.
	legacy, err := decodeConfig([]byte("[[tests]]\nname = \"go\"\ncommand = \"go test ./...\"\n"))
	if err != nil {
		t.Fatalf("decode legacy: %v", err)
	}
	if legacy.TestsNamed || len(legacy.Tests) != 1 || legacy.Tests[0].Name != "go" {
		t.Errorf("legacy [[tests]] decode wrong: named=%t %+v", legacy.TestsNamed, legacy.Tests)
	}
}

// TestNamedTestsMergeByName verifies the layering rule the named syntax buys:
// entries merge by name across layers - set fields patch the same-named entry
// (a command-less enabled=false disables a runner without restating it), new
// names append, base order is preserved - while a legacy-array layer still
// replaces wholesale.
func TestNamedTestsMergeByName(t *testing.T) {
	base := Config{Tests: []TestScript{
		{Name: "go", Script: "go test ./...", TimeoutSec: 600},
		{Name: "lint", Script: "eslint ."},
	}}
	over, err := decodeConfig([]byte(`
[tests.lint]
enabled = false

[tests.e2e]
command = "playwright test"

[tests.go]
command = "go test -short ./..."
`))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	base.Merge(over)
	if len(base.Tests) != 3 {
		t.Fatalf("expected 3 tests after named merge, got %+v", base.Tests)
	}
	if base.Tests[0].Name != "go" || base.Tests[0].Script != "go test -short ./..." || base.Tests[0].TimeoutSec != 600 {
		t.Errorf("go entry not patched (command overridden, timeout inherited): %+v", base.Tests[0])
	}
	if base.Tests[1].Name != "lint" || base.Tests[1].Script != "eslint ." || base.Tests[1].IsEnabled() {
		t.Errorf("lint entry not patched (disabled, command kept): %+v", base.Tests[1])
	}
	if base.Tests[2].Name != "e2e" || base.Tests[2].Script != "playwright test" {
		t.Errorf("e2e entry not appended: %+v", base.Tests[2])
	}

	// A subsequent legacy-array layer still replaces wholesale.
	base.Merge(Config{Tests: []TestScript{{Name: "only", Script: "z"}}})
	if len(base.Tests) != 1 || base.Tests[0].Name != "only" {
		t.Errorf("legacy layer should replace wholesale, got %+v", base.Tests)
	}
}

// TestNamedArtifactsServicesMergeByName spot-checks the artifacts/services
// counterparts of TestNamedTestsMergeByName.
func TestNamedArtifactsServicesMergeByName(t *testing.T) {
	cfg := Config{
		Artifacts: []ArtifactScript{{Name: "shots", Script: "run shots", TimeoutSec: 900}},
		Services:  []ServiceScript{{Name: "emu", Script: "emu up", MaxRestarts: intPtr(3)}},
	}
	cfg.Merge(Config{
		ArtifactsNamed: true,
		Artifacts:      []ArtifactScript{{Name: "shots", Enabled: boolPtr(false)}, {Name: "vids", Script: "run vids"}},
		ServicesNamed:  true,
		Services:       []ServiceScript{{Name: "emu", Enabled: boolPtr(false)}},
	})
	if len(cfg.Artifacts) != 2 || cfg.Artifacts[0].IsEnabled() || cfg.Artifacts[0].Script != "run shots" || cfg.Artifacts[1].Name != "vids" {
		t.Errorf("artifacts named merge wrong: %+v", cfg.Artifacts)
	}
	if len(cfg.Services) != 1 || cfg.Services[0].IsEnabled() || cfg.Services[0].Script != "emu up" || *cfg.Services[0].MaxRestarts != 3 {
		t.Errorf("services named merge wrong: %+v", cfg.Services)
	}
}

// TestNamedTestsRenderRoundTrip guards that the renderer emits the canonical
// named-table form and that it decodes back identically (including a name that
// needs a quoted key).
func TestNamedTestsRenderRoundTrip(t *testing.T) {
	out := renderConfig(nil, Config{Tests: []TestScript{
		{Name: "go", Script: "go test ./...", TimeoutSec: 600},
		{Name: "web lint", Script: "eslint .", Enabled: boolPtr(false)},
	}})
	if !contains(out, "[tests.go]") || !contains(out, "[tests.\"web lint\"]") {
		t.Fatalf("expected named-table headers:\n%s", out)
	}
	if contains(out, "\n[[tests]]") {
		t.Errorf("legacy [[tests]] header still emitted:\n%s", out)
	}
	cfg, err := decodeConfig([]byte(out))
	if err != nil {
		t.Fatalf("re-decode: %v\n%s", err, out)
	}
	if !cfg.TestsNamed || len(cfg.Tests) != 2 {
		t.Fatalf("round-trip lost entries: named=%t %+v", cfg.TestsNamed, cfg.Tests)
	}
	if cfg.Tests[0].Name != "go" || cfg.Tests[0].TimeoutSec != 600 {
		t.Errorf("tests[0] mismatch: %+v", cfg.Tests[0])
	}
	if cfg.Tests[1].Name != "web lint" || cfg.Tests[1].IsEnabled() {
		t.Errorf("tests[1] mismatch: %+v", cfg.Tests[1])
	}

	// Duplicate names stay representable: the second key is uniquified and an
	// explicit name field carries the real name back through a decode.
	dup := renderConfig(nil, Config{Tests: []TestScript{
		{Name: "go", Script: "a"},
		{Name: "go", Script: "b"},
	}})
	dcfg, err := decodeConfig([]byte(dup))
	if err != nil {
		t.Fatalf("re-decode duplicates: %v\n%s", err, dup)
	}
	if len(dcfg.Tests) != 2 || dcfg.Tests[0].Name != "go" || dcfg.Tests[1].Name != "go" {
		t.Errorf("duplicate names not preserved: %+v\n%s", dcfg.Tests, dup)
	}
}

// TestPolicyMergeUnionsAndBlocks verifies the MCP allow/block lists union across
// layers (instead of a later layer shadowing an earlier one) and that the new
// block lists ride the same rules.
func TestPolicyMergeUnionsAndBlocks(t *testing.T) {
	p := PolicyConfig{
		MCPAllowed:      []string{"github"},
		MCPToolsAllowed: []string{"sentry__list_issues"},
		KnownTools:      []string{"mytool"},
	}
	p.Merge(PolicyConfig{
		MCPAllowed:      []string{"linear", "github"}, // github is a duplicate
		MCPBlocked:      []string{"playwright"},
		MCPToolsBlocked: []string{"github__delete_repo"},
		KnownTools:      []string{"othertool"},
	})
	eq := func(name string, got, want []string) {
		if strings.Join(got, ",") != strings.Join(want, ",") {
			t.Errorf("%s = %v, want %v", name, got, want)
		}
	}
	eq("MCPAllowed", p.MCPAllowed, []string{"github", "linear"})
	eq("MCPToolsAllowed", p.MCPToolsAllowed, []string{"sentry__list_issues"})
	eq("MCPBlocked", p.MCPBlocked, []string{"playwright"})
	eq("MCPToolsBlocked", p.MCPToolsBlocked, []string{"github__delete_repo"})
	eq("KnownTools", p.KnownTools, []string{"mytool", "othertool"})
}

// TestArtifactsAndTestsCoexist guards that [[artifacts]] and [[tests]] blocks in
// the same file are decoded into their own slices (the array-table router keys on
// the header name, so they must not bleed into each other).
func TestArtifactsAndTestsCoexist(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	content := []byte(`
[[artifacts]]
name = "shots"
command = "shot"

[[tests]]
name = "go"
command = "go test ./..."
`)
	arts, err := ArtifactsAtProjectTOML(content)
	if err != nil {
		t.Fatalf("ArtifactsAtProjectTOML: %v", err)
	}
	tests, err := TestsAtProjectTOML(content)
	if err != nil {
		t.Fatalf("TestsAtProjectTOML: %v", err)
	}
	if len(arts) != 1 || arts[0].Name != "shots" {
		t.Errorf("artifacts = %+v", arts)
	}
	if len(tests) != 1 || tests[0].Name != "go" || tests[0].Script != "go test ./..." {
		t.Errorf("tests = %+v", tests)
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
	if got[0].Name != "home" || got[0].Script != "shot home" {
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
		{Name: "shots", Script: "bun newshots.ts", TimeoutSec: 120},
		{Name: "extra", Script: "echo hi"},
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
	if loaded.Artifacts[0].Name != "shots" || loaded.Artifacts[0].Script != "bun newshots.ts" || loaded.Artifacts[0].TimeoutSec != 120 {
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
	if !strings.Contains(out, "# [artifacts.screenshots]") {
		t.Errorf("commented example should appear after clearing:\n%s", out)
	}
}

// TestStrictDefaultAndRoundTrip checks that strict defaults to on (absent flag)
// and that an explicit strict = false survives a render→decode round-trip for
// both artifacts and services (so a UI/file opt-out is not silently dropped).
func TestStrictDefaultAndRoundTrip(t *testing.T) {
	// Default: an absent flag means strict.
	if !(ArtifactScript{}).IsStrict() {
		t.Error("artifact with no strict flag should be strict by default")
	}
	if !(ServiceScript{}).IsStrict() {
		t.Error("service with no strict flag should be strict by default")
	}
	if (ArtifactScript{Strict: boolPtr(false)}).IsStrict() {
		t.Error("strict = false must disable strict mode")
	}

	cfg := Config{
		Artifacts: []ArtifactScript{
			{Name: "lenient", Script: "bun shots.ts", Strict: boolPtr(false)},
			{Name: "strict-default", Script: "make docs"},
		},
		Services: []ServiceScript{
			{Name: "lenient-svc", Script: "run.sh", Strict: boolPtr(false)},
		},
	}
	out := renderConfig(nil, cfg)
	if !strings.Contains(out, "strict = false") {
		t.Fatalf("strict = false not rendered:\n%s", out)
	}
	loaded, err := decodeConfig([]byte(out))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(loaded.Artifacts) != 2 || loaded.Artifacts[0].IsStrict() {
		t.Errorf("artifact strict = false lost on round-trip: %+v", loaded.Artifacts)
	}
	// The strict-by-default artifact has no flag written, so it stays strict.
	if loaded.Artifacts[1].Strict != nil || !loaded.Artifacts[1].IsStrict() {
		t.Errorf("strict-default artifact should keep an absent flag: %+v", loaded.Artifacts[1])
	}
	if len(loaded.Services) != 1 || loaded.Services[0].IsStrict() {
		t.Errorf("service strict = false lost on round-trip: %+v", loaded.Services)
	}
}

func TestArtifactPrefetchRender(t *testing.T) {
	boolp := func(b bool) *bool { return &b }

	// An explicit value is written authoritatively and round-trips.
	out := renderConfig(nil, Config{ArtifactPrefetch: boolp(false)})
	if !strings.Contains(out, "artifact_prefetch = false") {
		t.Errorf("expected explicit value, got:\n%s", out)
	}
	loaded, err := decodeConfig([]byte(out))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if loaded.ArtifactPrefetch == nil || *loaded.ArtifactPrefetch || loaded.IsArtifactPrefetchEnabled() {
		t.Errorf("want disabled, got %v", loaded.ArtifactPrefetch)
	}

	// Unset (nil) resolves to enabled and renders the commented default.
	def := renderConfig(nil, Config{ArtifactPrefetch: nil})
	if !strings.Contains(def, "# artifact_prefetch = true") {
		t.Errorf("unset should re-emit the commented default:\n%s", def)
	}
	loadedDef, err := decodeConfig([]byte(def))
	if err != nil {
		t.Fatalf("decode default: %v", err)
	}
	if loadedDef.ArtifactPrefetch != nil || !loadedDef.IsArtifactPrefetchEnabled() {
		t.Errorf("unset should resolve to enabled, got %v", loadedDef.ArtifactPrefetch)
	}

	// Unlike artifact_concurrency, a save that doesn't carry artifact_prefetch (cfg
	// nil - the Settings editor has no field for it) PRESERVES the file's existing
	// hand-edited value rather than resetting it.
	const existing = `artifact_prefetch = false
`
	preserved := renderConfig([]byte(existing), Config{ArtifactPrefetch: nil})
	loadedP, err := decodeConfig([]byte(preserved))
	if err != nil {
		t.Fatalf("decode preserved: %v", err)
	}
	if loadedP.ArtifactPrefetch == nil || *loadedP.ArtifactPrefetch {
		t.Errorf("a save that omits artifact_prefetch should preserve the existing false, got %v:\n%s", loadedP.ArtifactPrefetch, preserved)
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
	// preserved - the line is re-emitted commented-out, so a later load falls back
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
		// Artifacts + previews documentation and commented examples are always present.
		docPrefix + " [artifacts.<name>]:",
		"# [artifacts.screenshots]",
		"# node scripts/take-screenshots.ts",
		docPrefix + " [previews.<name>]:",
		"# [previews.app]",
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

// TestSandboxConfigMergeUnionsPathLists verifies the path lists union across
// config layers (like the network host lists) instead of a later layer replacing
// an earlier one - so machine-wide caches in the user config survive a project
// that sets its own list. Duplicates are dropped, order preserved.
func TestSandboxConfigMergeUnionsPathLists(t *testing.T) {
	base := SandboxConfig{
		WritablePaths: []string{"~/.cache", "~/.npm"},
		MaskedPaths:   []string{"~/.ssh"},
		RestoreRO:     []string{"~/.config/git"},
		CowPaths:      []string{"pipeline/out"},
		InheritEnv:    []string{"ANDROID_HOME"},
	}
	base.Merge(SandboxConfig{
		WritablePaths: []string{"~/.npm", "~/.gradle"}, // ~/.npm is a duplicate
		MaskedPaths:   []string{"~/.aws"},
		RestoreRO:     []string{"~/.config/gh"},
		CowPaths:      []string{"~/.gradle"},
		InheritEnv:    []string{"ANDROID_HOME", "SSH_AUTH_SOCK"},
	})

	eq := func(name string, got, want []string) {
		if strings.Join(got, ",") != strings.Join(want, ",") {
			t.Errorf("%s = %v, want %v", name, got, want)
		}
	}
	eq("WritablePaths", base.WritablePaths, []string{"~/.cache", "~/.npm", "~/.gradle"})
	eq("MaskedPaths", base.MaskedPaths, []string{"~/.ssh", "~/.aws"})
	eq("RestoreRO", base.RestoreRO, []string{"~/.config/git", "~/.config/gh"})
	eq("CowPaths", base.CowPaths, []string{"pipeline/out", "~/.gradle"})
	eq("InheritEnv", base.InheritEnv, []string{"ANDROID_HOME", "SSH_AUTH_SOCK"})
}

// TestAgentConfigMergePrePromptUnions verifies pre-prompts union across config
// layers, joined by a blank line: a project layer's pre_prompt appends to the
// user layer's instead of replacing it. Empty/nil inherits; an identical value
// is not doubled.
func TestAgentConfigMergePrePromptUnions(t *testing.T) {
	str := func(s string) *string { return &s }
	get := func(a AgentConfig) string {
		if a.PrePrompt == nil {
			return "<nil>"
		}
		return *a.PrePrompt
	}

	// Both layers set: joined with a blank line.
	a := AgentConfig{PrePrompt: str("user rules")}
	a.Merge(AgentConfig{PrePrompt: str("project rules")})
	if got := get(a); got != "user rules\n\nproject rules" {
		t.Errorf("joined = %q", got)
	}

	// Later layer nil or empty: inherits.
	a = AgentConfig{PrePrompt: str("user rules")}
	a.Merge(AgentConfig{})
	a.Merge(AgentConfig{PrePrompt: str("")})
	if got := get(a); got != "user rules" {
		t.Errorf("after nil/empty merges = %q", got)
	}

	// Earlier layer unset: later layer's value is taken as-is.
	a = AgentConfig{}
	a.Merge(AgentConfig{PrePrompt: str("project rules")})
	if got := get(a); got != "project rules" {
		t.Errorf("onto unset = %q", got)
	}

	// Identical text in both layers: not doubled.
	a = AgentConfig{PrePrompt: str("same")}
	a.Merge(AgentConfig{PrePrompt: str("same")})
	if got := get(a); got != "same" {
		t.Errorf("identical = %q", got)
	}
}
