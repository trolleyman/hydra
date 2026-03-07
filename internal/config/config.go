package config

import (
	_ "embed"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"braces.dev/errtrace"
	"github.com/BurntSushi/toml"
)

//go:embed claude.Dockerfile
var DefaultDockerfileClaude string

//go:embed gemini.Dockerfile
var DefaultDockerfileGemini string

//go:embed bash.Dockerfile
var DefaultDockerfileBash string

//go:embed copilot.Dockerfile
var DefaultDockerfileCopilot string

//go:embed base.Dockerfile
var DefaultDockerfileBase string

//go:embed entrypoint.sh
var DefaultEntrypointScript string

// DefaultPrePrompt is the built-in pre-prompt always prepended to agent prompts.
// The placeholders <branch> and <base-branch> are substituted at spawn time.
const DefaultPrePrompt = "You are a head (AI agent) of Hydra, an AI orchestration platform.\n" +
	"- You have unrestricted access to the file system.\n" +
	"- You are allowed to install what is necessary to complete the task.\n" +
	"- You are running inside a Docker container on a git worktree.\n" +
	"- The current branch is `<branch>` and it targets `<base-branch>`.\n" +
	"- As you work, use git commit to save your progress at logical points.\n" +
	"- Once you have finished the task, make a final git commit with all remaining changes.\n" +
	"- Do *not* use git push or git pull.\n" +
	"- Try not to bother the user with requests unless necessary.\n" +
	"- If there are any design decisions made without user input, document them in each commit."

// AgentConfig holds per-agent-type configuration.
type AgentConfig struct {
	// Dockerfile is a path to a custom Dockerfile for this agent type.
	// Relative paths are resolved from the config file location.
	Dockerfile *string `toml:"dockerfile"`
	// DockerfileContents is the actual content of the Dockerfile.
	// This will be used as the base and always starts with FROM <default-agent-image>.
	DockerfileContents *string `toml:"dockerfile_contents"`
	// DockerignoreContents is the content of the .dockerignore file.
	DockerignoreContents *string `toml:"dockerignore_contents"`
	// SharedMounts is a list of container paths to share across agents.
	SharedMounts []string `toml:"shared_mounts"`
	// Context is the build context directory.
	// Relative paths are resolved from the config file location.
	Context *string `toml:"context"`
	// PrePrompt is prepended to every agent prompt.
	PrePrompt *string `toml:"pre_prompt"`
}

type Config struct {
	// Defaults for all agents.
	Defaults AgentConfig `toml:"defaults"`
	// Per-agent overrides (e.g. claude, gemini).
	Agents map[string]AgentConfig `toml:"agents"`
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

// LoadFile loads a configuration from a file and resolves relative paths.
func LoadFile(path string) (*Config, error) {
	if _, err := os.Stat(path); os.IsNotExist(err) {
		return nil, nil
	}
	cfg := Config{}
	_, err := toml.DecodeFile(path, &cfg)
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("load config: %s: %w", path, err))
	}

	baseDir := filepath.Dir(path)
	cfg.Defaults.ResolvePaths(baseDir)
	for name, agent := range cfg.Agents {
		agent.ResolvePaths(baseDir)
		cfg.Agents[name] = agent
	}

	return &cfg, nil
}

// ResolvePaths resolves relative paths in the AgentConfig relative to baseDir.
func (a *AgentConfig) ResolvePaths(baseDir string) {
	if a.Dockerfile != nil && !filepath.IsAbs(*a.Dockerfile) {
		abs := filepath.Join(baseDir, *a.Dockerfile)
		a.Dockerfile = &abs
	}
	if a.Context != nil && !filepath.IsAbs(*a.Context) {
		abs := filepath.Join(baseDir, *a.Context)
		a.Context = &abs
	}
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
}

// Merge merges another AgentConfig into this one.
func (a *AgentConfig) Merge(other AgentConfig) {
	if other.Dockerfile != nil {
		a.Dockerfile = other.Dockerfile
	}
	if other.DockerfileContents != nil {
		a.DockerfileContents = other.DockerfileContents
	}
	if other.DockerignoreContents != nil {
		a.DockerignoreContents = other.DockerignoreContents
	}
	if other.SharedMounts != nil {
		a.SharedMounts = other.SharedMounts
	}
	if other.Context != nil {
		a.Context = other.Context
	}
	if other.PrePrompt != nil {
		a.PrePrompt = other.PrePrompt
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

// writeAgentConfigFields writes the fields of an AgentConfig to buf.
func writeAgentConfigFields(buf *strings.Builder, cfg AgentConfig) {
	if cfg.Dockerfile != nil {
		buf.WriteString("dockerfile = " + tomlStringValue(*cfg.Dockerfile) + "\n")
	}
	if cfg.DockerfileContents != nil {
		buf.WriteString("dockerfile_contents = " + tomlStringValue(*cfg.DockerfileContents) + "\n")
	}
	if cfg.DockerignoreContents != nil {
		buf.WriteString("dockerignore_contents = " + tomlStringValue(*cfg.DockerignoreContents) + "\n")
	}
	if len(cfg.SharedMounts) > 0 {
		parts := make([]string, len(cfg.SharedMounts))
		for i, m := range cfg.SharedMounts {
			parts[i] = tomlStringValue(m)
		}
		buf.WriteString("shared_mounts = [" + strings.Join(parts, ", ") + "]\n")
	}
	if cfg.Context != nil {
		buf.WriteString("context = " + tomlStringValue(*cfg.Context) + "\n")
	}
	if cfg.PrePrompt != nil {
		buf.WriteString("pre_prompt = " + tomlStringValue(*cfg.PrePrompt) + "\n")
	}
}

// marshalConfig serializes a Config to TOML without indentation and with
// triple-quoted multi-line strings.
func marshalConfig(cfg Config) string {
	var buf strings.Builder

	defaultsEmpty := cfg.Defaults.Dockerfile == nil &&
		cfg.Defaults.DockerfileContents == nil &&
		cfg.Defaults.DockerignoreContents == nil &&
		len(cfg.Defaults.SharedMounts) == 0 &&
		cfg.Defaults.Context == nil &&
		cfg.Defaults.PrePrompt == nil

	if !defaultsEmpty {
		buf.WriteString("[defaults]\n")
		writeAgentConfigFields(&buf, cfg.Defaults)
	}

	agentNames := make([]string, 0, len(cfg.Agents))
	for name := range cfg.Agents {
		agentNames = append(agentNames, name)
	}
	sort.Strings(agentNames)

	for _, name := range agentNames {
		if buf.Len() > 0 {
			buf.WriteString("\n")
		}
		buf.WriteString("[agents." + name + "]\n")
		writeAgentConfigFields(&buf, cfg.Agents[name])
	}

	return buf.String()
}

// Deprecated: Use GetResolvedConfig instead.
func (c Config) GetDockerfileForAgent(projectRoot, agentType string) string {
	resolved := c.GetResolvedConfig(agentType)
	if resolved.Dockerfile != nil {
		return *resolved.Dockerfile
	}

	// Check if .hydra/config/<agentType>/Dockerfile exists (legacy fallback)
	customPath := filepath.Join(".hydra", "config", agentType, "Dockerfile")
	if _, err := os.Stat(filepath.Join(projectRoot, customPath)); err == nil {
		return customPath
	}

	return ""
}
