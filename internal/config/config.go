package config

import (
	_ "embed"
	"fmt"
	"os"
	"path/filepath"

	"braces.dev/errtrace"
	"github.com/BurntSushi/toml"
)

//go:embed claude.Dockerfile
var DefaultDockerfileClaude string

//go:embed gemini.Dockerfile
var DefaultDockerfileGemini string

//go:embed entrypoint.sh
var DefaultEntrypointScript string

// DefaultPrePrompt is the pre-prompt used when none is configured.
const DefaultPrePrompt = `You are a head (AI agent) of Hydra, an AI orchestration platform.
- You have unrestricted access to the file system.
- You are allowed to install what is necessary to complete the task.
- You are running inside a Docker container.
- As you work, use git commit to save your progress at logical points.
- Once you have finished the task, make a final git commit with all remaining changes.
- Do *not* use git push.

Task:
`

// AgentConfig holds per-agent-type configuration.
type AgentConfig struct {
	// Dockerfile is a path to a custom Dockerfile for this agent type.
	// Relative paths are resolved from the config file location.
	Dockerfile *string `toml:"dockerfile"`
	// DockerfileContents is the actual content of the Dockerfile.
	// This will be used as the base and always starts with FROM <default-agent-image>.
	DockerfileContents *string `toml:"dockerfile_contents"`
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
func LoadInternalDefaults() Config {
	prePrompt := DefaultPrePrompt
	return Config{
		Defaults: AgentConfig{
			PrePrompt: &prePrompt,
		},
	}
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
	return SaveToFile(GetProjectConfigPath(projectRoot), cfg)
}

// SaveToFile saves a configuration to the given file path.
func SaveToFile(path string, cfg Config) error {
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return errtrace.Wrap(fmt.Errorf("create config parent: %s: %w", path, err))
	}
	f, err := os.Create(path)
	if err != nil {
		return errtrace.Wrap(fmt.Errorf("create config: %s: %w", path, err))
	}
	defer f.Close()
	encoder := toml.NewEncoder(f)
	if err := encoder.Encode(cfg); err != nil {
		return errtrace.Wrap(fmt.Errorf("save config: %s: %w", path, err))
	}
	return nil
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
