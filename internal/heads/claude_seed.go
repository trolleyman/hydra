package heads

import (
	"os"
	"path/filepath"
)

type claudeSeedLayout struct {
	hostConfigDir    string
	hostConfigPath   string
	runtimeConfigDir string
	native           bool
}

func configuredClaudeConfigDir(home string) string {
	if dir := os.Getenv("CLAUDE_CONFIG_DIR"); dir != "" {
		return dir
	}
	return filepath.Join(home, ".claude")
}

func configuredClaudeConfigPath(home, configDir string) string {
	if os.Getenv("CLAUDE_CONFIG_DIR") != "" {
		return filepath.Join(configDir, ".claude.json")
	}
	return filepath.Join(home, ".claude.json")
}

func (l claudeSeedLayout) settingsPath() string {
	return filepath.Join(l.runtimeConfigDir, "settings.json")
}

func (l claudeSeedLayout) configPath() string {
	return filepath.Join(l.runtimeConfigDir, ".claude.json")
}

func (l claudeSeedLayout) configSourcePath() string {
	if l.native {
		if _, err := os.Stat(l.configPath()); err == nil {
			return l.configPath()
		}
	}
	return l.hostConfigPath
}
