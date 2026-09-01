//go:build windows

package heads

import "os"

func prepareClaudeSeedLayout(_ string, _ string, home, _ string, res *seedResult) (claudeSeedLayout, error) {
	configDir := configuredClaudeConfigDir(home)
	if os.Getenv("CLAUDE_CONFIG_DIR") != "" {
		res.Env = append(res.Env, "CLAUDE_CONFIG_DIR="+configDir)
	}
	return claudeSeedLayout{
		hostConfigDir:    configDir,
		hostConfigPath:   configuredClaudeConfigPath(home, configDir),
		runtimeConfigDir: configDir,
	}, nil
}
