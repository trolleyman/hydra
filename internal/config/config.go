package config

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/BurntSushi/toml"
	"github.com/cockroachdb/errors"
)

const defaultPromptPrefix = `You are an AI coding agent running inside the Hydra orchestration system.

You have been given a specific task to complete in this git repository.
Your working directory is /app, which is an isolated git branch for this task.

Guidelines:
- Commit your work as you go, making logical commits for each coherent change.
- Each commit message MUST include "Co-authored-by: Hydra" as a trailer line.
- Make sure all your changes are committed before you exit.
  Any uncommitted changes will be automatically committed as "Uncommitted changes".
- Do not push to the remote.

Task:
`

const defaultDockerfile = `# Hydra Agent Dockerfile
# Customize this file to configure your AI agent environment.
# The ENTRYPOINT defines the agent command; the prompt is passed as CMD.
#
# Examples:
#   Claude Code: ENTRYPOINT ["claude", "--dangerously-skip-permissions", "-p"]
#   Gemini:      ENTRYPOINT ["gemini", "code"]

FROM ubuntu:24.04

RUN apt-get update && apt-get install -y git curl && rm -rf /var/lib/apt/lists/*

# TODO: Install your AI agent CLI here.
# Example for Claude Code:
#   RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
#       && apt-get install -y nodejs \
#       && npm install -g @anthropic-ai/claude-code

WORKDIR /app

# Replace with your agent's entrypoint command:
ENTRYPOINT ["claude", "--dangerously-skip-permissions", "-p"]
`

// Config holds Hydra configuration loaded from a config file.
type Config struct {
	// DockerfilePath is a path to the Dockerfile, relative to the config file.
	DockerfilePath string `toml:"dockerfile"`
	// PromptPrefix is prepended to every agent prompt.
	PromptPrefix string `toml:"prompt_prefix"`

	// configDir is the directory the config file was loaded from (for resolving relative paths).
	configDir string
}

// Load searches for a config file and returns the merged configuration.
// projectRoot may be empty if not in a git repo.
func Load(projectRoot string) (*Config, error) {
	cfg := &Config{
		PromptPrefix: defaultPromptPrefix,
	}

	for _, path := range configSearchPaths(projectRoot) {
		if _, err := os.Stat(path); err != nil {
			continue
		}
		if _, err := toml.DecodeFile(path, cfg); err != nil {
			return nil, errors.Wrapf(err, "parse config %s", path)
		}
		cfg.configDir = filepath.Dir(path)
		break
	}

	return cfg, nil
}

func configSearchPaths(projectRoot string) []string {
	var paths []string
	if projectRoot != "" {
		paths = append(paths, filepath.Join(projectRoot, ".hydra", "config.toml"))
	}
	if home, err := os.UserHomeDir(); err == nil {
		paths = append(paths, filepath.Join(home, ".config", "hydra", "config.toml"))
	}
	paths = append(paths, "/etc/hydra/config.toml")
	return paths
}

// FindDockerfile returns the path to the Dockerfile to use, creating a default if none exists.
// If --dockerfile was passed on the CLI, override is non-empty and takes precedence.
func FindDockerfile(cfg *Config, projectRoot, override string) (string, error) {
	if override != "" {
		if _, err := os.Stat(override); err != nil {
			return "", errors.Errorf("dockerfile %q not found", override)
		}
		return override, nil
	}

	// Config-specified path (relative to config dir)
	if cfg.DockerfilePath != "" {
		p := cfg.DockerfilePath
		if cfg.configDir != "" && !filepath.IsAbs(p) {
			p = filepath.Join(cfg.configDir, p)
		}
		if _, err := os.Stat(p); err == nil {
			return p, nil
		}
	}

	// Search standard locations
	for _, path := range dockerfileSearchPaths(projectRoot) {
		if _, err := os.Stat(path); err == nil {
			return path, nil
		}
	}

	// No Dockerfile found — create a default one in the project
	if projectRoot == "" {
		return "", errors.Errorf("no Dockerfile found; create one at .hydra/Dockerfile or pass --dockerfile")
	}
	defaultPath := filepath.Join(projectRoot, ".hydra", "Dockerfile")
	if err := os.MkdirAll(filepath.Dir(defaultPath), 0755); err != nil {
		return "", errors.Wrapf(err, "create .hydra dir")
	}
	if err := os.WriteFile(defaultPath, []byte(defaultDockerfile), 0644); err != nil {
		return "", errors.Wrapf(err, "write default Dockerfile")
	}
	fmt.Printf("Created default Dockerfile at %s — edit it to configure your agent.\n", defaultPath)
	return defaultPath, nil
}

func dockerfileSearchPaths(projectRoot string) []string {
	var paths []string
	if projectRoot != "" {
		paths = append(paths, filepath.Join(projectRoot, ".hydra", "Dockerfile"))
	}
	if home, err := os.UserHomeDir(); err == nil {
		paths = append(paths, filepath.Join(home, ".config", "hydra", "Dockerfile"))
	}
	paths = append(paths, "/etc/hydra/Dockerfile")
	return paths
}
