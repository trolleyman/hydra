package config

import (
	"embed"
	"fmt"
	"io"
	"io/fs"
	"maps"
	"os"
	"path/filepath"

	"github.com/BurntSushi/toml"
	"github.com/cockroachdb/errors"
)

//go:embed default/*
var defaultFS embed.FS

// Source describes a directory with a human-readable label.
// The config should be called config.toml in this directory, and any relative
// config paths refer to other files in this directory.
type Source struct {
	Label     string // "system", "global", "project", or "default"
	Directory fs.FS
}

// Sources returns all config file locations in ascending priority order
// (system < global < project < default (builtin embedded config)).
// The project entry is omitted when projectRoot is empty.
func Sources(projectRoot string) []Source {
	srcs := []Source{
		{"system", os.DirFS("/etc/hydra")},
	}
	if home, err := os.UserHomeDir(); err == nil {
		srcs = append(srcs, Source{
			"global",
			os.DirFS(filepath.Join(home, ".config", "hydra")),
		})
	}
	if projectRoot != "" {
		srcs = append(srcs, Source{
			"project",
			os.DirFS(filepath.Join(projectRoot, ".hydra")),
		})
	}
	srcs = append(srcs, Source{
		"default",
		defaultFS,
	})
	return srcs
}

type ValueSource[T any] struct {
	Value  T
	Source *Source
}

// rawConfig is the raw toml extracted from a rawConfig.toml file
type rawConfig struct {
	Prompt *string `toml:"prompt"`
	Agent  *string `toml:"agent"`
	Agents map[string]struct {
		Dockerfile string `toml:"dockerfile"`
	} `toml:"agents"`
}

func (config *rawConfig) toConfig(source *Source) (*Config, error) {
	var prompt *ValueSource[string]
	prompt = nil
	if config.Prompt != nil {
		prompt = &ValueSource[string]{
			Value:  *config.Prompt,
			Source: source,
		}
	}
	var agent *ValueSource[string]
	agent = nil
	if config.Agent != nil {
		agent = &ValueSource[string]{
			Value:  *config.Agent,
			Source: source,
		}
	}
	agents := make(map[string]ValueSource[Agent])
	for k, v := range config.Agents {
		if v.Dockerfile == "" {
			return nil, errors.Newf("no dockerfile path set in %v source: %v/config.toml", source.Label, source.Directory)
		}
		file, err := source.Directory.Open(v.Dockerfile)
		if err != nil {
			return nil, errors.Wrapf(err, "failed to open: %v/%v", source.Directory, v.Dockerfile)
		}
		defer file.Close()
		dockerfileRequiresCopy := false
		var dockerfile string
		switch source.Directory.(type) {
		case embed.FS:
			dockerfileRequiresCopy = true
		default:
			dockerfile = filepath.Join(fmt.Sprintf("%v", source.Directory), v.Dockerfile)
			_, err := os.Stat(dockerfile)
			dockerfileRequiresCopy = errors.Is(err, fs.ErrNotExist)
		}
		if dockerfileRequiresCopy {
			// Copy to state dir
			homedir, err := os.UserHomeDir()
			if err != nil {
				return nil, errors.Wrapf(err, "get home directory")
			}
			dockerfile = filepath.Join(homedir, ".cache", "hydra", "dockerfiles", v.Dockerfile)
			err = os.MkdirAll(filepath.Base(dockerfile), 0755)
			if err != nil {
				return nil, errors.Wrapf(err, "create dockerfile directory")
			}
			newDockerfile, err := os.Create(dockerfile)
			if err != nil {
				return nil, errors.Wrapf(err, "create dockerfile")
			}
			defer newDockerfile.Close()
			if _, err := io.Copy(newDockerfile, file); err != nil {
				return nil, errors.Wrapf(err, "copy dockerfile content")
			}
		}
		agents[k] = ValueSource[Agent]{
			Value: Agent{
				Dockerfile: dockerfile,
			},
			Source: source,
		}
	}
	return &Config{
		Prompt: prompt,
		Agent:  agent,
		Agents: agents,
	}, nil
}

// Config holds the merged Hydra configuration.
type Config struct {
	// Prompt is prepended to every agent prompt.
	Prompt *ValueSource[string] `toml:"prompt"`
	// Agent is the agent that is used when spawning a new agent.
	Agent *ValueSource[string] `toml:"agent"`
	// Agents contains a list of agents that are defined.
	Agents map[string]ValueSource[Agent] `toml:"agents"`
}

// Agent contains the config for how to start an agent
type Agent struct {
	// Dockerfile for that agent
	Dockerfile string
}

func (config *Config) MergeIn(otherConfig *Config) {
	if otherConfig.Prompt != nil {
		config.Prompt = otherConfig.Prompt
	}
	if otherConfig.Agent != nil {
		config.Agent = otherConfig.Agent
	}
	// Override agent config fully
	maps.Copy(config.Agents, otherConfig.Agents)
}

// Load reads all applicable config files (system →  global →  project -> builtin) and returns
// the merged Config. Viper defaults are applied when a key is unset in all files.
func Load(projectRoot string) (*Config, error) {
	config := &Config{}
	for _, src := range Sources(projectRoot) {
		file, err := src.Directory.Open("config.toml")
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, errors.Wrapf(err, "failed to open: %v/config.toml", src.Directory)
		}
		defer file.Close()

		raw_config := rawConfig{}
		_, err = toml.NewDecoder(file).Decode(&raw_config)
		if err != nil {
			return nil, errors.Wrapf(err, "failed to parse config: %v/config.toml", src.Directory)
		}
		otherConfig, err := raw_config.toConfig(&src)
		if err != nil {
			return nil, errors.Wrapf(err, "failed to parse config: %v/config.toml", src.Directory)
		}
		config.MergeIn(otherConfig)
	}
	if config.Prompt == nil {
		return nil, errors.New("no prompt set")
	}
	if config.Agent == nil {
		return nil, errors.New("no agent set")
	}
	_, ok := config.Agents[config.Agent.Value]
	if !ok {
		return nil, errors.Newf("agent %q not defined in any config file", config.Agent.Value)
	}
	return config, nil
}
