//go:build linux

package heads

import "os"
import "braces.dev/errtrace"

func prepareClaudeSeedLayout(projectRoot, id, home, worktreePath string, res *seedResult) (claudeSeedLayout, error) {
	if res.local {
		return errtrace.Wrap2(prepareNativeClaudeSeedLayout(projectRoot, id, home, worktreePath, res))
	}
	configDir := configuredClaudeConfigDir(home)
	if os.Getenv("CLAUDE_CONFIG_DIR") != "" {
		res.Env = append(res.Env, "CLAUDE_CONFIG_DIR="+configDir)
	}
	res.WritablePaths = append(res.WritablePaths, configDir, configuredClaudeConfigPath(home, configDir))
	return claudeSeedLayout{
		hostConfigDir:    configDir,
		hostConfigPath:   configuredClaudeConfigPath(home, configDir),
		runtimeConfigDir: configDir,
	}, nil
}
