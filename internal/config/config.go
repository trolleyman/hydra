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

type Config struct {
	// Agent is the selected agent
	Agent *string `toml:"agent"`
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
