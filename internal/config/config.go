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
	// Relative paths are resolved from the project root.
	// If unset, the built-in default Dockerfile is used.
	Dockerfile *string `toml:"dockerfile"`
}

type Config struct {
	// Agent is the default selected agent
	Agent *string `toml:"agent"`
	// PrePrompt is prepended to every agent prompt. If not set, DefaultSystemPrompt is used.
	PrePrompt *string `toml:"pre_prompt"`
	// Agents holds per-agent-type overrides (e.g. custom Dockerfiles).
	Agents map[string]AgentConfig `toml:"agents"`
}

func GetConfigPath(projectRoot string) string {
	return filepath.Join(projectRoot, ".hydra", "config.toml")
}

func LoadOrNil(projectRoot string) (*Config, error) {
	configPath := GetConfigPath(projectRoot)
	if _, err := os.Stat(configPath); os.IsNotExist(err) {
		return nil, nil
	}
	cfg := Config{}
	_, err := toml.DecodeFile(configPath, &cfg)
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("load project config: %s: %w", configPath, err))
	}
	return &cfg, nil
}

func Load(projectRoot string) (Config, error) {
	cfg, err := LoadOrNil(projectRoot)
	if err != nil {
		return Config{}, errtrace.Wrap(err)
	}
	if cfg == nil {
		return Config{}, nil
	}
	return *cfg, nil
}

func Save(projectRoot string, cfg Config) error {
	configPath := GetConfigPath(projectRoot)
	if err := os.MkdirAll(filepath.Dir(configPath), 0755); err != nil {
		return errtrace.Wrap(fmt.Errorf("create config parent: %s: %w", configPath, err))
	}
	f, err := os.Create(configPath)
	if err != nil {
		return errtrace.Wrap(fmt.Errorf("create config: %s: %w", configPath, err))
	}
	defer f.Close()
	encoder := toml.NewEncoder(f)
	if err := encoder.Encode(cfg); err != nil {
		return errtrace.Wrap(fmt.Errorf("save config: %s: %w", configPath, err))
	}
	return nil
}
