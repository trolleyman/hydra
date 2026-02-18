package config

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/cockroachdb/errors"
	"github.com/spf13/viper"
)

// ---------------------------------------------------------------------------
// Agent types & Dockerfile templates
// ---------------------------------------------------------------------------

// AgentType identifies which AI agent a Dockerfile is built for.
type AgentType string

const (
	AgentClaude AgentType = "claude"
	AgentGemini AgentType = "gemini"
)

// AgentTypes is the ordered list of supported agent types.
var AgentTypes = []AgentType{AgentClaude, AgentGemini}

// DockerfileTemplates maps each AgentType to its Dockerfile template content.
var DockerfileTemplates = map[AgentType]string{
	AgentClaude: claudeDockerfile,
	AgentGemini: geminiDockerfile,
}

const claudeDockerfile = `# Hydra Agent Dockerfile — Claude Code
#
# The full task prompt is passed as an argument to this ENTRYPOINT.
# See: https://docs.anthropic.com/en/docs/claude-code

FROM ubuntu:24.04

RUN apt-get update && apt-get install -y git curl && rm -rf /var/lib/apt/lists/*

# Install Node.js 22.x
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

ENTRYPOINT ["claude", "--dangerously-skip-permissions", "-p"]
`

const geminiDockerfile = `# Hydra Agent Dockerfile — Gemini CLI
#
# The full task prompt is passed as an argument to this ENTRYPOINT.
# See: https://github.com/google-gemini/gemini-cli

FROM ubuntu:24.04

RUN apt-get update && apt-get install -y git curl && rm -rf /var/lib/apt/lists/*

# Install Node.js 22.x
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install Gemini CLI
RUN npm install -g @google/gemini-cli

WORKDIR /app

ENTRYPOINT ["gemini", "code"]
`

// ---------------------------------------------------------------------------
// Default values
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Config sources
// ---------------------------------------------------------------------------

// Source describes a single config file location with a human-readable label.
type Source struct {
	Label string // "system", "global", or "project"
	Path  string
}

// Sources returns all config file locations in ascending priority order
// (system < global < project). The project entry is omitted when projectRoot is empty.
func Sources(projectRoot string) []Source {
	srcs := []Source{
		{"system", "/etc/hydra/config.toml"},
	}
	if home, err := os.UserHomeDir(); err == nil {
		srcs = append(srcs, Source{
			"global",
			filepath.Join(home, ".config", "hydra", "config.toml"),
		})
	}
	if projectRoot != "" {
		srcs = append(srcs, Source{
			"project",
			filepath.Join(projectRoot, ".hydra", "config.toml"),
		})
	}
	return srcs
}

// ---------------------------------------------------------------------------
// Config struct & loading
// ---------------------------------------------------------------------------

// Config holds the merged Hydra configuration.
type Config struct {
	// DockerfilePath is the resolved absolute path to the Dockerfile.
	// Empty if not set in any config file.
	DockerfilePath string
	// PromptPrefix is prepended to every agent prompt.
	PromptPrefix string
}

// Load reads all applicable config files (system → global → project) and returns
// the merged Config. Viper defaults are applied when a key is unset in all files.
func Load(projectRoot string) (*Config, error) {
	v := viper.New()
	v.SetConfigType("toml")
	v.SetDefault("prompt_prefix", defaultPromptPrefix)

	// Track which config directory last defined "dockerfile" so we can
	// resolve a relative path against that directory.
	var dockerfileConfigDir string

	for _, src := range Sources(projectRoot) {
		if _, err := os.Stat(src.Path); err != nil {
			continue
		}
		sub := viper.New()
		sub.SetConfigFile(src.Path)
		sub.SetConfigType("toml")
		if err := sub.ReadInConfig(); err != nil {
			return nil, fmt.Errorf("read %s config (%s): %w", src.Label, src.Path, err)
		}
		if err := v.MergeConfigMap(sub.AllSettings()); err != nil {
			return nil, fmt.Errorf("merge %s config: %w", src.Label, err)
		}
		if sub.IsSet("dockerfile") {
			dockerfileConfigDir = filepath.Dir(src.Path)
		}
	}

	dockerfilePath := v.GetString("dockerfile")
	// Resolve relative dockerfile paths against the config file that set them.
	if dockerfilePath != "" && !filepath.IsAbs(dockerfilePath) && dockerfileConfigDir != "" {
		dockerfilePath = filepath.Join(dockerfileConfigDir, dockerfilePath)
	}

	return &Config{
		DockerfilePath: dockerfilePath,
		PromptPrefix:   v.GetString("prompt_prefix"),
	}, nil
}

// ---------------------------------------------------------------------------
// Dockerfile discovery
// ---------------------------------------------------------------------------

// ErrNoDockerfile is returned by FindDockerfile when no Dockerfile can be located.
// Use errors.Is to check for it.
var ErrNoDockerfile = errors.New("no Dockerfile found")

// FindDockerfile resolves the Dockerfile to use.
// Priority: CLI override > cfg.DockerfilePath > standard search paths.
// Returns ErrNoDockerfile if nothing is found — callers should offer to run
// "hydra config init" in that case.
func FindDockerfile(cfg *Config, projectRoot, override string) (string, error) {
	if override != "" {
		if _, err := os.Stat(override); err != nil {
			return "", fmt.Errorf("dockerfile %q: %w", override, err)
		}
		return override, nil
	}

	if cfg.DockerfilePath != "" {
		if _, err := os.Stat(cfg.DockerfilePath); err == nil {
			return cfg.DockerfilePath, nil
		}
		return "", fmt.Errorf("configured dockerfile %q not found", cfg.DockerfilePath)
	}

	for _, p := range dockerfileSearchPaths(projectRoot) {
		if _, err := os.Stat(p); err == nil {
			return p, nil
		}
	}

	return "", ErrNoDockerfile
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

// DefaultDockerfilePath returns the conventional project-local Dockerfile location.
func DefaultDockerfilePath(projectRoot string) string {
	return filepath.Join(projectRoot, ".hydra", "Dockerfile")
}

// ---------------------------------------------------------------------------
// Dockerfile writing
// ---------------------------------------------------------------------------

// WriteDockerfile writes the template for the given agent to path,
// creating parent directories as needed.
func WriteDockerfile(agent AgentType, path string) error {
	tmpl, ok := DockerfileTemplates[agent]
	if !ok {
		return fmt.Errorf("unknown agent type %q; valid: claude, gemini", agent)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return errors.Wrapf(err, "create directory")
	}
	return os.WriteFile(path, []byte(tmpl), 0644)
}
