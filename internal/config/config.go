package config

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"braces.dev/errtrace"
	"github.com/BurntSushi/toml"
	"github.com/pelletier/go-toml/v2/unstable"
	"github.com/trolleyman/hydra/internal/sandbox"
)

// DefaultPrePrompt is the built-in pre-prompt delivered to every agent as a
// system prompt (not as part of the user's task prompt). The placeholders
// <branch> and <base-branch> are substituted at spawn time.
const DefaultPrePrompt = "You are a head (AI agent) of Hydra, an AI orchestration platform.\n" +
	"\n" +
	"## Environment\n" +
	"- You are running inside a locked-down OS sandbox on a dedicated git worktree, as the host user.\n" +
	"- You MUST work in this worktree, not the main repository.\n" +
	"- You have read access to the host, write access to your worktree and the developer caches; credential locations are masked.\n" +
	"- The current branch is `<branch>` and it targets `<base-branch>`.\n" +
	"\n" +
	"## Sandbox rules\n" +
	"- You MAY install project-local dependencies scoped to your worktree — e.g. `bun install` / `bun add`, a local virtualenv, or dev tools fetched into the checkout. Do NOT install system- or user-global software: no `apt` or other system package managers, no global/`-g` installs, no changes to host-wide toolchains or shared caches outside your worktree. If a task needs a global/system tool that isn't already present, STOP and ask the user.\n" +
	"- Respect shared-machine resources, especially ports. Other agents and jobs run on this same host, so do NOT assume well-known ports (3000, 5173, 8080, 9222, …) are free or yours: bind servers to a custom/non-default port on localhost — ideally let the OS pick a free one — and shut the process down when you're done.\n" +
	"- Don't reach out and drive host-OS applications or devices — e.g. the host's Google Chrome, Android `adb`, system services, or other users' processes. If you need a browser or similar tool, use a project-local/bundled one inside your worktree. Keep your effects confined to the sandbox + worktree.\n" +
	"- Do NOT try to escape, weaken, or probe the sandbox (e.g. remounting paths, reading masked credentials, disabling seccomp, or reaching blocked hosts). The sandbox is a security boundary — treat it as fixed.\n" +
	"- Do NOT operate Hydra itself. You are a head running *inside* Hydra; you must not spawn, kill, merge, attach, or resume heads, run the `hydra` CLI or `hydrad` daemon, or talk to its control socket. Managing heads is the user's job, not yours — even if a task seems to call for it, stop and ask the user.\n" +
	"- If you need something the environment does not provide — a system/global tool installed, a path made writable, network access, etc. — STOP and ask the user to change it for you. Do not work around it.\n" +
	"\n" +
	"## What the user can change for you\n" +
	"The user controls your sandbox through Hydra's config (the per-agent `[<agent>.sandbox]` section of config.toml, editable in the web UI). When you need an environment change, tell the user exactly which setting to adjust and why:\n" +
	"- `writable_paths` — extra paths made writable inside the sandbox.\n" +
	"- `masked_paths` — extra paths hidden inside the sandbox.\n" +
	"- `restore_ro` — paths re-exposed read-only after a parent was masked.\n" +
	"- `cow_paths` — worktree-relative paths mounted copy-on-write from the project root (you can read and overwrite them; writes stay in your worktree and never touch the real files).\n" +
	"- `network.enabled` / `network.allowed_hosts` — outbound network access and its host allow-list.\n" +
	"- `pre_spawn_script` — a bash script run inside the sandbox once, when the agent is first spawned (e.g. `mise trust`).\n" +
	"- `pre_prompt` — the standing instructions you are reading now.\n" +
	"\n" +
	"## Workflow\n" +
	"- As you work, use git commit to save your progress at logical points.\n" +
	"- Once you have finished the task, make a final git commit with all remaining changes.\n" +
	"- Do *not* use git push or git pull.\n" +
	"- Try not to bother the user with requests unless necessary.\n" +
	"- If there are any design decisions made without user input, document them in each commit."

// NetworkConfig is the per-agent network policy.
type NetworkConfig struct {
	// Enabled toggles outbound network access. nil = inherit/default (enabled).
	Enabled *bool `toml:"enabled"`
	// AllowedHosts is reserved for a future proxy-based host allow-list.
	AllowedHosts []string `toml:"allowed_hosts"`
}

// SandboxConfig holds user-editable sandbox policy. All path lists are additive
// on top of the baked-in defaults (sandbox.Defaults()).
type SandboxConfig struct {
	// WritablePaths are extra paths made writable inside the sandbox.
	WritablePaths []string `toml:"writable_paths"`
	// MaskedPaths are extra paths hidden inside the sandbox.
	MaskedPaths []string `toml:"masked_paths"`
	// RestoreRO re-exposes paths read-only after masking their parent.
	RestoreRO []string `toml:"restore_ro"`
	// CowPaths are worktree-relative paths mounted copy-on-write: the agent sees
	// the same path under the project root (read-only) and may overwrite it, but
	// writes land in a per-head layer and never touch the real files. Useful for
	// large gitignored build inputs/outputs that are too big to copy. See
	// sandbox.CowMount; on Linux this needs an overlay-capable bwrap.
	CowPaths []string `toml:"cow_paths"`
	// Network is the network policy.
	Network *NetworkConfig `toml:"network"`
	// PreSpawnScript is an optional shell script run inside the sandbox
	// immediately before each agent is launched (e.g. `mise trust` or other
	// arbitrary setup). It runs via /bin/sh in the agent's worktree with the
	// same environment and confinement as the agent. nil/empty = no script.
	PreSpawnScript *string `toml:"pre_spawn_script"`
}

// AgentConfig holds per-agent-type configuration.
type AgentConfig struct {
	// Sandbox overrides sandbox policy for this agent type.
	Sandbox *SandboxConfig `toml:"sandbox"`
	// PrePrompt is prepended to every agent prompt.
	PrePrompt *string `toml:"pre_prompt"`
}

// ArtifactScript describes a per-project command that generates visual
// artifacts (e.g. screenshots) for a checkout of the repository. The diff
// viewer runs it against both sides of a comparison and shows the outputs that
// differ. See internal/artifacts for the runner.
//
// Contract: the command is run with the checkout directory as its working
// directory and these environment variables set:
//   - HYDRA_ARTIFACT_OUTPUT: directory the script must write image files into
//   - HYDRA_ARTIFACT_SOURCE: the checkout directory (same as cwd)
//   - HYDRA_ARTIFACT_REF:    the resolved git ref/sha being rendered (best-effort)
type ArtifactScript struct {
	// Name uniquely identifies the script; used as the UI label and cache dir.
	Name string `toml:"name"`
	// Command is the shell command run (via `sh -c`) in the checkout directory.
	Command string `toml:"command"`
	// TimeoutSec bounds how long the command may run (0 = default, see artifacts).
	TimeoutSec int `toml:"timeout_sec"`
	// UnsafeHost, when true, runs the command directly on the host with NO
	// sandbox — full access to the user's credentials, network, and machine.
	// Default false (the command is confined like an agent). Only enable for a
	// self-contained, audited command when you trust every ref you will ever
	// compare: the command executes the *diffed ref's* code (build tooling,
	// package lifecycle scripts, the script file itself), and "trusted config"
	// authorizes only which command runs — not the contents of the checkout it
	// runs against. Heavy build scripts are the most tempted to set this and the
	// ones running the most untrusted code; prefer leaving it off.
	UnsafeHost bool `toml:"unsafe_host"`
}

type Config struct {
	// Defaults for all agents.
	Defaults AgentConfig `toml:"defaults"`
	// Per-agent overrides (e.g. claude, gemini).
	Agents map[string]AgentConfig `toml:"agents"`
	// Artifacts are per-project visual-artifact generation scripts.
	Artifacts []ArtifactScript `toml:"artifacts"`
}

// rawConfig is the intermediate decode target. It accepts BOTH the legacy
// nested layout ([defaults], [defaults.sandbox], [agents.<name>]) and the new
// flattened layout (top-level pre_prompt/[sandbox], and one top-level table per
// agent, e.g. [claude]). decodeConfig folds it into a Config. The dynamic agent
// tables of the new layout are not fields here — they are captured separately
// via toml.Primitive (any top-level table whose name is not reserved).
type rawConfig struct {
	// Legacy layout.
	Defaults *AgentConfig           `toml:"defaults"`
	Agents   map[string]AgentConfig `toml:"agents"`
	// New flattened defaults (top level).
	PrePrompt *string        `toml:"pre_prompt"`
	Sandbox   *SandboxConfig `toml:"sandbox"`
	// Shared.
	Artifacts []ArtifactScript `toml:"artifacts"`
}

// reservedTopLevel are the top-level TOML names that are NOT agent tables. Any
// other top-level table is treated as an agent override, so new agent types
// need no code change. Consequently an agent literally named one of these is
// unrepresentable in the flattened layout — fine for real agent types
// (claude/gemini/bash/copilot).
var reservedTopLevel = map[string]bool{
	"defaults": true, "agents": true,
	"pre_prompt": true, "sandbox": true, "artifacts": true,
}

// GetUserConfigPath returns the path to the global user configuration file.
func GetUserConfigPath() (string, error) {
	configDir, err := os.UserConfigDir()
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	return filepath.Join(configDir, "hydra", "config.toml"), nil
}

// GetProjectConfigPath returns the path to the project-specific configuration file.
func GetProjectConfigPath(projectRoot string) string {
	return filepath.Join(projectRoot, ".hydra", "config.toml")
}

// ReadProjectConfigTOML returns the raw bytes of the project's .hydra/config.toml
// and whether the file exists. An absent file is (nil, false, nil) — not an error.
// The raw bytes (rather than the parsed config) are what the UI shows the user
// when they open a project, so they can review what they're about to run.
func ReadProjectConfigTOML(projectRoot string) ([]byte, bool, error) {
	if projectRoot == "" {
		return nil, false, nil
	}
	data, err := os.ReadFile(GetProjectConfigPath(projectRoot))
	if os.IsNotExist(err) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, errtrace.Wrap(err)
	}
	return data, true, nil
}

// LoadInternalDefaults returns the hardcoded internal default configuration.
// Note: DefaultPrePrompt is not stored here — it is always prepended by BuildFinalPrePrompt.
func LoadInternalDefaults() Config {
	return Config{}
}

// BuildFinalPrePrompt constructs the final pre-prompt for an agent by merging:
// 1. The built-in DefaultPrePrompt (always first)
// 2. The configured defaults pre-prompt (if set)
// 3. The agent-specific pre-prompt (if set)
// The result ends with "\n\nTask:\n" to separate the pre-prompt from the user task.
// Note: <branch> and <base-branch> placeholders are substituted by the caller.
func BuildFinalPrePrompt(cfg Config, agentType string) string {
	parts := []string{DefaultPrePrompt}
	if cfg.Defaults.PrePrompt != nil && *cfg.Defaults.PrePrompt != "" {
		parts = append(parts, *cfg.Defaults.PrePrompt)
	}
	if agentCfg, ok := cfg.Agents[agentType]; ok && agentCfg.PrePrompt != nil && *agentCfg.PrePrompt != "" {
		parts = append(parts, *agentCfg.PrePrompt)
	}
	return strings.Join(parts, "\n") + "\n\nTask:\n"
}

// decodeConfig parses config.toml content, accepting BOTH the legacy nested
// layout ([defaults]/[defaults.sandbox]/[agents.<name>]) and the new flattened
// layout (top-level pre_prompt/[sandbox], one top-level table per agent). Empty
// content decodes to a zero Config (not an error).
func decodeConfig(data []byte) (Config, error) {
	var cfg Config
	if len(strings.TrimSpace(string(data))) == 0 {
		return cfg, nil
	}

	// Pass 1: enumerate every top-level name as a primitive so we can find the
	// new-layout agent tables (any name that is not reserved).
	var prims map[string]toml.Primitive
	md, err := toml.Decode(string(data), &prims)
	if err != nil {
		return cfg, errtrace.Wrap(err)
	}
	// Pass 2: decode the reserved keys with their full nested typing.
	var raw rawConfig
	if _, err := toml.Decode(string(data), &raw); err != nil {
		return cfg, errtrace.Wrap(err)
	}

	cfg.Artifacts = raw.Artifacts

	// Defaults: legacy [defaults] first, then the new top-level fields win.
	if raw.Defaults != nil {
		cfg.Defaults = *raw.Defaults
	}
	if raw.PrePrompt != nil {
		cfg.Defaults.PrePrompt = raw.PrePrompt
	}
	if raw.Sandbox != nil {
		cfg.Defaults.Sandbox = raw.Sandbox
	}

	// Agents: legacy [agents.*] map, then every non-reserved top-level table.
	if raw.Agents != nil {
		cfg.Agents = raw.Agents
	}
	for name := range prims {
		if reservedTopLevel[name] {
			continue
		}
		var ac AgentConfig
		if err := md.PrimitiveDecode(prims[name], &ac); err != nil {
			return cfg, errtrace.Wrap(fmt.Errorf("decode agent %q: %w", name, err))
		}
		if cfg.Agents == nil {
			cfg.Agents = make(map[string]AgentConfig)
		}
		cfg.Agents[name] = ac
	}

	return cfg, nil
}

// LoadFile loads a configuration from a file.
func LoadFile(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	cfg, err := decodeConfig(data)
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("load config: %s: %w", path, err))
	}
	return &cfg, nil
}

// Merge merges another configuration into this one.
func (c *Config) Merge(other Config) {
	c.Defaults.Merge(other.Defaults)

	if other.Agents != nil {
		if c.Agents == nil {
			c.Agents = make(map[string]AgentConfig)
		}
		for name, otherAgent := range other.Agents {
			agent := c.Agents[name]
			agent.Merge(otherAgent)
			c.Agents[name] = agent
		}
	}

	// Artifact scripts are replaced wholesale when the other config sets any.
	if other.Artifacts != nil {
		c.Artifacts = other.Artifacts
	}
}

// clone returns a deep-enough copy of the AgentConfig that Merge can mutate it
// without touching the original's nested Sandbox/Network structs. (Merge replaces
// slices and the PrePrompt/PreSpawnScript pointers wholesale, so only the Sandbox
// and Network structs need fresh copies.)
func (a AgentConfig) clone() AgentConfig {
	out := a
	if a.Sandbox != nil {
		sb := *a.Sandbox
		if a.Sandbox.Network != nil {
			n := *a.Sandbox.Network
			sb.Network = &n
		}
		out.Sandbox = &sb
	}
	return out
}

// Merge merges another AgentConfig into this one.
func (a *AgentConfig) Merge(other AgentConfig) {
	if other.Sandbox != nil {
		if a.Sandbox == nil {
			a.Sandbox = &SandboxConfig{}
		}
		a.Sandbox.Merge(*other.Sandbox)
	}
	if other.PrePrompt != nil {
		a.PrePrompt = other.PrePrompt
	}
}

// Merge merges another SandboxConfig into this one (path lists are replaced,
// not concatenated, when set; nil leaves the existing value).
func (s *SandboxConfig) Merge(other SandboxConfig) {
	if other.WritablePaths != nil {
		s.WritablePaths = other.WritablePaths
	}
	if other.MaskedPaths != nil {
		s.MaskedPaths = other.MaskedPaths
	}
	if other.RestoreRO != nil {
		s.RestoreRO = other.RestoreRO
	}
	if other.CowPaths != nil {
		s.CowPaths = other.CowPaths
	}
	if other.Network != nil {
		if s.Network == nil {
			s.Network = &NetworkConfig{}
		}
		if other.Network.Enabled != nil {
			s.Network.Enabled = other.Network.Enabled
		}
		if other.Network.AllowedHosts != nil {
			s.Network.AllowedHosts = other.Network.AllowedHosts
		}
	}
	if other.PreSpawnScript != nil {
		s.PreSpawnScript = other.PreSpawnScript
	}
}

// Load loads the merged configuration for a project.
func Load(projectRoot string) (Config, error) {
	cfg := LoadInternalDefaults()

	// 1. User config
	userPath, err := GetUserConfigPath()
	if err == nil {
		userCfg, err := LoadFile(userPath)
		if err == nil && userCfg != nil {
			cfg.Merge(*userCfg)
		}
	}

	// 2. Project config
	if projectRoot != "" {
		projectPath := GetProjectConfigPath(projectRoot)
		projectCfg, err := LoadFile(projectPath)
		if err != nil {
			return Config{}, errtrace.Wrap(err)
		}
		if projectCfg != nil {
			cfg.Merge(*projectCfg)
		}
	}

	return cfg, nil
}

// ArtifactsAtProjectTOML resolves the [[artifacts]] scripts that apply when the
// project's .hydra/config.toml holds the given content. It mirrors Load's merge
// order (internal defaults, then user config, then project), so it can be used
// to load the artifact scripts exactly as they existed at a specific git ref by
// passing that ref's config.toml content (an empty/absent file inherits the user
// config's artifacts, just like the live path). Project config that fails to
// parse returns an error.
func ArtifactsAtProjectTOML(content []byte) ([]ArtifactScript, error) {
	cfg := LoadInternalDefaults()

	// User config (best-effort, matching Load).
	if userPath, err := GetUserConfigPath(); err == nil {
		if userCfg, err := LoadFile(userPath); err == nil && userCfg != nil {
			cfg.Merge(*userCfg)
		}
	}

	projectCfg, err := decodeConfig(content)
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("parse project config: %w", err))
	}
	cfg.Merge(projectCfg)

	return cfg.Artifacts, nil
}

// GetResolvedConfig returns the fully resolved AgentConfig for a specific agent type.
func (c Config) GetResolvedConfig(agentType string) AgentConfig {
	resolved := c.Defaults.clone()

	if agentCfg, ok := c.Agents[agentType]; ok {
		resolved.Merge(agentCfg)
	}

	return resolved
}

// ResolveSandboxOptions merges the baked-in sandbox defaults with the resolved
// per-agent config into concrete path lists + network policy. User config is
// additive for the path lists.
func (c Config) ResolveSandboxOptions(agentType string) (writable, masked, restore, cow []string, net sandbox.NetworkPolicy, preSpawn string) {
	def := sandbox.Defaults()
	writable = append([]string{}, def.WritablePaths...)
	masked = append([]string{}, def.MaskedPaths...)
	restore = append([]string{}, def.RestoreRO...)
	net = sandbox.NetworkPolicy{Enabled: true}

	resolved := c.GetResolvedConfig(agentType)
	if sb := resolved.Sandbox; sb != nil {
		writable = append(writable, sb.WritablePaths...)
		masked = append(masked, sb.MaskedPaths...)
		restore = append(restore, sb.RestoreRO...)
		cow = append(cow, sb.CowPaths...)
		if sb.Network != nil {
			if sb.Network.Enabled != nil {
				net.Enabled = *sb.Network.Enabled
			}
			net.AllowedHosts = sb.Network.AllowedHosts
		}
		if sb.PreSpawnScript != nil {
			preSpawn = *sb.PreSpawnScript
		}
	}
	return writable, masked, restore, cow, net, preSpawn
}

// Save saves a configuration to the project-specific configuration file.
func Save(projectRoot string, cfg Config) error {
	return errtrace.Wrap(SaveToFile(GetProjectConfigPath(projectRoot), cfg))
}

// SaveToFile saves a configuration to the given file path. It reads any
// existing file first and renders on top of it, so hand-written comments and
// unmanaged content (e.g. [[artifacts]] blocks) survive the round-trip and a
// legacy-format file is migrated to the new flattened layout.
func SaveToFile(path string, cfg Config) error {
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return errtrace.Wrap(fmt.Errorf("create config parent: %s: %w", path, err))
	}
	existing, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return errtrace.Wrap(fmt.Errorf("read existing config: %s: %w", path, err))
	}
	content := renderConfig(existing, cfg)
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		return errtrace.Wrap(fmt.Errorf("save config: %s: %w", path, err))
	}
	return nil
}

// tomlStringValue returns the TOML value representation of a string.
// Multi-line strings are encoded using triple-quoted """ syntax.
func tomlStringValue(s string) string {
	if strings.Contains(s, "\n") {
		escaped := strings.ReplaceAll(s, `\`, `\\`)
		escaped = strings.ReplaceAll(escaped, `"""`, `\"\"\"`)
		return `"""` + "\n" + escaped + `"""`
	}
	escaped := strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(s)
	return `"` + escaped + `"`
}

// tomlStringArray renders a string slice as a TOML inline array.
func tomlStringArray(vals []string) string {
	parts := make([]string, len(vals))
	for i, v := range vals {
		parts[i] = tomlStringValue(v)
	}
	return "[" + strings.Join(parts, ", ") + "]"
}

// docPrefix marks Hydra-generated documentation comment lines. Using a distinct
// prefix ("##" — a doubled comment marker, rendered above each setting) lets the
// renderer recognise and replace its own docs on every save — so they update when
// Hydra updates — while leaving the user's own single-"#" comments untouched.
const docPrefix = "##"

// legacyDocPrefixes are the earlier docPrefix spellings ("# :" then "#:"). They
// are still recognised when reading so older files have their doc lines replaced
// (not duplicated) on the next render.
var legacyDocPrefixes = []string{"# :", "#:"}

// specEntry describes one managed default setting for the self-documenting
// writer. The set of entries is the single source of truth for which default
// settings exist, their order, their documentation, and the commented-out
// default shown when they are unset.
type specEntry struct {
	table string // "" (root), "sandbox", or "sandbox.network"
	key   string
	doc   string        // one-line documentation (no leading marker)
	def   func() string // TOML value text shown commented-out when unset
	// get returns the TOML value text and whether the setting is set in cfg.
	get func(AgentConfig) (string, bool)
}

// sandboxSlice builds a get func for a []string sandbox field.
func sandboxSlice(pick func(*SandboxConfig) []string) func(AgentConfig) (string, bool) {
	return func(a AgentConfig) (string, bool) {
		if a.Sandbox == nil {
			return "", false
		}
		v := pick(a.Sandbox)
		if len(v) == 0 {
			return "", false
		}
		return tomlStringArray(v), true
	}
}

// defaultsSpec is the ordered, declarative description of the managed default
// settings. Root scalars come first because TOML requires root keys to precede
// any table header. Adding an entry here makes it appear (commented-out) on the
// next render of any existing file — the "intelligent update" behaviour.
func defaultsSpec() []specEntry {
	return []specEntry{
		{
			table: "", key: "pre_prompt",
			doc: "extra instructions appended to every agent's system prompt.",
			def: func() string { return `""` },
			get: func(a AgentConfig) (string, bool) {
				if a.PrePrompt != nil {
					return tomlStringValue(*a.PrePrompt), true
				}
				return "", false
			},
		},
		{
			table: "sandbox", key: "writable_paths",
			doc: "extra paths made writable in the sandbox (added to the built-in defaults).",
			def: func() string { return tomlStringArray(sandbox.Defaults().WritablePaths) },
			get: sandboxSlice(func(s *SandboxConfig) []string { return s.WritablePaths }),
		},
		{
			table: "sandbox", key: "masked_paths",
			doc: "extra paths hidden in the sandbox (added to the built-in defaults).",
			def: func() string { return tomlStringArray(sandbox.Defaults().MaskedPaths) },
			get: sandboxSlice(func(s *SandboxConfig) []string { return s.MaskedPaths }),
		},
		{
			table: "sandbox", key: "restore_ro",
			doc: "paths re-exposed read-only after a masked parent (added to the built-in defaults).",
			def: func() string { return tomlStringArray(sandbox.Defaults().RestoreRO) },
			get: sandboxSlice(func(s *SandboxConfig) []string { return s.RestoreRO }),
		},
		{
			table: "sandbox", key: "cow_paths",
			doc: "worktree-relative paths mounted copy-on-write from the project root (read source, writes kept per-head; e.g. large gitignored build dirs).",
			def: func() string { return "[]" },
			get: sandboxSlice(func(s *SandboxConfig) []string { return s.CowPaths }),
		},
		{
			table: "sandbox", key: "pre_spawn_script",
			doc: "shell script run in the sandbox once before each agent launches (e.g. mise trust).",
			def: func() string { return `""` },
			get: func(a AgentConfig) (string, bool) {
				if a.Sandbox != nil && a.Sandbox.PreSpawnScript != nil && *a.Sandbox.PreSpawnScript != "" {
					return tomlStringValue(*a.Sandbox.PreSpawnScript), true
				}
				return "", false
			},
		},
		{
			table: "sandbox.network", key: "enabled",
			doc: "allow outbound network access from the sandbox (default true).",
			def: func() string { return "true" },
			get: func(a AgentConfig) (string, bool) {
				if a.Sandbox != nil && a.Sandbox.Network != nil && a.Sandbox.Network.Enabled != nil {
					return fmt.Sprintf("%t", *a.Sandbox.Network.Enabled), true
				}
				return "", false
			},
		},
		{
			table: "sandbox.network", key: "allowed_hosts",
			doc: "reserved for a future proxy-based outbound host allow-list.",
			def: func() string { return "[]" },
			get: func(a AgentConfig) (string, bool) {
				if a.Sandbox != nil && a.Sandbox.Network != nil && len(a.Sandbox.Network.AllowedHosts) > 0 {
					return tomlStringArray(a.Sandbox.Network.AllowedHosts), true
				}
				return "", false
			},
		},
	}
}

// managedKeySet returns the set of setting keys the renderer owns. A commented
// assignment of one of these (e.g. "# masked_paths = [...]") in an existing file
// is recognised as a regenerated default and dropped before re-rendering.
func managedKeySet() map[string]bool {
	m := map[string]bool{}
	for _, e := range defaultsSpec() {
		m[e.key] = true
	}
	return m
}

// artifactsDocLines is the Hydra-owned documentation block emitted before the
// [[artifacts]] section. Like every doc block it uses docPrefix, so it is
// replaced (kept current) on each save.
func artifactsDocLines() []string {
	return []string{
		docPrefix + " [[artifacts]]: per-project commands that render visual artifacts (e.g. screenshots)",
		docPrefix + " of a checkout. The diff viewer runs each against both sides of a comparison and",
		docPrefix + " shows the outputs that differ. Fields:",
		docPrefix + "   name         unique label, also used as the cache directory (required).",
		docPrefix + "   command      shell command run via `sh -c` in the checkout directory (required).",
		docPrefix + "   timeout_sec  max seconds the command may run (0 = built-in default).",
		docPrefix + "   unsafe_host  run on the host with NO sandbox — full access to your machine and",
		docPrefix + "                credentials; only for audited, self-contained commands (default false).",
		docPrefix + " The command is given: HYDRA_ARTIFACT_OUTPUT (directory to write images into),",
		docPrefix + " HYDRA_ARTIFACT_SOURCE (the checkout dir), HYDRA_ARTIFACT_REF (the resolved ref).",
		docPrefix + " Tags: alongside an image foo.png the command may write a JSON sidecar foo.png.meta",
		docPrefix + ` like {"tags": ["theme::dark", "viewport::phone"]}. The diff viewer shows these as`,
		docPrefix + " labels and offers a filter. A \"category::value\" tag is a scoped label: only one",
		docPrefix + " value per category is kept (the last one wins); plain tags are free-form.",
	}
}

// artifactsExampleLines is a commented-out example shown when no artifacts exist.
func artifactsExampleLines() []string {
	return []string{
		"# [[artifacts]]",
		`# name = "screenshots"`,
		`# command = "bun run screenshots.ts"`,
		"# timeout_sec = 900",
	}
}

// artifactComments holds the user-written comments preserved across a save for a
// single artifact, keyed by its name: lines before the [[artifacts]] header and
// comment lines inside the block.
type artifactComments struct {
	leading  []string
	interior []string
}

// artifactFieldLines renders the field assignments of one artifact.
func artifactFieldLines(a ArtifactScript) []string {
	out := []string{
		"name = " + tomlStringValue(a.Name),
		"command = " + tomlStringValue(a.Command),
	}
	if a.TimeoutSec > 0 {
		out = append(out, fmt.Sprintf("timeout_sec = %d", a.TimeoutSec))
	}
	if a.UnsafeHost {
		out = append(out, "unsafe_host = true")
	}
	return out
}

// emitArtifactsAuthoritative renders arts as the source of truth, preserving any
// hand-written comments matched to an existing artifact by name. An empty list
// falls back to the commented example so the documentation never stands alone.
func emitArtifactsAuthoritative(out *[]string, arts []ArtifactScript, meta map[string]artifactComments) {
	rendered := 0
	for _, a := range arts {
		if a.Name == "" && a.Command == "" {
			continue
		}
		if rendered > 0 {
			*out = append(*out, "")
		}
		rendered++
		m := meta[a.Name]
		*out = append(*out, m.leading...)
		*out = append(*out, "[[artifacts]]")
		*out = append(*out, m.interior...)
		*out = append(*out, artifactFieldLines(a)...)
	}
	if rendered == 0 {
		*out = append(*out, artifactsExampleLines()...)
	}
}

// existingAnalysis captures everything renderConfig needs to read from a prior
// config file: the user comments attached to managed tables and keys, and the
// existing [[artifacts]] blocks with their preserved comments. It is derived
// from a real TOML parse (go-toml/v2's unstable AST gives accurate byte ranges
// per expression), so multi-line string and array values can never confuse
// comment attribution the way a naive line-by-line scan once did.
type existingAnalysis struct {
	tableComments  map[string][]string         // normalized table -> leading user comments
	keyComments    map[string][]string         // "normTable\x00key" -> preceding user comments
	artifactBlocks [][]string                  // verbatim [[artifacts]] blocks, in source order
	artifactMeta   map[string]artifactComments // artifact name -> preserved comments
}

// tomlItem is one top-level TOML expression (a table header or a key/value),
// located by the inclusive 0-based line range it occupies in the source.
type tomlItem struct {
	kind      unstable.Kind
	startLine int
	endLine   int
	key       string // first key segment, for a KeyValue
	strVal    string // decoded value, for a string-valued KeyValue (used to read "name")
	norm      string // normalized table name, for a Table/ArrayTable
}

// lineIndexer returns a function mapping a byte offset to its 0-based line.
func lineIndexer(data []byte) func(off uint32) int {
	var newlines []int
	for i, b := range data {
		if b == '\n' {
			newlines = append(newlines, i)
		}
	}
	return func(off uint32) int {
		o := int(off)
		lo, hi := 0, len(newlines)
		for lo < hi {
			mid := (lo + hi) / 2
			if newlines[mid] < o {
				lo = mid + 1
			} else {
				hi = mid
			}
		}
		return lo
	}
}

// parseTOMLItems parses data (already CRLF-normalized) into its ordered
// top-level expressions, each tagged with the source line range it spans. The
// unstable parser leaves a table header's Raw range empty, so its line is taken
// from the first key segment, whose Data references the input bytes for a bare
// key. A quoted key decodes to an allocated slice that Parser.Range rejects with
// a panic; the deferred recover turns that (and any other unstable-API surprise)
// into an error so the caller degrades to a fresh render instead of crashing.
func parseTOMLItems(data []byte) (items []tomlItem, err error) {
	defer func() {
		if r := recover(); r != nil {
			items, err = nil, errtrace.Wrap(fmt.Errorf("parse toml structure: %v", r))
		}
	}()
	offsetLine := lineIndexer(data)
	var p unstable.Parser
	p.Reset(data)
	for p.NextExpression() {
		e := p.Expression()
		switch e.Kind {
		case unstable.Table, unstable.ArrayTable:
			var parts []string
			var firstKey []byte // the first segment's bytes, still referencing the input
			it := e.Key()
			for it.Next() {
				if firstKey == nil {
					firstKey = it.Node().Data
				}
				parts = append(parts, string(it.Node().Data))
			}
			if len(parts) == 0 {
				continue
			}
			line := offsetLine(p.Range(firstKey).Offset)
			items = append(items, tomlItem{
				kind:      e.Kind,
				startLine: line,
				endLine:   line,
				norm:      normalizeTableParts(parts),
			})
		case unstable.KeyValue:
			it := e.Key()
			if !it.Next() {
				continue
			}
			item := tomlItem{
				kind:      e.Kind,
				startLine: offsetLine(e.Raw.Offset),
				endLine:   offsetLine(e.Raw.Offset + e.Raw.Length),
				key:       string(it.Node().Data),
			}
			if v := e.Value(); v.Kind == unstable.String {
				item.strVal = string(v.Data)
			}
			items = append(items, item)
		}
	}
	if err := p.Error(); err != nil {
		return nil, errtrace.Wrap(err)
	}
	return items, nil
}

// analyzeExisting parses prior config bytes and attributes every user comment to
// the managed table, key, or [[artifacts]] block it precedes. An empty input (or
// one that fails to parse) yields an empty analysis, so renderConfig still emits
// a valid file. keys is the managed-key set used to strip Hydra's own docs.
func analyzeExisting(data []byte, keys map[string]bool) *existingAnalysis {
	res := &existingAnalysis{
		tableComments: map[string][]string{},
		keyComments:   map[string][]string{},
		artifactMeta:  map[string]artifactComments{},
	}
	if len(data) == 0 {
		return res
	}
	text := strings.ReplaceAll(string(data), "\r\n", "\n")
	lines := strings.Split(text, "\n")
	if n := len(lines); n > 0 && lines[n-1] == "" {
		lines = lines[:n-1] // drop the empty element from a trailing newline
	}
	items, err := parseTOMLItems([]byte(text))
	if err != nil {
		return res // malformed file: degrade to a fresh render rather than fail the save
	}

	// gap returns the comment/blank source lines between the previous item's end
	// and the start of the next item — i.e. the lines preceding that item.
	gap := func(prevEnd, start int) []string {
		from := max(prevEnd+1, 0)
		if from >= start || start > len(lines) {
			return nil
		}
		return lines[from:start]
	}

	prevEnd := -1
	curNorm := "" // normalized managed table for the current section (root = "")

	// Accumulators for the [[artifacts]] block currently being read.
	inArray := false
	var artLeading, artInterior []string
	var artName string
	artHeaderLine, artLastLine := 0, 0
	flushArtifact := func() {
		if !inArray {
			return
		}
		block := append([]string{}, userComments(artLeading, keys)...)
		block = append(block, lines[artHeaderLine:artLastLine+1]...)
		res.artifactBlocks = append(res.artifactBlocks, block)
		if artName != "" {
			res.artifactMeta[artName] = artifactComments{
				leading:  userComments(artLeading, keys),
				interior: artInterior,
			}
		}
		inArray, artLeading, artInterior, artName = false, nil, nil, ""
	}

	for _, it := range items {
		g := gap(prevEnd, it.startLine)
		switch it.kind {
		case unstable.ArrayTable:
			flushArtifact()
			inArray = true
			artLeading = g
			artHeaderLine, artLastLine = it.startLine, it.endLine
		case unstable.Table:
			flushArtifact()
			curNorm = it.norm
			if uc := userComments(g, keys); len(uc) > 0 {
				res.tableComments[curNorm] = append(res.tableComments[curNorm], uc...)
			}
		case unstable.KeyValue:
			if inArray {
				for _, ln := range g {
					if strings.HasPrefix(strings.TrimSpace(ln), "#") {
						artInterior = append(artInterior, ln)
					}
				}
				if it.key == "name" && artName == "" {
					artName = it.strVal
				}
				artLastLine = it.endLine
			} else if uc := userComments(g, keys); len(uc) > 0 {
				res.keyComments[curNorm+"\x00"+it.key] = uc
			}
		}
		if it.endLine > prevEnd {
			prevEnd = it.endLine
		}
	}
	flushArtifact()
	return res
}

// normalizeTableParts joins a table header's key segments into the canonical
// new-layout name, dropping a leading "defaults"/"agents" container: e.g.
// ["defaults"]→"", ["defaults","sandbox"]→"sandbox", ["agents","claude",
// "sandbox"]→"claude.sandbox", ["sandbox"]→"sandbox".
func normalizeTableParts(parts []string) string {
	if len(parts) > 0 && (parts[0] == "defaults" || parts[0] == "agents") {
		parts = parts[1:]
	}
	return strings.Join(parts, ".")
}

// isManagedDoc reports whether a line is a Hydra-generated documentation comment.
func isManagedDoc(line string) bool {
	t := strings.TrimSpace(line)
	if strings.HasPrefix(t, docPrefix) {
		return true
	}
	for _, p := range legacyDocPrefixes {
		if strings.HasPrefix(t, p) {
			return true
		}
	}
	return false
}

// isManagedCommentedAssign reports whether a line is a commented-out assignment
// of a managed key (e.g. "# masked_paths = [...]"), i.e. a regenerated default.
func isManagedCommentedAssign(line string, keys map[string]bool) bool {
	t := strings.TrimSpace(line)
	if !strings.HasPrefix(t, "#") || isManagedDoc(t) {
		return false
	}
	t = strings.TrimSpace(strings.TrimPrefix(t, "#"))
	if eq := strings.Index(t, "="); eq > 0 {
		return keys[strings.TrimSpace(t[:eq])]
	}
	return false
}

// userComments keeps only the user's own comments, dropping Hydra-generated doc
// and commented-default lines (which are regenerated) and any blank lines.
func userComments(comments []string, keys map[string]bool) []string {
	var out []string
	for _, c := range comments {
		if strings.TrimSpace(c) == "" || isManagedDoc(c) || isManagedCommentedAssign(c, keys) || isManagedCommentedAgentHeader(c) {
			continue
		}
		out = append(out, c)
	}
	return out
}

// renderConfig serializes cfg to the new flattened TOML layout, rendered on top
// of the existing file content: user comments and unmanaged [[artifacts]] blocks
// are preserved, managed values reflect cfg, and unset default settings are
// emitted commented-out with up-to-date documentation.
func renderConfig(existing []byte, cfg Config) string {
	keys := managedKeySet()
	prior := analyzeExisting(existing, keys)
	keyComments := prior.keyComments     // "<table>\x00<key>" -> user comments
	tableComments := prior.tableComments // normalized table -> leading user comments
	artifactBlocks := prior.artifactBlocks
	artifactMeta := prior.artifactMeta // name -> preserved comments

	var out []string
	spec := defaultsSpec()

	// Root defaults (pre_prompt) — must precede any table header.
	if tc := tableComments[""]; len(tc) > 0 {
		out = append(out, tc...)
	}
	emitSpecTable(&out, spec, "", "", cfg.Defaults, keyComments, tableComments)
	emitSpecTable(&out, spec, "sandbox", "[sandbox]", cfg.Defaults, keyComments, tableComments)
	emitSpecTable(&out, spec, "sandbox.network", "[sandbox.network]", cfg.Defaults, keyComments, tableComments)

	// Per-agent overrides. The well-known agent types always get a documented
	// mention: their real table when configured, otherwise a commented-out header
	// so the file self-documents that per-agent overrides are possible.
	emitted := map[string]bool{}
	for _, name := range docAgents {
		emitted[name] = true
		if a, ok := cfg.Agents[name]; ok && agentHasContent(a) {
			emitAgent(&out, name, a, keyComments, tableComments)
		} else {
			emitAgentDoc(&out, name, tableComments)
			out = append(out, "# ["+name+"]")
		}
	}
	// Any other configured agents (e.g. bash), sorted for determinism.
	names := make([]string, 0, len(cfg.Agents))
	for name := range cfg.Agents {
		if !emitted[name] {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	for _, name := range names {
		emitAgent(&out, name, cfg.Agents[name], keyComments, tableComments)
	}

	// Artifacts: documentation block, then the artifact tables.
	out = appendBlank(out)
	out = append(out, artifactsDocLines()...)
	if cfg.Artifacts != nil {
		// Authoritative mode (the editor sent an explicit list): cfg.Artifacts is
		// the source of truth, so edits and deletions take effect. Per-artifact
		// hand-written comments are preserved by matching on the artifact name.
		emitArtifactsAuthoritative(&out, cfg.Artifacts, artifactMeta)
	} else if len(artifactBlocks) == 0 {
		// No artifacts configured and none in the file: show a commented example.
		out = append(out, artifactsExampleLines()...)
	} else {
		// Preserve mode (no explicit list, e.g. a defaults-only save): keep the
		// existing artifact blocks verbatim.
		for i, block := range artifactBlocks {
			if i > 0 {
				out = append(out, "")
			}
			out = append(out, block...)
		}
	}

	result := strings.Join(out, "\n")
	if result != "" && !strings.HasSuffix(result, "\n") {
		result += "\n"
	}
	return result
}

// emitSpecTable appends one defaults table to out: set values active (with any
// preserved user comment), unset values commented-out with documentation.
func emitSpecTable(out *[]string, spec []specEntry, table, header string, def AgentConfig, keyComments, tableComments map[string][]string) {
	var entries []specEntry
	for _, e := range spec {
		if e.table == table {
			entries = append(entries, e)
		}
	}
	if len(entries) == 0 {
		return
	}
	if header != "" {
		*out = appendBlank(*out)
		if tc := tableComments[table]; len(tc) > 0 {
			*out = append(*out, tc...)
		}
		*out = append(*out, header)
	}
	for _, e := range entries {
		text, isSet := e.get(def)
		// The Hydra doc line is shown above every setting, set or not, with any
		// preserved user comment above the doc.
		if uc := keyComments[table+"\x00"+e.key]; len(uc) > 0 {
			*out = append(*out, uc...)
		}
		*out = append(*out, docPrefix+" "+e.doc)
		if isSet {
			*out = append(*out, e.key+" = "+text)
		} else {
			*out = append(*out, "# "+e.key+" = "+e.def())
		}
	}
}

// docAgents are the agent types that always get a documented mention in the
// rendered config (a commented-out [name] header when they have no overrides).
// Order matches the Settings UI tabs.
var docAgents = []string{"claude", "gemini", "copilot"}

// agentLabel returns a human-friendly capitalised name for an agent type.
func agentLabel(name string) string {
	switch name {
	case "claude":
		return "Claude"
	case "gemini":
		return "Gemini"
	case "copilot":
		return "Copilot"
	default:
		if name == "" {
			return name
		}
		return strings.ToUpper(name[:1]) + name[1:]
	}
}

// agentDoc is the one-line documentation shown above an agent's table.
func agentDoc(name string) string {
	label := agentLabel(name)
	return label + "-specific overrides: any of the settings above, applied only to " + name + " agents."
}

// isManagedCommentedAgentHeader reports whether a line is a regenerated
// commented-out agent header (e.g. "# [gemini]") for one of the docAgents, so it
// is dropped on read and re-emitted rather than accumulating as a user comment.
func isManagedCommentedAgentHeader(line string) bool {
	t := strings.TrimSpace(line)
	if !strings.HasPrefix(t, "#") || isManagedDoc(t) {
		return false
	}
	t = strings.TrimSpace(strings.TrimPrefix(t, "#"))
	for _, name := range docAgents {
		if t == "["+name+"]" {
			return true
		}
	}
	return false
}

// emitAgentDoc appends a blank separator, any preserved user comment, and the
// Hydra doc line for the given agent — the shared prefix of a real or commented
// agent table.
func emitAgentDoc(out *[]string, name string, tableComments map[string][]string) {
	*out = appendBlank(*out)
	if tc := tableComments[name]; len(tc) > 0 {
		*out = append(*out, tc...)
	}
	*out = append(*out, docPrefix+" "+agentDoc(name))
}

// emitAgent appends a per-agent table, emitting only the settings that are set.
func emitAgent(out *[]string, name string, a AgentConfig, keyComments, tableComments map[string][]string) {
	if !agentHasContent(a) {
		return
	}
	emitAgentDoc(out, name, tableComments)
	*out = append(*out, "["+name+"]")
	if a.PrePrompt != nil {
		if uc := keyComments[name+"\x00pre_prompt"]; len(uc) > 0 {
			*out = append(*out, uc...)
		}
		*out = append(*out, "pre_prompt = "+tomlStringValue(*a.PrePrompt))
	}
	sb := a.Sandbox
	if sb == nil || !sandboxHasContent(sb) {
		return
	}
	*out = appendBlank(*out)
	if tc := tableComments[name+".sandbox"]; len(tc) > 0 {
		*out = append(*out, tc...)
	}
	*out = append(*out, "["+name+".sandbox]")
	emitSetField(out, name+".sandbox", "writable_paths", tomlStringArray(sb.WritablePaths), len(sb.WritablePaths) > 0, keyComments)
	emitSetField(out, name+".sandbox", "masked_paths", tomlStringArray(sb.MaskedPaths), len(sb.MaskedPaths) > 0, keyComments)
	emitSetField(out, name+".sandbox", "restore_ro", tomlStringArray(sb.RestoreRO), len(sb.RestoreRO) > 0, keyComments)
	emitSetField(out, name+".sandbox", "cow_paths", tomlStringArray(sb.CowPaths), len(sb.CowPaths) > 0, keyComments)
	if sb.PreSpawnScript != nil && *sb.PreSpawnScript != "" {
		emitSetField(out, name+".sandbox", "pre_spawn_script", tomlStringValue(*sb.PreSpawnScript), true, keyComments)
	}
	if nw := sb.Network; nw != nil && (nw.Enabled != nil || len(nw.AllowedHosts) > 0) {
		*out = appendBlank(*out)
		if tc := tableComments[name+".sandbox.network"]; len(tc) > 0 {
			*out = append(*out, tc...)
		}
		*out = append(*out, "["+name+".sandbox.network]")
		if nw.Enabled != nil {
			emitSetField(out, name+".sandbox.network", "enabled", fmt.Sprintf("%t", *nw.Enabled), true, keyComments)
		}
		emitSetField(out, name+".sandbox.network", "allowed_hosts", tomlStringArray(nw.AllowedHosts), len(nw.AllowedHosts) > 0, keyComments)
	}
}

// emitSetField appends "key = text" (with any preserved user comment) when set.
func emitSetField(out *[]string, table, key, text string, set bool, keyComments map[string][]string) {
	if !set {
		return
	}
	if uc := keyComments[table+"\x00"+key]; len(uc) > 0 {
		*out = append(*out, uc...)
	}
	*out = append(*out, key+" = "+text)
}

func agentHasContent(a AgentConfig) bool {
	return a.PrePrompt != nil || (a.Sandbox != nil && sandboxHasContent(a.Sandbox))
}

func sandboxHasContent(sb *SandboxConfig) bool {
	if sb == nil {
		return false
	}
	if len(sb.WritablePaths) > 0 || len(sb.MaskedPaths) > 0 || len(sb.RestoreRO) > 0 || len(sb.CowPaths) > 0 {
		return true
	}
	if sb.PreSpawnScript != nil && *sb.PreSpawnScript != "" {
		return true
	}
	return sb.Network != nil && (sb.Network.Enabled != nil || len(sb.Network.AllowedHosts) > 0)
}

// appendBlank adds a single blank separator line if out is non-empty.
func appendBlank(out []string) []string {
	if len(out) > 0 {
		return append(out, "")
	}
	return out
}
