package heads

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strings"
	"time"

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
//
// prePrompt holds the standing Hydra instructions delivered as a system prompt.
// Claude receives them via --append-system-prompt (see sandbox.AgentArgv), but
// Gemini and Copilot have no such flag, so for them the instructions are seeded
// here as context files (~/.gemini/GEMINI.md, ~/.copilot/copilot-instructions.md),
// merged on top of any the host user already has.
func seedHead(projectRoot, id string, agentType sandbox.AgentType, worktreePath, home, prePrompt string) (*seedResult, error) {
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

		if prePrompt != "" {
			if err := seedGeminiPrePrompt(res, cacheDir, home, prePrompt); err != nil {
				return nil, errtrace.Wrap(err)
			}
		}

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

		// Copilot has no --append-system-prompt; deliver the pre-prompt as the
		// home-dir custom instructions (~/.copilot/copilot-instructions.md),
		// merged over the host's.
		if prePrompt != "" {
			instrHost := filepath.Join(cacheDir, "copilot-instructions.md")
			content := combineInstructions(prePrompt, readHostFile(filepath.Join(home, ".copilot", "copilot-instructions.md")))
			if err := os.WriteFile(instrHost, content, 0644); err != nil {
				return nil, errtrace.Wrap(err)
			}
			res.Binds = append(res.Binds, sandbox.Bind{Source: instrHost, Target: path.Join(home, ".copilot", "copilot-instructions.md")})
		}
	}

	return res, nil
}

// seedGeminiPrePrompt delivers the pre-prompt to Gemini, which has no
// --append-system-prompt flag. Preferred path: capture Gemini's built-in system
// prompt (GEMINI_WRITE_SYSTEM_MD, cached per CLI version), append the pre-prompt,
// and point GEMINI_SYSTEM_MD at the combined file — a true system prompt of
// "default + our rules". If the default can't be captured (e.g. gemini is not
// authenticated, or offline), fall back to seeding the pre-prompt as a GEMINI.md
// context file, which is loaded as instructional context instead.
func seedGeminiPrePrompt(res *seedResult, cacheDir, home, prePrompt string) error {
	// Never let Gemini write its default system prompt into the read-only
	// `.hydra/cache` inside the sandbox (EROFS crash). We capture the default
	// ourselves on the host below; the agent only ever reads via GEMINI_SYSTEM_MD.
	res.Env = append(res.Env, "GEMINI_WRITE_SYSTEM_MD=")

	if dflt := geminiDefaultSystemPrompt(cacheDir); dflt != "" {
		combined := strings.TrimRight(dflt, "\n") + "\n\n" + prePrompt + "\n"
		sysHost := filepath.Join(cacheDir, "gemini-system.md")
		if err := os.WriteFile(sysHost, []byte(combined), 0644); err != nil {
			return errtrace.Wrap(err)
		}
		target := path.Join(home, ".gemini", "hydra-system.md")
		res.Binds = append(res.Binds, sandbox.Bind{Source: sysHost, Target: target})
		res.Env = append(res.Env, "GEMINI_SYSTEM_MD="+target)
		return nil
	}

	// Fallback: GEMINI.md context file, merged over the host's global one.
	ctxHost := filepath.Join(cacheDir, "gemini-context.md")
	content := combineInstructions(prePrompt, readHostFile(filepath.Join(home, ".gemini", "GEMINI.md")))
	if err := os.WriteFile(ctxHost, content, 0644); err != nil {
		return errtrace.Wrap(err)
	}
	res.Binds = append(res.Binds, sandbox.Bind{Source: ctxHost, Target: path.Join(home, ".gemini", "GEMINI.md")})
	return nil
}

// geminiDefaultSystemPrompt returns Gemini's built-in system prompt, captured
// once per CLI version and cached under cacheDir. Returns "" if it can't be
// captured; a per-version marker prevents repeated slow capture attempts.
func geminiDefaultSystemPrompt(cacheDir string) string {
	if _, err := exec.LookPath("gemini"); err != nil {
		return ""
	}
	ver := geminiVersion()
	if ver == "" {
		return ""
	}
	cacheFile := filepath.Join(cacheDir, "gemini-default-system-"+ver+".md")
	if b := readHostFile(cacheFile); len(trimTrailingNewline(b)) > 0 {
		return string(b)
	}
	unavailable := cacheFile + ".unavailable"
	if _, err := os.Stat(unavailable); err == nil {
		return "" // already tried for this version and failed
	}

	// GEMINI_WRITE_SYSTEM_MD makes gemini dump its default system prompt to the
	// given file. It only writes once it builds a turn, so run a trivial headless
	// prompt, time-boxed. Best-effort: failures are non-fatal.
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "gemini", "-p", "ok")
	cmd.Env = append(os.Environ(), "GEMINI_WRITE_SYSTEM_MD="+cacheFile)
	cmd.Dir = cacheDir
	_ = cmd.Run()

	if b := readHostFile(cacheFile); len(trimTrailingNewline(b)) > 0 {
		return string(b)
	}
	_ = os.WriteFile(unavailable, []byte(ver), 0644)
	return ""
}

// geminiVersion returns a filename-safe gemini CLI version string, or "".
func geminiVersion() string {
	out, err := exec.Command("gemini", "--version").Output()
	if err != nil {
		return ""
	}
	v := strings.TrimSpace(string(out))
	return strings.NewReplacer("/", "_", " ", "_", string(os.PathSeparator), "_").Replace(v)
}

// combineInstructions builds an agent context/instructions file from Hydra's
// pre-prompt and whatever the host user already has. Hydra's instructions go
// last so they take precedence.
func combineInstructions(prePrompt string, host []byte) []byte {
	host = trimTrailingNewline(host)
	if len(host) == 0 {
		return []byte(prePrompt + "\n")
	}
	return []byte(string(host) + "\n\n" + prePrompt + "\n")
}

// readHostFile returns the file contents or nil if it can't be read.
func readHostFile(p string) []byte {
	data, err := os.ReadFile(p)
	if err != nil {
		return nil
	}
	return data
}

// envKeysHydraOwns are environment variables Hydra controls per-head and must
// not inherit from the daemon's own environment, or they leak into every agent.
// In particular GEMINI_SYSTEM_MD / GEMINI_WRITE_SYSTEM_MD drive where the Gemini
// CLI reads/writes its system prompt: an inherited GEMINI_WRITE_SYSTEM_MD makes
// Gemini try to write into the read-only `.hydra/cache` inside the sandbox and
// crash with EROFS. seedGeminiPrePrompt sets the ones it wants explicitly.
var envKeysHydraOwns = map[string]bool{
	"GEMINI_SYSTEM_MD":       true,
	"GEMINI_WRITE_SYSTEM_MD": true,
}

// agentEnv builds the environment for the sandboxed agent process.
func agentEnv(home, username string, gitAuthorName, gitAuthorEmail string) []string {
	env := make([]string, 0, len(os.Environ()))
	for _, kv := range os.Environ() {
		if k, _, ok := strings.Cut(kv, "="); ok && envKeysHydraOwns[k] {
			continue
		}
		env = append(env, kv)
	}
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
