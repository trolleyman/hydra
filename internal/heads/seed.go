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

// seedHead generates the per-head agent configuration (hook settings, trust,
// status files) into the project cache and returns the sandbox binds + env
// needed to expose them inside the sandbox at the agent's HOME.
//
// Unlike the old Docker path, the agent runs as the host user with the real
// HOME, so credentials and conversation history (~/.claude, ~/.gemini, ...) come
// from the host (made writable by the sandbox defaults). We only override the
// individual settings files that register Hydra's hooks, and bind a per-head
// status file at $HOME/.hydra/status.json so each head reports independently.
func seedHead(projectRoot, id string, agentType sandbox.AgentType, worktreePath, home string) ([]sandbox.Bind, []string, error) {
	hydraDir := paths.GetHydraDirFromProjectRoot(projectRoot)
	cacheDir := filepath.Join(hydraDir, "cache")
	if err := paths.CreateGitignoreAllInDir(cacheDir); err != nil {
		return nil, nil, errtrace.Wrap(err)
	}

	var binds []sandbox.Bind
	hydraHome := path.Join(home, ".hydra")

	// $HOME/.hydra must exist on the host so the sandbox can overlay it with a
	// writable tmpfs (the mount target must already exist under the read-only
	// root). The tmpfs dir itself is returned to the caller.
	if err := os.MkdirAll(hydraHome, 0755); err != nil {
		return nil, nil, errtrace.Wrap(fmt.Errorf("create %s: %w", hydraHome, err))
	}
	tmpfsDirs := []string{hydraHome}

	// Per-head status JSON (truncated fresh) bound at $HOME/.hydra/status.json.
	statusJsonHost := paths.GetStatusJsonFromProjectRoot(projectRoot, id)
	if err := paths.CreateGitignoreAllInDir(filepath.Dir(statusJsonHost)); err != nil {
		return nil, nil, errtrace.Wrap(err)
	}
	if err := os.WriteFile(statusJsonHost, []byte("{}"), 0644); err != nil {
		return nil, nil, errtrace.Wrap(fmt.Errorf("write %s: %w", statusJsonHost, err))
	}
	binds = append(binds, sandbox.Bind{Source: statusJsonHost, Target: path.Join(hydraHome, "status.json")})

	// Per-head status log JSONL.
	statusLogHost := paths.GetStatusLogFromProjectRoot(projectRoot, id)
	if err := os.WriteFile(statusLogHost, []byte(""), 0644); err != nil {
		return nil, nil, errtrace.Wrap(fmt.Errorf("write %s: %w", statusLogHost, err))
	}
	binds = append(binds, sandbox.Bind{Source: statusLogHost, Target: path.Join(hydraHome, "status_log.jsonl")})

	// The hydra binary itself, so hook commands ($HOME/.hydra/hydra) work. The
	// agent runs natively on the host OS, so the current executable is correct.
	hydraBin, err := os.Executable()
	if err != nil {
		return nil, nil, errtrace.Wrap(fmt.Errorf("resolve hydra binary: %w", err))
	}
	binds = append(binds, sandbox.Bind{Source: hydraBin, Target: path.Join(hydraHome, "hydra"), ReadOnly: true})

	switch agentType {
	case sandbox.AgentTypeClaude:
		settingsHost := filepath.Join(cacheDir, "claude-settings.json")
		merged, err := sandbox.BuildClaudeSettings(readHostFile(filepath.Join(home, ".claude", "settings.json")))
		if err != nil {
			return nil, nil, errtrace.Wrap(err)
		}
		if err := os.WriteFile(settingsHost, merged, 0644); err != nil {
			return nil, nil, errtrace.Wrap(err)
		}
		binds = append(binds, sandbox.Bind{Source: settingsHost, Target: path.Join(home, ".claude", "settings.json")})

		claudeJsonHost := filepath.Join(cacheDir, "claude.json")
		cfg, err := sandbox.BuildClaudeConfig(readHostFile(filepath.Join(home, ".claude.json")), worktreePath)
		if err != nil {
			return nil, nil, errtrace.Wrap(err)
		}
		if err := os.WriteFile(claudeJsonHost, cfg, 0644); err != nil {
			return nil, nil, errtrace.Wrap(err)
		}
		binds = append(binds, sandbox.Bind{Source: claudeJsonHost, Target: path.Join(home, ".claude.json")})

	case sandbox.AgentTypeGemini:
		settingsHost := filepath.Join(cacheDir, "gemini-settings.json")
		merged, err := sandbox.BuildGeminiSettings(readHostFile(filepath.Join(home, ".gemini", "settings.json")))
		if err != nil {
			return nil, nil, errtrace.Wrap(err)
		}
		if err := os.WriteFile(settingsHost, merged, 0644); err != nil {
			return nil, nil, errtrace.Wrap(err)
		}
		binds = append(binds, sandbox.Bind{Source: settingsHost, Target: path.Join(home, ".gemini", "settings.json")})

	case sandbox.AgentTypeCopilot:
		// Copilot loads hooks from .github/hooks/ in the (writable) worktree.
		hooksDir := filepath.Join(worktreePath, ".github", "hooks")
		if err := os.MkdirAll(hooksDir, 0755); err != nil {
			return nil, nil, errtrace.Wrap(err)
		}
		hooksData, err := sandbox.BuildCopilotHooks()
		if err != nil {
			return nil, nil, errtrace.Wrap(err)
		}
		if err := os.WriteFile(filepath.Join(hooksDir, "hydra.json"), hooksData, 0644); err != nil {
			return nil, nil, errtrace.Wrap(err)
		}
	}

	return binds, tmpfsDirs, nil
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
