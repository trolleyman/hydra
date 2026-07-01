package heads

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strings"
	"time"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/gate"
	"github.com/trolleyman/hydra/internal/paths"
	"github.com/trolleyman/hydra/internal/sandbox"
)

// SandboxHydraBinPath is the well-known path the hydra binary is bound to inside
// every sandbox. /tmp is always a fresh, per-head writable mount in our bwrap
// config (a private host-backed dir on Linux, else a tmpfs — see
// sandbox.Options.TmpDir), so it is a reliable mountpoint and these seeded binds
// nest on top of it. Hooks and the namespace-host supervisor invoke it here.
const SandboxHydraBinPath = "/tmp/hydra-internal"

// GateSandboxPolicyPath is the well-known path the read-only gate policy.json is
// bound to inside the sandbox (again under the reliable per-head /tmp mount). The
// in-sandbox `hydra gate` hook reads it via gate.EnvPolicyPath.
const GateSandboxPolicyPath = "/tmp/hydra-gate-policy.json"

// mcpCatalogSandboxPath is where the read-only MCP-server catalog is bound inside
// the sandbox (read by `hydra mcp` via gate.EnvMCPCatalogPath).
const mcpCatalogSandboxPath = "/tmp/hydra-mcp-catalog.json"

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
	// ROOverlays expose per-head files under otherwise read-only system dirs via a
	// read-only overlay — e.g. /etc/claude-code/managed-settings.json under /etc.
	// See sandbox.ROOverlay (a tmpfs mountpoint can't be created under the
	// read-only root, so an overlay over the parent dir is used instead).
	ROOverlays []sandbox.ROOverlay
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
// Gemini, Copilot and Codex have no such flag, so for them the instructions are
// seeded here as context files (~/.gemini/GEMINI.md,
// ~/.copilot/copilot-instructions.md, ~/.codex/AGENTS.md), merged on top of any
// the host user already has.
func seedHead(projectRoot, id string, agentType sandbox.AgentType, worktreePath, home, prePrompt string, policy gate.Policy) (*seedResult, error) {
	cacheDir := paths.GetCacheDirFromProjectRoot(projectRoot)
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
	// Bind the hydra binary to a well-known path inside the sandbox.
	stableHydraBin := SandboxHydraBinPath
	res.Binds = append(res.Binds, sandbox.Bind{
		Source:   hydraBin,
		Target:   stableHydraBin,
		ReadOnly: true,
	})

	switch agentType {
	case sandbox.AgentTypeClaude:
		// Hooks (status + gate), skip-dangerous, and the MCP allow-list go into
		// Claude's MANAGED settings, bound read-only at the system managed path. This
		// is the only tamper-proof scope: managed hooks keep running even if the agent
		// writes {"disableAllHooks": true} into a writable user/project settings.json
		// (which a read-only ~/.claude/settings.json bind could NOT prevent, since the
		// agent can still create a project-scope .claude/settings.json). We therefore
		// do NOT seed ~/.claude/settings.json at all — the user's own settings apply
		// normally and our policy layers on top authoritatively. (AUDIT.md F4.)
		// The set of MCP servers KEPT in the seeded config: whole-server grants plus
		// any server referenced by a per-tool grant (so a partially-allowed server
		// still spawns and the runtime gate enforces the per-tool subset).
		mcpKeep := mcpKeepSet(policy.MCPAllowed, policy.MCPToolsAllowed)
		managed, err := sandbox.BuildClaudeSettings(nil, stableHydraBin, policy.GateEnabled, mcpKeep)
		if err != nil {
			return nil, errtrace.Wrap(err)
		}
		// Claude reads tamper-proof managed settings only from the fixed system path
		// /etc/claude-code/managed-settings.json (not relocatable). That dir doesn't
		// exist on the host and lives under the read-only `/` bind, so bwrap can't
		// mkdir a tmpfs mountpoint there. Instead expose it via a read-only overlay
		// over /etc: write the file into a per-head upper layer that mirrors /etc's
		// layout and union it on top of the real /etc (see sandbox.ROOverlay).
		etcUpper := filepath.Join(cacheDir, "claude-etc-overlay", id)
		mirrorDir := filepath.Join(etcUpper, filepath.Base(sandbox.ClaudeManagedSettingsDir))
		if err := os.MkdirAll(mirrorDir, 0o755); err != nil {
			return nil, errtrace.Wrap(err)
		}
		managedFile := filepath.Join(mirrorDir, filepath.Base(sandbox.ClaudeManagedSettingsPath))
		if err := os.WriteFile(managedFile, managed, 0644); err != nil {
			return nil, errtrace.Wrap(err)
		}
		res.ROOverlays = append(res.ROOverlays, sandbox.ROOverlay{
			Dir:   filepath.Dir(sandbox.ClaudeManagedSettingsDir),
			Upper: etcUpper,
		})

		hostClaudeJSON := readHostFile(filepath.Join(home, ".claude.json"))
		claudeJSONHost := filepath.Join(cacheDir, "claude.json")
		cfg, err := sandbox.BuildClaudeConfig(hostClaudeJSON, worktreePath, mcpKeep, stableHydraBin, string(agentType))
		if err != nil {
			return nil, errtrace.Wrap(err)
		}
		if err := os.WriteFile(claudeJSONHost, cfg, 0644); err != nil {
			return nil, errtrace.Wrap(err)
		}
		res.Binds = append(res.Binds, sandbox.Bind{Source: claudeJSONHost, Target: path.Join(home, ".claude.json")})

		// Seed the catalog of host-configured MCP servers so the `hydra mcp` control
		// server can tell the agent which servers it may request access to.
		if err := seedMCPCatalog(res, cacheDir, id, projectRoot, hostClaudeJSON); err != nil {
			return nil, errtrace.Wrap(err)
		}

		// Seed the decision gate's inputs: a read-only policy.json the in-sandbox
		// hook reads, and a per-head writable approval directory for the "ask"
		// round-trip. Only when the gate is enabled (otherwise no hook reads them).
		if policy.GateEnabled {
			if err := seedGatePolicy(res, cacheDir, id, projectRoot, worktreePath, home, policy); err != nil {
				return nil, errtrace.Wrap(err)
			}
		}

	case sandbox.AgentTypeGemini:
		settingsHost := filepath.Join(cacheDir, "gemini-settings.json")
		merged, err := sandbox.BuildGeminiSettings(readHostFile(filepath.Join(home, ".gemini", "settings.json")), stableHydraBin)
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
		hooksData, err := sandbox.BuildCopilotHooks(stableHydraBin)
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

	case sandbox.AgentTypeCodex:
		// Codex has no --append-system-prompt and no hook system we wire up; it
		// reads standing guidance from AGENTS.md files. Deliver the pre-prompt as
		// the global ~/.codex/AGENTS.md (merged over the host's), which applies to
		// every Codex session regardless of the repo's own AGENTS.md.
		if prePrompt != "" {
			agentsHost := filepath.Join(cacheDir, "codex-AGENTS.md")
			content := combineInstructions(prePrompt, readHostFile(filepath.Join(home, ".codex", "AGENTS.md")))
			if err := os.WriteFile(agentsHost, content, 0644); err != nil {
				return nil, errtrace.Wrap(err)
			}
			res.Binds = append(res.Binds, sandbox.Bind{Source: agentsHost, Target: path.Join(home, ".codex", "AGENTS.md")})
		}
	}

	return res, nil
}

// resolveGatePolicy converts the trusted per-agent config policy into the
// gate.Policy seeded into the sandbox. Home/WorktreePath are filled later by
// seedGatePolicy. gate_enabled defaults to true (opt-out).
func resolveGatePolicy(cfg config.Config, agentType string) gate.Policy {
	p := cfg.ResolvePolicy(agentType)
	return gate.Policy{
		GateEnabled:        p.IsGateEnabled(),
		MCPAllowed:         p.MCPAllowed,
		MCPToolsAllowed:    p.MCPToolsAllowed,
		AutoAllowReadMCP:   p.MCPAutoAllowRead != nil && *p.MCPAutoAllowRead,
		WebFetchAllowHosts: p.WebFetchAllowHosts,
	}
}

// seedMCPCatalog writes the read-only catalog of host-configured MCP servers
// (host ~/.claude.json + project .mcp.json) into the sandbox and points
// gate.EnvMCPCatalogPath at it, so the `hydra mcp` control server can offer them
// for the agent to request. Best-effort: an empty catalog just means the agent
// has nothing extra to request.
func seedMCPCatalog(res *seedResult, cacheDir, id, projectRoot string, hostClaudeJSON []byte) error {
	mcpJSON := readHostFile(filepath.Join(projectRoot, ".mcp.json"))
	catalog := sandbox.ListMCPServers(hostClaudeJSON, mcpJSON)
	data, err := json.Marshal(catalog)
	if err != nil {
		return errtrace.Wrap(err)
	}
	catalogHost := filepath.Join(cacheDir, id+"-mcp-catalog.json")
	if err := os.WriteFile(catalogHost, data, 0644); err != nil {
		return errtrace.Wrap(err)
	}
	res.Binds = append(res.Binds, sandbox.Bind{Source: catalogHost, Target: mcpCatalogSandboxPath, ReadOnly: true})
	res.Env = append(res.Env, gate.EnvMCPCatalogPath+"="+mcpCatalogSandboxPath)
	return nil
}

// mcpKeepSet returns the MCP servers to keep in the seeded config: the
// whole-server allow-list plus the server segment of every per-tool grant
// ("<server>__<tool>" → "<server>"). A partially-allowed server must be kept so
// it spawns; the runtime gate then enforces which of its tools are permitted.
func mcpKeepSet(serversAllowed, toolsAllowed []string) []string {
	seen := map[string]bool{}
	var out []string
	add := func(s string) {
		if s != "" && !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	for _, s := range serversAllowed {
		add(s)
	}
	for _, t := range toolsAllowed {
		server, _, _ := strings.Cut(t, "__")
		add(server)
	}
	return out
}

// seedGatePolicy writes the trusted gate policy.json (bound read-only into the
// sandbox at GateSandboxPolicyPath) and provisions the per-head writable approval
// directory used for the "ask" round-trip, wiring both via env vars the
// `hydra gate` hook reads. The policy's Home/WorktreePath are filled here so the
// in-sandbox hook can resolve the credential/policy paths it protects.
func seedGatePolicy(res *seedResult, cacheDir, id, projectRoot, worktreePath, home string, policy gate.Policy) error {
	policy.Home = home
	policy.WorktreePath = worktreePath

	policyHost := filepath.Join(cacheDir, id+"-gate-policy.json")
	if err := policy.Save(policyHost); err != nil {
		return errtrace.Wrap(err)
	}
	res.Binds = append(res.Binds, sandbox.Bind{Source: policyHost, Target: GateSandboxPolicyPath, ReadOnly: true})
	res.Env = append(res.Env, gate.EnvPolicyPath+"="+GateSandboxPolicyPath)

	approvalDir := paths.GetApprovalsDirFromProjectRoot(projectRoot, id)
	if err := os.MkdirAll(approvalDir, 0755); err != nil {
		return errtrace.Wrap(err)
	}
	res.WritablePaths = append(res.WritablePaths, approvalDir)
	res.Env = append(res.Env, gate.EnvApprovalDir+"="+approvalDir)
	return nil
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
	// `.hydra/local/cache` inside the sandbox (EROFS crash). We capture the default
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
// Gemini try to write into the read-only `.hydra/local/cache` inside the sandbox and
// crash with EROFS. seedGeminiPrePrompt sets the ones it wants explicitly.
var envKeysHydraOwns = map[string]bool{
	"GEMINI_SYSTEM_MD":       true,
	"GEMINI_WRITE_SYSTEM_MD": true,
	// HYDRA_* head-context variables (see headContextEnv): set per-head, so
	// never inherit a stale value from the daemon's own environment.
	"HYDRA_HEAD_ID":      true,
	"HYDRA_AGENT_TYPE":   true,
	"HYDRA_PROJECT_ROOT": true,
	"HYDRA_WORKTREE":     true,
	"HYDRA_BRANCH":       true,
	"HYDRA_BASE_BRANCH":  true,
}

// headContextEnv returns the HYDRA_* environment variables describing the head
// being launched. They are exposed to the pre-spawn script (and, since they
// share the same environment, the agent/shell process) so per-spawn setup can
// branch on the head's identity, agent type and git layout — e.g. seeding only
// for a given agent, or copying files into the worktree.
//
// Keep this set, envKeysHydraOwns above, and the Pre-Spawn Script tooltip in
// web/src/components/SettingsComponents.tsx in sync.
// derefStr returns the pointed-to string, or "" when the pointer is nil.
func derefStr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func headContextEnv(id string, agentType sandbox.AgentType, projectRoot, worktreePath, branch, baseBranch string) []string {
	return []string{
		"HYDRA_HEAD_ID=" + id,
		"HYDRA_AGENT_TYPE=" + string(agentType),
		"HYDRA_PROJECT_ROOT=" + projectRoot,
		"HYDRA_WORKTREE=" + worktreePath,
		"HYDRA_BRANCH=" + branch,
		"HYDRA_BASE_BRANCH=" + baseBranch,
	}
}

// claudeRenderingEnv pins Claude Code's renderer for an agent launch (spawn and
// resume alike). Claude's fullscreen rendering draws on the terminal's alternate
// screen buffer and captures the mouse — which, in Hydra's web (xterm.js)
// terminal, breaks the native scrollbar and select-to-copy and pops a one-time
// "try it?" opt-in prompt that the resume "Continue" nudge accidentally answers.
// So by default (fullscreen=false) we force the classic renderer; when the user
// opts in via config we enable fullscreen explicitly. Setting the env either way
// makes Hydra authoritative over any saved `tui` setting in the seeded config.
// Non-Claude agents have no such mode and get nothing.
func claudeRenderingEnv(agentType sandbox.AgentType, fullscreen bool) []string {
	if agentType != sandbox.AgentTypeClaude {
		return nil
	}
	if fullscreen {
		return []string{"CLAUDE_CODE_NO_FLICKER=1"}
	}
	return []string{"CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1"}
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
