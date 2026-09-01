package heads

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
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
	"github.com/trolleyman/hydra/internal/statepath"
)

// SandboxHydraBinPath is the well-known path the hydra binary is bound to inside
// every sandbox - see sandbox.HydraBinPath, which is the same path (it lives
// there because AgentArgv has to name it too, and heads already imports sandbox).
const SandboxHydraBinPath = sandbox.HydraBinPath

// GateSandboxPolicyPath is the well-known path the read-only gate policy.json is
// bound to inside the sandbox (again under the reliable per-head /tmp mount). The
// in-sandbox `hydra gate` hook reads it via gate.EnvPolicyPath.
const GateSandboxPolicyPath = "/tmp/hydra-gate-policy.json"

// mcpCatalogSandboxPath is where the read-only MCP-server catalog is bound inside
// the sandbox (read by `hydra mcp` via gate.EnvMCPCatalogPath).
const mcpCatalogSandboxPath = "/tmp/hydra-mcp-catalog.json"

// strictMCPConfigSandboxPath is where the rendered strict MCP config is bound
// (read-only) inside the sandbox, for `claude --mcp-config <path>
// --strict-mcp-config`. Under the per-head /tmp like the other seeded inputs, so
// no host process shares the path - the whole point of strict mode.
const strictMCPConfigSandboxPath = "/tmp/hydra-mcp-config.json"

// seedResult holds the per-head sandbox inputs produced by seedHead.
type seedResult struct {
	// seedDir is the host directory for this platform's generated immutable
	// inputs. Linux uses the existing project cache; Darwin uses seed/<head-id>.
	seedDir string
	// nativeSeedPaths selects real-path delivery on Darwin after a provider has
	// established the corresponding path redirect (currently per-head CODEX_HOME).
	nativeSeedPaths bool
	// Binds are host->sandbox file binds for agent config (Linux only; macOS
	// sandbox-exec has no bind mounts).
	Binds []sandbox.Bind
	// ImmutablePaths are real paths the Darwin Seatbelt profile makes readable
	// but not writable. Linux uses read-only binds instead.
	ImmutablePaths []string
	// HydraBinPath is the executable path visible inside this head's sandbox.
	HydraBinPath string
	// WritablePaths are extra paths made writable inside the sandbox (the
	// per-head status files, kept at their real host paths so the daemon's
	// poller reads the agent's writes directly). Works on both platforms.
	WritablePaths []string
	// Env are extra environment variables (HYDRA_STATUS_PATH etc.).
	Env []string
	// MCPConfigPath is the in-sandbox path of the rendered strict MCP config, set
	// only when the policy asks for strict mode. Passed to sandbox.AgentArgv, which
	// turns it into --mcp-config <path> --strict-mcp-config; empty means the
	// non-strict launch (control server inline, seeded ~/.claude.json for the rest).
	MCPConfigPath string
	// ROOverlays expose per-head files under otherwise read-only system dirs via a
	// read-only overlay - e.g. /etc/claude-code/managed-settings.json under /etc.
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
func seedHead(projectRoot, id string, agentType sandbox.AgentType, worktreePath, home, prePrompt string, policy gate.Policy, gitIso sandbox.GitIsolationMode) (*seedResult, error) {
	cacheDir := paths.GetCacheDirFromProjectRoot(projectRoot)
	if err := paths.EnsureHydraLocalIgnored(cacheDir); err != nil {
		return nil, errtrace.Wrap(err)
	}
	seedDir, err := prepareSeedDir(projectRoot, cacheDir, id, agentType)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}

	res := &seedResult{seedDir: seedDir}
	if projectID, ok := statepath.ProjectID(projectRoot); ok {
		res.Env = append(res.Env,
			statepath.ProjectEnvironment+"="+projectID,
			statepath.ProjectRootEnvironment+"="+projectRoot,
		)
	}

	// Per-head status JSON + log, kept at their real host paths and made
	// writable so the agent writes them directly (the poller reads the same
	// files). HYDRA_STATUS_PATH/LOG tell trigger-hook where to write.
	// Each of these per-head state files now lives in its own type-keyed dir
	// (status/, status-log/, review/, subagents/ - PLAN #26 / paths.go), so
	// ensure each dir exists before writing into it.
	statusJSONHost := paths.GetStatusJsonFromProjectRoot(projectRoot, id)
	if err := paths.EnsureHydraLocalIgnored(filepath.Dir(statusJSONHost)); err != nil {
		return nil, errtrace.Wrap(err)
	}
	if err := os.WriteFile(statusJSONHost, []byte("{}"), 0644); err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("write %s: %w", statusJSONHost, err))
	}
	statusLogHost := paths.GetStatusLogFromProjectRoot(projectRoot, id)
	if err := paths.EnsureHydraLocalIgnored(filepath.Dir(statusLogHost)); err != nil {
		return nil, errtrace.Wrap(err)
	}
	if err := os.WriteFile(statusLogHost, []byte(""), 0644); err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("write %s: %w", statusLogHost, err))
	}
	res.WritablePaths = append(res.WritablePaths, statusJSONHost, statusLogHost)
	res.Env = append(res.Env,
		"HYDRA_STATUS_PATH="+statusJSONHost,
		"HYDRA_STATUS_LOG_PATH="+statusLogHost,
	)

	// Per-head review file: the MR lifecycle watcher writes this head's MR status +
	// unresolved discussions here (host-side); the in-sandbox `hydra mcp` server
	// reads it for get_review_status / get_review_comments. Bound writable at its
	// real host path (like status.json) so it exists in the sandbox; the agent only
	// reads it. Per-head by construction - bound only into THIS head's sandbox.
	reviewJSONHost := paths.GetReviewJsonFromProjectRoot(projectRoot, id)
	if err := paths.EnsureHydraLocalIgnored(filepath.Dir(reviewJSONHost)); err != nil {
		return nil, errtrace.Wrap(err)
	}
	if _, err := os.Stat(reviewJSONHost); os.IsNotExist(err) {
		if err := os.WriteFile(reviewJSONHost, []byte(`{"linked":false}`), 0644); err != nil {
			return nil, errtrace.Wrap(fmt.Errorf("write %s: %w", reviewJSONHost, err))
		}
	}
	res.WritablePaths = append(res.WritablePaths, reviewJSONHost)
	res.Env = append(res.Env, "HYDRA_REVIEW_PATH="+reviewJSONHost)

	// Per-head review-refresh channel: the review tools ask the daemon to re-read
	// the MR from the forge before answering, rather than serving whatever the 30s
	// watcher last cached. The forge CLIs are host-side only (no credentials, and
	// under hard egress no route, inside the sandbox), so this is a request/result
	// file round-trip like the gate approval and gitq channels.
	reviewReqDirHost := paths.GetReviewReqDir(projectRoot, id)
	if err := os.MkdirAll(reviewReqDirHost, 0755); err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("create %s: %w", reviewReqDirHost, err))
	}
	res.WritablePaths = append(res.WritablePaths, reviewReqDirHost)
	res.Env = append(res.Env, "HYDRA_REVIEW_REQ_DIR="+reviewReqDirHost)

	// Per-head agent collaboration channel. The tools are always available when
	// this channel exists; the daemon reads trusted policy for every delivery so
	// agent_messaging changes take effect without restarting the head.
	agentReqDirHost := paths.GetAgentReqDir(projectRoot, id)
	if err := os.MkdirAll(agentReqDirHost, 0755); err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("create %s: %w", agentReqDirHost, err))
	}
	res.WritablePaths = append(res.WritablePaths, agentReqDirHost)
	res.Env = append(res.Env, "HYDRA_AGENT_REQ_DIR="+agentReqDirHost)

	// Per-head sub-agent tracking dir: trigger-hook drops a marker file per live
	// Claude sub-agent so the main agent's Stop hook can distinguish a real finish
	// from "turn ended but sub-agents still running". A directory (one file per
	// sub-agent) rather than a shared JSON file so parallel sub-agents never race
	// on a read-modify-write. Made writable + pointed at via HYDRA_SUBAGENTS_DIR.
	subagentsDirHost := paths.GetSubagentsDirFromProjectRoot(projectRoot, id)
	if err := os.MkdirAll(subagentsDirHost, 0755); err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("create %s: %w", subagentsDirHost, err))
	}
	res.WritablePaths = append(res.WritablePaths, subagentsDirHost)
	res.Env = append(res.Env, "HYDRA_SUBAGENTS_DIR="+subagentsDirHost)

	// Host-mediated git channel: when git_isolation is readonly, .git is read-only
	// in the sandbox, so the git tools hand each write-op to the daemon's gitops
	// watcher via this writable per-head dir (see docs/git-isolation.md).
	// HYDRA_GITOPS_DIR both points the tools at the channel AND signals that
	// host-mediated mode is active; absent => run in-sandbox.
	if gitIso.HostMediatedCommit() {
		gitopsDirHost := paths.GetGitopsDir(projectRoot, id)
		if err := os.MkdirAll(gitopsDirHost, 0755); err != nil {
			return nil, errtrace.Wrap(fmt.Errorf("create %s: %w", gitopsDirHost, err))
		}
		res.WritablePaths = append(res.WritablePaths, gitopsDirHost)
		res.Env = append(res.Env, "HYDRA_GITOPS_DIR="+gitopsDirHost)
	}

	// Materialize the Hydra executable for this platform. Linux retains its
	// read-only /tmp/hydra-internal bind; Darwin stages one immutable copy per
	// executable build and uses that real path everywhere.
	runtimeBin, err := hydraRuntimeForSandbox()
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("materialize hydra runtime: %w", err))
	}
	stableHydraBin := runtimeBin.VisiblePath
	res.HydraBinPath = stableHydraBin
	if runtimeBin.Bind != nil {
		res.Binds = append(res.Binds, *runtimeBin.Bind)
	}
	res.ImmutablePaths = append(res.ImmutablePaths, runtimeBin.ImmutablePaths...)

	switch agentType {
	case sandbox.AgentTypeClaude:
		// Hooks (status + gate), skip-dangerous, and the MCP allow-list go into
		// Claude's MANAGED settings, bound read-only at the system managed path. This
		// is the only tamper-proof scope: managed hooks keep running even if the agent
		// writes {"disableAllHooks": true} into a writable user/project settings.json
		// (which a read-only ~/.claude/settings.json bind could NOT prevent, since the
		// agent can still create a project-scope .claude/settings.json). We therefore
		// do NOT seed ~/.claude/settings.json at all - the user's own settings apply
		// normally and our policy layers on top authoritatively. (docs/security-audit.md F4.)
		// The set of MCP servers KEPT in the seeded config: whole-server grants plus
		// any server referenced by a per-tool grant (so a partially-allowed server
		// still spawns and the runtime gate enforces the per-tool subset), minus any
		// server on the block list (block overrides allow).
		mcpKeep := mcpKeepSet(policy.MCPAllowed, policy.MCPToolsAllowed, policy.MCPBlocked)
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
		// Per-head, like every other seeded file: one shared copy was rewritten
		// from scratch by every spawn and resume in the project, so a launch
		// truncated the very file its siblings' sandboxes were reading through
		// this bind. The per-project cache dir is not itself per-head, hence the
		// id prefix (as with <id>-gate-policy.json).
		claudeJSONHost := seedFilePath(res.seedDir, id, "claude.json")
		cfg, err := sandbox.BuildClaudeConfig(hostClaudeJSON, worktreePath, mcpKeep, stableHydraBin, string(agentType))
		if err != nil {
			return nil, errtrace.Wrap(err)
		}
		if err := os.WriteFile(claudeJSONHost, cfg, 0644); err != nil {
			return nil, errtrace.Wrap(err)
		}
		deliverSeedFile(res, claudeJSONHost, path.Join(home, ".claude.json"), false)

		mcpJSON := readHostFile(filepath.Join(projectRoot, ".mcp.json"))

		// Strict MCP: render the allow-listed servers + the control server into a
		// per-head file and let AgentArgv launch with --strict-mcp-config, so this
		// file is the agent's ONLY source of servers. Bound read-only under the
		// per-head /tmp - NOT over a host-owned path like ~/.claude.json, whose bind
		// the host can detach by replacing the file (which is what silently undid
		// the filtering the seeded config was doing). mcpKeep is the same set the
		// non-strict path keeps, so the two agree on what is allowed.
		if policy.StrictMCP {
			strictCfg, err := sandbox.BuildStrictMCPConfig(hostClaudeJSON, mcpJSON, mcpKeep, stableHydraBin, string(agentType))
			if err != nil {
				return nil, errtrace.Wrap(err)
			}
			strictHost := seedFilePath(res.seedDir, id, "mcp-config.json")
			if err := os.WriteFile(strictHost, strictCfg, 0644); err != nil {
				return nil, errtrace.Wrap(fmt.Errorf("write %s: %w", strictHost, err))
			}
			res.MCPConfigPath = deliverSeedFile(res, strictHost, strictMCPConfigSandboxPath, true)
		}

		// Seed the catalog of host-configured MCP servers so the `hydra mcp` control
		// server can tell the agent which servers it may request access to.
		if err := seedMCPCatalog(res, cacheDir, id, hostClaudeJSON, mcpJSON); err != nil {
			return nil, errtrace.Wrap(err)
		}

		// Capture read/write hints (readOnlyHint) from the allow-listed servers so
		// the gate can badge tool calls from the authoritative annotation rather than
		// the name heuristic. Best-effort + cached; failures fall back silently.
		if policy.GateEnabled {
			policy.MCPToolRW = captureMCPToolRW(mcpKeep, hostClaudeJSON, mcpJSON, cacheDir)
		}

		// Seed the decision gate's inputs: a read-only policy.json the in-sandbox
		// hook reads, and a per-head writable approval directory for the "ask"
		// round-trip. Only when the gate is enabled (otherwise no hook reads them).
		if policy.GateEnabled {
			// In readonly mode raw git writes fail at the OS; tell the gate so it can
			// redirect them to the git_* tools instead (see gate.Policy.HostMediatedGit).
			policy.HostMediatedGit = gitIso.HostMediatedCommit()
			if err := seedGatePolicy(res, cacheDir, id, projectRoot, worktreePath, home, policy); err != nil {
				return nil, errtrace.Wrap(err)
			}
		}

	case sandbox.AgentTypeGemini:
		settingsHost := seedFilePath(res.seedDir, id, "gemini-settings.json")
		merged, err := sandbox.BuildGeminiSettings(readHostFile(filepath.Join(home, ".gemini", "settings.json")), stableHydraBin)
		if err != nil {
			return nil, errtrace.Wrap(err)
		}
		if err := os.WriteFile(settingsHost, merged, 0644); err != nil {
			return nil, errtrace.Wrap(err)
		}
		deliverSeedFile(res, settingsHost, path.Join(home, ".gemini", "settings.json"), false)

		if prePrompt != "" {
			if err := seedGeminiPrePrompt(res, cacheDir, id, home, prePrompt); err != nil {
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
			instrHost := seedFilePath(res.seedDir, id, "copilot-instructions.md")
			content := combineInstructions(prePrompt, readHostFile(filepath.Join(home, ".copilot", "copilot-instructions.md")))
			if err := os.WriteFile(instrHost, content, 0644); err != nil {
				return nil, errtrace.Wrap(err)
			}
			deliverSeedFile(res, instrHost, path.Join(home, ".copilot", "copilot-instructions.md"), false)
		}

	case sandbox.AgentTypeCodex:
		layout, err := prepareCodexSeedLayout(projectRoot, cacheDir, id, home, res)
		if err != nil {
			return nil, errtrace.Wrap(err)
		}
		// Codex has no --append-system-prompt; it
		// reads standing guidance from AGENTS.md files. Deliver the pre-prompt as
		// the global ~/.codex/AGENTS.md (merged over the host's), which applies to
		// every Codex session regardless of the repo's own AGENTS.md.
		if prePrompt != "" {
			agentsHost := layout.generatedPath("AGENTS.md")
			content := combineInstructions(prePrompt, readHostFile(filepath.Join(layout.hostHome, "AGENTS.md")))
			if err := writeCodexSeedFile(agentsHost, content, 0644); err != nil {
				return nil, errtrace.Wrap(err)
			}
			deliverCodexSeedFile(res, layout, agentsHost, "AGENTS.md", false)
		}

		hooksHost := layout.generatedPath("hooks.json")
		hooks, err := sandbox.BuildCodexHooks(readHostFile(filepath.Join(layout.hostHome, "hooks.json")), stableHydraBin, policy.GateEnabled)
		if err != nil {
			return nil, errtrace.Wrap(err)
		}
		if err := writeCodexSeedFile(hooksHost, hooks, 0o644); err != nil {
			return nil, errtrace.Wrap(err)
		}
		deliverCodexSeedFile(res, layout, hooksHost, "hooks.json", true)

		// Keep only trusted MCP servers and seed the Hydra control server into
		// ~/.codex/config.toml (git_* tools + MCP discovery), while preserving
		// model/auth and every other Codex setting.
		// A malformed host config would error - skip seeding then (codex keeps its
		// real config, just without the hydra tools) rather than clobber it.
		hostCodexConfig := readHostFile(filepath.Join(layout.hostHome, "config.toml"))
		mcpKeep := mcpKeepSet(policy.MCPAllowed, policy.MCPToolsAllowed, policy.MCPBlocked)
		codexCfg, cfgErr := sandbox.BuildCodexConfig(hostCodexConfig, stableHydraBin, mcpKeep)
		if cfgErr != nil {
			if res.nativeSeedPaths {
				return nil, errtrace.Wrap(fmt.Errorf("build required macOS Codex config for %s: %w", id, cfgErr))
			}
			log.Printf("warn: not seeding hydra MCP into codex config for %s: %v", id, cfgErr)
		} else {
			codexCfgHost := layout.generatedPath("config.toml")
			if err := writeCodexSeedFile(codexCfgHost, codexCfg, 0o644); err != nil {
				return nil, errtrace.Wrap(err)
			}
			deliverCodexSeedFile(res, layout, codexCfgHost, "config.toml", true)
		}

		// Discovery reads the unfiltered host config, so a server omitted above is
		// still available through request_mcp_server and can be approved for the
		// next launch.
		if err := seedMCPCatalogEntries(res, cacheDir, id, sandbox.ListCodexMCPServers(hostCodexConfig)); err != nil {
			return nil, errtrace.Wrap(err)
		}

		if policy.GateEnabled {
			policy.HostMediatedGit = gitIso.HostMediatedCommit()
			if err := seedGatePolicy(res, cacheDir, id, projectRoot, worktreePath, home, policy); err != nil {
				return nil, errtrace.Wrap(err)
			}
		}
	}

	return res, nil
}

// resolveGatePolicy converts the trusted per-agent config policy into the
// gate.Policy seeded into the sandbox. Home/WorktreePath are filled later by
// seedGatePolicy. gate_enabled defaults to true (opt-out).
func resolveGatePolicy(cfg config.Config, agentType string) gate.Policy {
	p := cfg.ResolvePolicy(agentType)
	pol := gate.Policy{
		GateEnabled:      p.IsGateEnabled(),
		MCPAllowed:       p.MCPAllowed,
		MCPToolsAllowed:  p.MCPToolsAllowed,
		MCPBlocked:       p.MCPBlocked,
		MCPToolsBlocked:  p.MCPToolsBlocked,
		AutoAllowReadMCP: p.MCPAutoAllowRead != nil && *p.MCPAutoAllowRead,
		StrictMCP:        p.IsStrictMCP(),
		KnownTools:       p.KnownTools,
	}
	// WebFetch host-gating is derived from the sandbox network policy rather than a
	// dedicated list: the fetch runs inside the sandbox, so its traffic also
	// crosses the egress boundary and must honour the same allow-list as the
	// network. Gating it at the tool layer too is still worthwhile - the user gets
	// prompted with the full URL before the tool runs - and a granted host is
	// shared with the egress proxy via granted-hosts.json so one allow never
	// prompts twice. Filtering off (unrestricted/off) ⇒ no gating; filtering on
	// (hard/advisory) ⇒ allow the default hosts unioned with the user's
	// allowed_hosts, minus blocked.
	_, _, _, _, net, _ := cfg.ResolveSandboxOptions(agentType)
	if net.FilterHosts {
		pol.WebFetchFilter = true
		pol.WebFetchAllowHosts = append(sandbox.DefaultAllowedHosts(sandbox.AgentType(agentType)), net.AllowedHosts...)
		pol.WebFetchBlockedHosts = net.BlockedHosts
	}
	return pol
}

// seedMCPCatalog writes the read-only catalog of host-configured MCP servers
// (host ~/.claude.json + project .mcp.json) into the sandbox and points
// gate.EnvMCPCatalogPath at it, so the `hydra mcp` control server can offer them
// for the agent to request. Best-effort: an empty catalog just means the agent
// has nothing extra to request.
func seedMCPCatalog(res *seedResult, cacheDir, id string, hostClaudeJSON, mcpJSON []byte) error {
	return errtrace.Wrap(seedMCPCatalogEntries(res, cacheDir, id, sandbox.ListMCPServers(hostClaudeJSON, mcpJSON)))
}

func seedMCPCatalogEntries(res *seedResult, _ string, id string, catalog []sandbox.MCPServer) error {
	data, err := json.Marshal(catalog)
	if err != nil {
		return errtrace.Wrap(err)
	}
	catalogHost := seedFilePath(res.seedDir, id, "mcp-catalog.json")
	if err := os.WriteFile(catalogHost, data, 0644); err != nil {
		return errtrace.Wrap(err)
	}
	visiblePath := deliverSeedFile(res, catalogHost, mcpCatalogSandboxPath, true)
	res.Env = append(res.Env, gate.EnvMCPCatalogPath+"="+visiblePath)
	return nil
}

// mcpKeepSet returns the MCP servers to keep in the seeded config: the
// whole-server allow-list plus the server segment of every per-tool grant
// ("<server>__<tool>" → "<server>"). A partially-allowed server must be kept so
// it spawns; the runtime gate then enforces which of its tools are permitted.
func mcpKeepSet(serversAllowed, toolsAllowed, serversBlocked []string) []string {
	blocked := func(s string) bool {
		for _, b := range serversBlocked {
			if strings.EqualFold(b, s) {
				return true
			}
		}
		return false
	}
	seen := map[string]bool{}
	var out []string
	add := func(s string) {
		if s != "" && !seen[s] && !blocked(s) {
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
func seedGatePolicy(res *seedResult, _ string, id, projectRoot, worktreePath, home string, policy gate.Policy) error {
	policy.Home = home
	policy.WorktreePath = worktreePath
	policy.ProjectRoot = projectRoot

	policyHost := seedFilePath(res.seedDir, id, "gate-policy.json")
	if err := policy.Save(policyHost); err != nil {
		return errtrace.Wrap(err)
	}
	visiblePath := deliverSeedFile(res, policyHost, GateSandboxPolicyPath, true)
	res.Env = append(res.Env, gate.EnvPolicyPath+"="+visiblePath)

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
// and point GEMINI_SYSTEM_MD at the combined file - a true system prompt of
// "default + our rules". If the default can't be captured (e.g. gemini is not
// authenticated, or offline), fall back to seeding the pre-prompt as a GEMINI.md
// context file, which is loaded as instructional context instead.
func seedGeminiPrePrompt(res *seedResult, cacheDir, id, home, prePrompt string) error {
	// Never let Gemini write its default system prompt into the read-only
	// `.hydra/local/cache` inside the sandbox (EROFS crash). We capture the default
	// ourselves on the host below; the agent only ever reads via GEMINI_SYSTEM_MD.
	res.Env = append(res.Env, "GEMINI_WRITE_SYSTEM_MD=")

	if dflt := geminiDefaultSystemPrompt(cacheDir); dflt != "" {
		combined := strings.TrimRight(dflt, "\n") + "\n\n" + prePrompt + "\n"
		sysHost := seedFilePath(res.seedDir, id, "gemini-system.md")
		if err := os.WriteFile(sysHost, []byte(combined), 0644); err != nil {
			return errtrace.Wrap(err)
		}
		target := path.Join(home, ".gemini", "hydra-system.md")
		visiblePath := deliverSeedFile(res, sysHost, target, false)
		res.Env = append(res.Env, "GEMINI_SYSTEM_MD="+visiblePath)
		return nil
	}

	// Fallback: GEMINI.md context file, merged over the host's global one.
	ctxHost := seedFilePath(res.seedDir, id, "gemini-context.md")
	content := combineInstructions(prePrompt, readHostFile(filepath.Join(home, ".gemini", "GEMINI.md")))
	if err := os.WriteFile(ctxHost, content, 0644); err != nil {
		return errtrace.Wrap(err)
	}
	deliverSeedFile(res, ctxHost, path.Join(home, ".gemini", "GEMINI.md"), false)
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
	"CODEX_HOME":             true,
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
	// A daemon may itself be launched with a project-local TMPDIR (notably an
	// isolated test server). That host path is not the head's temp directory and
	// is normally read-only in its sandbox. Every Linux head instead gets a
	// private directory bound at /tmp, so always give child tools that path.
	"TMPDIR": true,
	"TMP":    true,
	"TEMP":   true,
}

// inheritedSecretEnvWords are credential-shaped components that must never
// flow from the Hydra daemon's environment into an agent by accident. Agent
// launches still inherit ordinary toolchain and terminal configuration; users
// who deliberately need a credential can opt in through the trusted
// pre_spawn_script + $HYDRA_ENV channel.
var inheritedSecretEnvWords = map[string]bool{
	"ASKPASS":     true,
	"AUTH":        true,
	"COOKIE":      true,
	"CREDENTIAL":  true,
	"CREDENTIALS": true,
	"JWT":         true,
	"PASSWD":      true,
	"PASSWORD":    true,
	"SECRET":      true,
	"TOKEN":       true,
}

// sensitiveInheritedEnvKey reports whether a daemon environment key is likely
// to carry a reusable credential or access to a credential broker. This is
// intentionally name-based: values are never inspected or logged. Matching
// whole underscore-delimited words avoids false positives such as
// MAX_THINKING_TOKENS, while the suffix check catches conventional compact
// spellings such as PGPASSWORD.
func sensitiveInheritedEnvKey(key string) bool {
	upper := strings.ToUpper(key)
	for _, word := range strings.FieldsFunc(upper, func(r rune) bool {
		return r < 'A' || r > 'Z'
	}) {
		if inheritedSecretEnvWords[word] {
			return true
		}
	}
	if strings.HasSuffix(upper, "PASSWORD") || strings.HasSuffix(upper, "PASSWD") || strings.HasSuffix(upper, "_PWD") {
		return true
	}
	padded := "_" + upper + "_"
	for _, marker := range []string{"_API_KEY_", "_ACCESS_KEY_", "_PRIVATE_KEY_", "_SIGNING_KEY_", "_ENCRYPTION_KEY_"} {
		if strings.Contains(padded, marker) {
			return true
		}
	}
	return false
}

// headContextEnv returns the HYDRA_* environment variables describing the head
// being launched. They are exposed to the pre-spawn script (and, since they
// share the same environment, the agent/shell process) so per-spawn setup can
// branch on the head's identity, agent type and git layout - e.g. seeding only
// for a given agent, or copying files into the worktree. The pre-spawn script is
// additionally given $HYDRA_ENV (a file it appends KEY=value lines to, exported
// into the agent - see sandbox.preSpawnEnvSetup); that one is set by the wrapper,
// not here, so it is not listed below or in envKeysHydraOwns.
//
// Keep this set, envKeysHydraOwns above, and the Pre-Spawn Script tooltip in
// web/src/components/settings/ConfigForm.tsx in sync.
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

// readPreSpawnEnv reads back the KEY=value lines a head's pre_spawn_script wrote to
// $HYDRA_ENV (persisted by the pre-spawn wrapper - see sandbox.preSpawnEnvSetup) and
// returns them as environment entries to inject into the head's sibling sandboxed
// bash shells, so a shell sees the same env the agent does without re-running the
// script. It mirrors the wrapper's literal parse: blank lines and `#` comments are
// skipped and each remaining line is taken verbatim (no shell evaluation), so only
// well-formed `KEY=value` lines are kept. Returns nil when path is empty or the file
// is absent (the agent has not spawned yet, or its script set nothing).
func readPreSpawnEnv(path string) []string {
	if path == "" {
		return nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var out []string
	for line := range strings.SplitSeq(string(data), "\n") {
		if line == "" || strings.HasPrefix(line, "#") || !strings.Contains(line, "=") {
			continue
		}
		out = append(out, line)
	}
	return out
}

// claudeRenderingEnv pins Claude Code's renderer for an agent launch (spawn and
// resume alike). Claude's fullscreen rendering draws on the terminal's alternate
// screen buffer and captures the mouse - which, in Hydra's web (xterm.js)
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

// agentEnv builds the environment for the sandboxed agent process. It inherits
// ordinary host configuration needed by developer tools, but drops
// credential-shaped variables. Filesystem masking cannot protect a secret that
// is already present in a process environment, and allowed provider/git hosts
// would remain an exfiltration route even under hard egress filtering.
func agentEnv(home, username string, gitAuthorName, gitAuthorEmail string) []string {
	return buildAgentEnv(home, username, gitAuthorName, gitAuthorEmail, true)
}

// regularShellEnv preserves the daemon's full environment for the explicitly
// unsandboxed "Regular shell" terminal. That shell is a user-selected host
// process, not an agent security boundary; silently removing its credentials
// would break the host workflows it exists to provide.
func regularShellEnv(home, username string, gitAuthorName, gitAuthorEmail string) []string {
	return buildAgentEnv(home, username, gitAuthorName, gitAuthorEmail, false)
}

func buildAgentEnv(home, username string, gitAuthorName, gitAuthorEmail string, scrubSecrets bool) []string {
	env := make([]string, 0, len(os.Environ()))
	for _, kv := range os.Environ() {
		if k, _, ok := strings.Cut(kv, "="); ok {
			if envKeysHydraOwns[k] || (scrubSecrets && sensitiveInheritedEnvKey(k)) {
				continue
			}
		}
		env = append(env, kv)
	}
	env = append(env,
		"HOME="+home,
		"USER="+username,
		"LANG=C.UTF-8",
		"TERM=xterm-256color",
		"COLORTERM=truecolor",
		"TMPDIR=/tmp",
		"TMP=/tmp",
		"TEMP=/tmp",
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
