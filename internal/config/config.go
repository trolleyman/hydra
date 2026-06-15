package config

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"braces.dev/errtrace"
	"github.com/BurntSushi/toml"
	"github.com/trolleyman/hydra/internal/sandbox"
)

// DefaultPrePrompt is the built-in pre-prompt delivered to every agent as a
// system prompt (not as part of the user's task prompt). The placeholders
// <branch> and <base-branch> are substituted at spawn time.
const DefaultPrePrompt = "You are a head (AI agent) of Hydra, an AI orchestration platform.\n" +
	"\n" +
	"## Environment\n" +
	"- You are running inside a locked-down OS sandbox on a dedicated git worktree, as the host user.\n" +
	"- You have read access to the host, write access to your worktree and the developer caches; credential locations are masked.\n" +
	"- The current branch is `<branch>` and it targets `<base-branch>`.\n" +
	"\n" +
	"## Sandbox rules\n" +
	"- Do NOT install anything: no package managers, no global tools, no new system dependencies. Work with the toolchain already present on the host.\n" +
	"- Do NOT try to escape, weaken, or probe the sandbox (e.g. remounting paths, reading masked credentials, disabling seccomp, or reaching blocked hosts). The sandbox is a security boundary — treat it as fixed.\n" +
	"- If you need something the environment does not provide — a tool installed, a path made writable, network access, etc. — STOP and ask the user to change it for you. Do not work around it.\n" +
	"\n" +
	"## What the user can change for you\n" +
	"The user controls your sandbox through Hydra's config (the per-agent `[<agent>.sandbox]` section of config.toml, editable in the web UI). When you need an environment change, tell the user exactly which setting to adjust and why:\n" +
	"- `writable_paths` — extra paths made writable inside the sandbox.\n" +
	"- `masked_paths` — extra paths hidden inside the sandbox.\n" +
	"- `restore_ro` — paths re-exposed read-only after a parent was masked.\n" +
	"- `network.enabled` / `network.allowed_hosts` — outbound network access and its host allow-list.\n" +
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
	// Network is the network policy.
	Network *NetworkConfig `toml:"network"`
}

// AgentConfig holds per-agent-type configuration.
type AgentConfig struct {
	// Sandbox overrides sandbox policy for this agent type.
	Sandbox *SandboxConfig `toml:"sandbox"`
	// PrePrompt is prepended to every agent prompt.
	PrePrompt *string `toml:"pre_prompt"`
}

type Features struct {
	TerminalBash bool `toml:"terminal_bash"`
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
}

type Config struct {
	// Defaults for all agents.
	Defaults AgentConfig `toml:"defaults"`
	// Per-agent overrides (e.g. claude, gemini).
	Agents map[string]AgentConfig `toml:"agents"`
	// Feature flags.
	Features Features `toml:"features"`
	// Artifacts are per-project visual-artifact generation scripts.
	Artifacts []ArtifactScript `toml:"artifacts"`
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

// LoadFile loads a configuration from a file.
func LoadFile(path string) (*Config, error) {
	if _, err := os.Stat(path); os.IsNotExist(err) {
		return nil, nil
	}
	cfg := Config{}
	_, err := toml.DecodeFile(path, &cfg)
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

	if other.Features.TerminalBash {
		c.Features.TerminalBash = true
	}

	// Artifact scripts are replaced wholesale when the other config sets any.
	if other.Artifacts != nil {
		c.Artifacts = other.Artifacts
	}
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

// GetResolvedConfig returns the fully resolved AgentConfig for a specific agent type.
func (c Config) GetResolvedConfig(agentType string) AgentConfig {
	resolved := c.Defaults

	if agentCfg, ok := c.Agents[agentType]; ok {
		resolved.Merge(agentCfg)
	}

	return resolved
}

// ResolveSandboxOptions merges the baked-in sandbox defaults with the resolved
// per-agent config into concrete path lists + network policy. User config is
// additive for the path lists.
func (c Config) ResolveSandboxOptions(agentType string) (writable, masked, restore []string, net sandbox.NetworkPolicy) {
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
		if sb.Network != nil {
			if sb.Network.Enabled != nil {
				net.Enabled = *sb.Network.Enabled
			}
			net.AllowedHosts = sb.Network.AllowedHosts
		}
	}
	return writable, masked, restore, net
}

// Save saves a configuration to the project-specific configuration file.
func Save(projectRoot string, cfg Config) error {
	return errtrace.Wrap(SaveToFile(GetProjectConfigPath(projectRoot), cfg))
}

// SaveToFile saves a configuration to the given file path.
func SaveToFile(path string, cfg Config) error {
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return errtrace.Wrap(fmt.Errorf("create config parent: %s: %w", path, err))
	}
	content := marshalConfig(cfg)
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

// writeAgentConfigFields writes the fields of an AgentConfig to buf under the
// given table name (e.g. "defaults" or "agents.claude").
func writeAgentConfigFields(buf *strings.Builder, table string, cfg AgentConfig) {
	buf.WriteString("[" + table + "]\n")
	if cfg.PrePrompt != nil {
		buf.WriteString("pre_prompt = " + tomlStringValue(*cfg.PrePrompt) + "\n")
	}
	if sb := cfg.Sandbox; sb != nil {
		buf.WriteString("\n[" + table + ".sandbox]\n")
		if len(sb.WritablePaths) > 0 {
			buf.WriteString("writable_paths = " + tomlStringArray(sb.WritablePaths) + "\n")
		}
		if len(sb.MaskedPaths) > 0 {
			buf.WriteString("masked_paths = " + tomlStringArray(sb.MaskedPaths) + "\n")
		}
		if len(sb.RestoreRO) > 0 {
			buf.WriteString("restore_ro = " + tomlStringArray(sb.RestoreRO) + "\n")
		}
		if sb.Network != nil {
			buf.WriteString("\n[" + table + ".sandbox.network]\n")
			if sb.Network.Enabled != nil {
				buf.WriteString(fmt.Sprintf("enabled = %t\n", *sb.Network.Enabled))
			}
			if len(sb.Network.AllowedHosts) > 0 {
				buf.WriteString("allowed_hosts = " + tomlStringArray(sb.Network.AllowedHosts) + "\n")
			}
		}
	}
}

func agentConfigEmpty(cfg AgentConfig) bool {
	return cfg.Sandbox == nil && cfg.PrePrompt == nil
}

// marshalConfig serializes a Config to TOML.
func marshalConfig(cfg Config) string {
	var buf strings.Builder

	if !agentConfigEmpty(cfg.Defaults) {
		writeAgentConfigFields(&buf, "defaults", cfg.Defaults)
	}

	agentNames := make([]string, 0, len(cfg.Agents))
	for name := range cfg.Agents {
		agentNames = append(agentNames, name)
	}
	sort.Strings(agentNames)

	for _, name := range agentNames {
		if agentConfigEmpty(cfg.Agents[name]) {
			continue
		}
		if buf.Len() > 0 {
			buf.WriteString("\n")
		}
		writeAgentConfigFields(&buf, "agents."+name, cfg.Agents[name])
	}

	if cfg.Features.TerminalBash {
		if buf.Len() > 0 {
			buf.WriteString("\n")
		}
		buf.WriteString("[features]\n")
		buf.WriteString("terminal_bash = true\n")
	}

	for _, a := range cfg.Artifacts {
		if a.Name == "" && a.Command == "" {
			continue
		}
		if buf.Len() > 0 {
			buf.WriteString("\n")
		}
		buf.WriteString("[[artifacts]]\n")
		buf.WriteString("name = " + tomlStringValue(a.Name) + "\n")
		buf.WriteString("command = " + tomlStringValue(a.Command) + "\n")
		if a.TimeoutSec > 0 {
			buf.WriteString(fmt.Sprintf("timeout_sec = %d\n", a.TimeoutSec))
		}
	}

	return buf.String()
}
