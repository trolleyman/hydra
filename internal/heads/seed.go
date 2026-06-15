package heads

import (
	"fmt"
	"os"
	"os/exec"
	"path"
	"path/filepath"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/paths"
	"github.com/trolleyman/hydra/internal/sandbox"
)

// seedResult holds the per-head sandbox inputs produced by seedHead.
type seedResult struct {
	// Binds are host->sandbox file binds for agent config (Linux only; macOS
	// sandbox-exec has no bind mounts).
	Binds []sandbox.Bind
	// WritablePaths are extra paths made writable inside the sandbox (the
	// per-head status files, kept at their real host paths so the daemon's
	// poller reads the agent's writes directly). Works on both platforms.
	WritablePaths []string
	// Env are extra environment variables (HYDRA_STATUS_PATH etc.).
	Env []string
}

// seedHead generates the per-head agent configuration (hook settings, trust,
// status files) into the project cache and returns the sandbox inputs to expose
// them.
//
// The agent runs as the host user with the real HOME, so credentials and
// conversation history (~/.claude, ~/.gemini, ...) come from the host (made
// writable by the sandbox defaults). The status files stay at their real host
// paths (made writable + pointed at via HYDRA_STATUS_PATH) so reporting works on
// both Linux and macOS. Hooks invoke the hydra binary at its real path, visible
// inside the sandbox via the read-only root bind.
func seedHead(projectRoot, id string, agentType sandbox.AgentType, worktreePath, home string) (*seedResult, error) {
	hydraDir := paths.GetHydraDirFromProjectRoot(projectRoot)
	cacheDir := filepath.Join(hydraDir, "cache")
	if err := paths.CreateGitignoreAllInDir(cacheDir); err != nil {
		return nil, errtrace.Wrap(err)
	}

	res := &seedResult{}

	// Per-head status JSON + log, kept at their real host paths and made
	// writable so the agent writes them directly (the poller reads the same
	// files). HYDRA_STATUS_PATH/LOG tell trigger-hook where to write.
	statusJSONHost := paths.GetStatusJsonFromProjectRoot(projectRoot, id)
	if err := paths.CreateGitignoreAllInDir(filepath.Dir(statusJSONHost)); err != nil {
		return nil, errtrace.Wrap(err)
	}
	if err := os.WriteFile(statusJSONHost, []byte("{}"), 0644); err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("write %s: %w", statusJSONHost, err))
	}
	statusLogHost := paths.GetStatusLogFromProjectRoot(projectRoot, id)
	if err := os.WriteFile(statusLogHost, []byte(""), 0644); err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("write %s: %w", statusLogHost, err))
	}
	res.WritablePaths = append(res.WritablePaths, statusJSONHost, statusLogHost)
	res.Env = append(res.Env,
		"HYDRA_STATUS_PATH="+statusJSONHost,
		"HYDRA_STATUS_LOG_PATH="+statusLogHost,
	)

	// The hydra binary's real path, so hooks can invoke it. Visible read-only
	// inside the sandbox via the root bind.
	hydraBin, err := os.Executable()
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("resolve hydra binary: %w", err))
	}

	switch agentType {
	case sandbox.AgentTypeClaude:
		settingsHost := filepath.Join(cacheDir, "claude-settings.json")
		merged, err := sandbox.BuildClaudeSettings(readHostFile(filepath.Join(home, ".claude", "settings.json")), hydraBin)
		if err != nil {
			return nil, errtrace.Wrap(err)
		}
		if err := os.WriteFile(settingsHost, merged, 0644); err != nil {
			return nil, errtrace.Wrap(err)
		}
		res.Binds = append(res.Binds, sandbox.Bind{Source: settingsHost, Target: path.Join(home, ".claude", "settings.json")})

		claudeJSONHost := filepath.Join(cacheDir, "claude.json")
		cfg, err := sandbox.BuildClaudeConfig(readHostFile(filepath.Join(home, ".claude.json")), worktreePath)
		if err != nil {
			return nil, errtrace.Wrap(err)
		}
		if err := os.WriteFile(claudeJSONHost, cfg, 0644); err != nil {
			return nil, errtrace.Wrap(err)
		}
		res.Binds = append(res.Binds, sandbox.Bind{Source: claudeJSONHost, Target: path.Join(home, ".claude.json")})

	case sandbox.AgentTypeGemini:
		settingsHost := filepath.Join(cacheDir, "gemini-settings.json")
		merged, err := sandbox.BuildGeminiSettings(readHostFile(filepath.Join(home, ".gemini", "settings.json")), hydraBin)
		if err != nil {
			return nil, errtrace.Wrap(err)
		}
		if err := os.WriteFile(settingsHost, merged, 0644); err != nil {
			return nil, errtrace.Wrap(err)
		}
		res.Binds = append(res.Binds, sandbox.Bind{Source: settingsHost, Target: path.Join(home, ".gemini", "settings.json")})

	case sandbox.AgentTypeCopilot:
		// Copilot loads hooks from .github/hooks/ in the (writable) worktree.
		hooksDir := filepath.Join(worktreePath, ".github", "hooks")
		if err := os.MkdirAll(hooksDir, 0755); err != nil {
			return nil, errtrace.Wrap(err)
		}
		hooksData, err := sandbox.BuildCopilotHooks(hydraBin)
		if err != nil {
			return nil, errtrace.Wrap(err)
		}
		if err := os.WriteFile(filepath.Join(hooksDir, "hydra.json"), hooksData, 0644); err != nil {
			return nil, errtrace.Wrap(err)
		}
	}

	return res, nil
}

// readHostFile returns the file contents or nil if it can't be read.
func readHostFile(p string) []byte {
	data, err := os.ReadFile(p)
	if err != nil {
		return nil
	}
	return data
}

// agentEnv builds the environment for the sandboxed agent process.
func agentEnv(home, username string, gitAuthorName, gitAuthorEmail string) []string {
	env := append([]string{}, os.Environ()...)
	env = append(env,
		"HOME="+home,
		"USER="+username,
		"LANG=C.UTF-8",
		"TERM=xterm-256color",
		"COLORTERM=truecolor",
	)
	if gitAuthorName != "" {
		env = append(env,
			"GIT_AUTHOR_NAME="+gitAuthorName,
			"GIT_COMMITTER_NAME="+gitAuthorName,
		)
	}
	if gitAuthorEmail != "" {
		env = append(env,
			"GIT_AUTHOR_EMAIL="+gitAuthorEmail,
			"GIT_COMMITTER_EMAIL="+gitAuthorEmail,
		)
	}
	return env
}

// readGitConfigVal reads a single git config value from the project.
func readGitConfigVal(projectRoot, key string) string {
	out, err := exec.Command("git", "-C", projectRoot, "config", "--get", key).Output()
	if err != nil {
		return ""
	}
	return string(trimTrailingNewline(out))
}

func trimTrailingNewline(b []byte) []byte {
	for len(b) > 0 && (b[len(b)-1] == '\n' || b[len(b)-1] == '\r') {
		b = b[:len(b)-1]
	}
	return b
}
