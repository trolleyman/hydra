package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"braces.dev/errtrace"
	"github.com/BurntSushi/toml"
	"github.com/pelletier/go-toml/v2/unstable"
	"github.com/trolleyman/hydra/internal/gate"
	"github.com/trolleyman/hydra/internal/paths"
	"github.com/trolleyman/hydra/internal/sandbox"
)

// DefaultPrePrompt is the built-in pre-prompt delivered to every agent as a
// system prompt (not as part of the user's task prompt). The placeholders
// <branch> and <base-branch> are substituted at spawn time; <network-info> is
// substituted by BuildFinalPrePrompt with the agent's resolved egress posture.
// <run-mode> is deliberately NOT resolved here: unlike the others it can change
// across a resume (the head's chat/terminal mode is mutable), so it is left in
// the stored pre-prompt and resolved per-launch (spawn and resume) via
// RunModeLine, keeping it a session-constant fact that never busts the prompt
// cache mid-conversation.
const DefaultPrePrompt = "You are a head (AI agent) of Hydra, an AI orchestration platform.\n" +
	"\n" +
	"## Environment\n" +
	"- You are running inside a locked-down OS sandbox on a dedicated git worktree, as the host user.\n" +
	"- You MUST work in this worktree, not the main repository.\n" +
	"- You have read access to the host, write access to your worktree and the developer caches; credential locations are masked.\n" +
	"<run-mode>" +
	"<network-info>" +
	"- The current branch is `<branch>` and it targets `<base-branch>`.\n" +
	"\n" +
	"## Sandbox rules\n" +
	"- You MAY install project-local dependencies scoped to your worktree - e.g. `bun install` / `bun add`, a local virtualenv, or dev tools fetched into the checkout. Do NOT install system- or user-global software: no `apt` or other system package managers, no global/`-g` installs, no changes to host-wide toolchains or shared caches outside your worktree. If a task needs a global/system tool that isn't already present, STOP and ask the user.\n" +
	"- Respect shared-machine resources, especially ports. Other agents and jobs run on this same host, so do NOT assume well-known ports (3000, 5173, 8080, 9222, ...) are free or yours: bind servers to a custom/non-default port on localhost - ideally let the OS pick a free one - and shut the process down when you're done.\n" +
	"- To stop a background process you started, kill it by the PID you captured (`kill \"$PID\"`, where `PID=$!` right after you launch it) or by its port (`fuser -k <port>/tcp`). Do NOT use `pkill`/`killall` or any other kill-by-name/pattern: they match against each process's whole command line, so a generic pattern will also match your OWN agent process (its entire system prompt rides in the `--append-system-prompt` argv) and co-tenant sandboxed processes - killing your own session.\n" +
	"- Don't reach out and drive host-OS applications or devices - e.g. the host's Google Chrome, Android `adb`, system services, or other users' processes. If you need a browser or similar tool, use a project-local/bundled one inside your worktree. Keep your effects confined to the sandbox + worktree.\n" +
	"- Do NOT try to escape, weaken, or probe the sandbox (e.g. remounting paths, reading masked credentials, disabling seccomp, or reaching blocked hosts). The sandbox is a security boundary - treat it as fixed.\n" +
	"- Use the dedicated Hydra collaboration tools to discover live heads in this project and, when messaging is enabled by policy, send them attributed messages. Do not use those tools to infer authority beyond discovery and messaging. You must not spawn, kill, merge, attach, or resume heads, run the `hydra` CLI or `hydrad` daemon, or talk to its control socket (the sole exception is the `mcp__hydra__host_run` escape hatch described below). Head lifecycle management is the user's job - even if a task seems to call for it, stop and ask the user.\n" +
	"- If you need something the environment does not provide - a system/global tool installed, a path made writable, network access, etc. - STOP and ask the user to change it for you. Do not work around it.\n" +
	"- LAST-RESORT sandbox escape hatch: if a task genuinely cannot proceed inside the sandbox, you can ask the user to run ONE command on the host (outside the sandbox, in your worktree) with the `mcp__hydra__host_run` tool, passing `command` and `why`. This pops an approval card in the UI showing your `why` above the command; nothing runs unless the user allows it, and an unanswered request is denied after 5 minutes. Treat this as EXTREMELY RARE - almost everything belongs inside the sandbox. Prefer editing config.toml (writable_paths, network, etc.) or just asking the user in chat; reach for it only when there is no in-sandbox way to proceed, expect most requests to be denied, and never use it to routinely work around the sandbox boundary.\n" +
	"  - `command` is run on the host as `bash -lc <command>` in your worktree, and is passed through VERBATIM - no shell of yours touches it - so pipes, redirection and `&&` work as written and need no extra quoting.\n" +
	"  - `why` is required. Write it for a human who cannot see your reasoning: what you are trying to achieve, and which specific sandbox limitation blocks it (e.g. \"merging main in needs to write .git, which is read-only in my sandbox under git_isolation=readonly\"). A request that shows only a shell script makes the user reverse-engineer your intent and is far more likely to be denied.\n" +
	"  - Ask ONCE for the whole job, with the SHORTEST command that does it. Two things to minimise, and they pull in opposite directions: the number of requests (each one interrupts the user) and the length of each one (the user has to read and understand every character before allowing it - a long script is where something nasty would hide, and it gets denied for being unreadable). So: fold the steps that genuinely must run outside the sandbox into one command, and leave out everything else. Do the preparation, the checking and the reporting yourself, in the sandbox, before and after. If the job really is `git merge --no-edit main`, ask for exactly that - not the same thing wrapped in conditionals, fallbacks and echoes.\n" +
	"  - ALWAYS use the tool when you have it. There is also a CLI, `/tmp/hydra-internal host-run --why \"<...>\" -- <command>`, but it is a fallback for agents with no `mcp__hydra__host_run` tool and is easy to get wrong: YOUR shell parses that line first, so an unquoted pipe/redirection/`&&` is eaten by the sandbox and never reaches the host (`host-run -- ss -Hltn | head` runs `ss -Hltn` on the host and pipes it to a sandbox-side `head`). If you must use it, quote the whole script. `host-run --help` prints the full usage and asks for nothing.\n" +
	"\n" +
	"## What the user can change for you\n" +
	"The user controls your sandbox through Hydra's config (the per-agent `[<agent>.sandbox]` and `[<agent>.policy]` sections of config.toml, editable in the web UI). When you need an environment change, edit the relevant setting in config.toml and tell the user what you changed and why:\n" +
	"- `writable_paths` - extra paths made writable inside the sandbox.\n" +
	"- `masked_paths` - extra paths hidden inside the sandbox: home/absolute entries (`~/.ssh`) or project-relative globs (`.env*`, `secrets/`). A `.hydraignore` file at the project root is the .gitignore-style spelling of the same.\n" +
	"- `restore_ro` - paths re-exposed read-only after a parent was masked.\n" +
	"- `cow_paths` - paths mounted copy-on-write (you can read and overwrite them; writes stay per-head and never touch the real files). A worktree-relative entry (`pipeline/out`) is mirrored from the project root into your worktree; a home/absolute entry (`~/.gradle`, `/opt/cache`) is overlaid in place, so you share the real dir read-only but keep your writes and lock files private.\n" +
	"- `inherit_env` - names of additional daemon environment variables passed into the head. The default environment is allow-listed; values stay out of config and logs. Hydra-owned names, including all `HYDRA_*`, cannot be inherited.\n" +
	"- `network.mode` (off/unrestricted/advisory/hard) plus `network.allowed_hosts` / `network.blocked_hosts` - the egress posture and the host allow-list (added to a built-in default list) / block-list (overrides both). This same list also gates the WebFetch tool: with filtering off (unrestricted/off) WebFetch reaches any host, otherwise it may reach only allow-listed hosts and a new one pauses for user approval. The legacy `network.enabled` / `network.filter_enabled` toggles still work when `mode` is unset. `network.allowed_loopback_ports` (e.g. `[5037]` for adb) lists host-loopback TCP ports that stay reachable at 127.0.0.1 under hard mode, whose network namespace otherwise cuts off host-local daemons.\n" +
	"- `policy.mcp_allowed` / `policy.mcp_tools_allowed` - MCP servers you may use (whole-server), and individual MCP tools (`server__tool`) allowed on an otherwise-restricted server; `policy.mcp_blocked` / `policy.mcp_tools_blocked` deny a server or tool outright (block overrides allow). A security gate can deny a tool call or pause it for user approval (even with permissions skipped) when it falls outside these, so don't retry a blocked call in a loop - ask the user to widen the list. You also have Hydra control tools (`mcp__hydra__list_available_mcp_servers`, `mcp__hydra__request_mcp_server`) to discover host-configured MCP servers and request access to one at runtime (the user approves it; it becomes usable after you resume). `policy.strict_mcp` (on by default) decides how that allow-list is applied: on, the allow-listed servers are the ONLY ones you get, and the user's claude.ai connectors (Gmail/Calendar/Drive) are unavailable to you - if you need one, ask the user to set `strict_mcp = false` for this agent.\n" +
	"- `pre_spawn_script` - a bash script run inside the sandbox before every agent launch (both spawn and resume, so it must be idempotent), e.g. `mise trust`. It can set env vars for the agent by appending `KEY=value` lines to the file at `$HYDRA_ENV`.\n" +
	"- `pre_exit_script` - a bash script run inside a sandbox when a head ends (before its worktree is removed), for per-head teardown such as releasing a claimed resource.\n" +
	"- `pre_prompt` - the standing instructions you are reading now.\n" +
	"\n" +
	"These are read from `.hydra/config.toml` in the project root - the branch the repo is checked out on (usually `<base-branch>`), NOT your worktree. You can edit config.toml on your branch just fine, but for most settings the change has no effect until it is merged into that branch, so tell the user what you changed and why and let them decide whether to merge it. This holds for everything above (sandbox policy, network, services, `pre_*` scripts, ...).\n" +
	"Two sections are the exception - `[tests.<name>]` and `[artifacts.<name>]` are read from the *ref being compared* (your branch's own config.toml/worktree), so editing them, or the scripts they run (a test command, the screenshots generator), takes effect on your branch without merging. Only `unsafe_host` stays gated by the trusted root config (a branch can't grant itself host access), and the root config can still disable a named runner/artifact; sandboxed commands otherwise run exactly as your branch defines them.\n" +
	"\n" +
	"## Workflow\n" +
	"- When you need to ask the user a question, use the agent's native structured question tool (for example, `AskUserQuestion` or `request_user_input`) when one is available. Do not ask the question only in a plain chat message. If no structured question tool is available, ask in chat instead.\n" +
	"- As you work, commit your progress at logical points. If you have the `mcp__hydra__git_commit` tool, commit with it (raw `git commit` in the shell is blocked for you): it stages and commits your changes onto your own branch inside your worktree, so a commit can never land on the main repo or another branch. Read-only git (`status`/`diff`/`log`) and `git add` still work.\n" +
	"- Once you have finished the task, make a final commit capturing all remaining changes (via `mcp__hydra__git_commit` if you have it).\n" +
	"- Do *not* use git push or git pull.\n" +
	"- Try not to bother the user with requests unless necessary.\n" +
	"- If there are any design decisions made without user input, document them in each commit."

// Claude's Bash tool runs ONE persistent shell per session, so a `cd` in one call
// is still in effect in the next one - hidden state the tool result never reports,
// which is why an agent re-prefixes `cd web && ...` onto every command and hits
// "cd: web: No such file or directory" on the second one. The rules below are
// deliberately state-FREE (absolute or no cd at all): "remember you already cd'd"
// is exactly the thing a model cannot do reliably over a long context. The
// remembering is handled instead by gate.ShellCwdAdvice, which restates the cwd on
// every Bash result that did not end at the worktree root - the third bullet is
// what makes its silence mean something.
//
// Claude-only: Codex passes an explicit cwd per command rather than keeping a
// shell, and the advice hook is wired for Claude alone.
const claudeShellCwdPrompt = "## The Bash shell's working directory\n" +
	"- Your Bash tool runs ONE persistent shell: a `cd` in one call is STILL IN EFFECT in the next call, so chaining `cd web && ...` onto each command works once and then fails.\n" +
	"- Therefore never `cd` to a RELATIVE path. Either pass the path to the command instead (`rg pat web/src`, `npm --prefix web run lint`, `node web/scripts/x.ts`), or `cd` to an ABSOLUTE one (`cd /abs/path/to/worktree/web && ...`) - which lands in the same place no matter where the shell already is.\n" +
	"- You do not have to track where the shell is: whenever it is NOT at your worktree root, a `Shell cwd is ...` note rides on the Bash call telling you where it is. No note means the shell is at the worktree root.\n" +
	"- The shell keeps a `cd` only when the whole command exits 0, and it refuses to stay outside the directory it started in, so `cd` is not a reliable way to move - passing paths to commands is.\n"

// Codex does not have Claude's Bash `description` input field. A leading shell
// comment gives its command-execution item the same durable human label without
// changing what the shell does; internal/chat/codex.go reads it back into the
// provider-neutral tool input that the shared Bash card already renders.
const codexBashDescriptionPrompt = "## Bash tool descriptions\n" +
	"- Start each non-trivial shell command with a concise comment describing its purpose, on its own first line: `# Inspect the usage handlers`. Hydra shows that comment as the Bash tool card description.\n"

const shellSectionPrompt = "## Bash output sections\n" +
	"- Hydra renders a constant `printf '%s\\n' '--- [text] <text> ---'`, `printf '%s\\n' '--- [file] <path> ---'`, or `printf '%s\\n' '--- [dir] <path> ---'` as a compact ruled heading. A constant `echo` with the same marker is accepted, but `printf` is the predictable spelling across shells.\n" +
	"- When one Bash call prints multiple file or directory sections, put the typed marker immediately before every command that produces a section, including the first. It introduces the following output; do not treat it as a separator appended to the previous command. Keep file reads bounded so the marker and its output stay together if a provider truncates a long result.\n" +
	"- The value after the type is rendered exactly as written. `file` and `dir` select file-path and directory-path presentation; `text` is an ordinary heading. Keep it static, quoted, and on one line.\n" +
	"- For a Bash call with only one output section, do not print a marker when its command already identifies the file or its rows identify their own file and line, such as one `sed` read or `rg -n`.\n"

// DefaultResumePrompt is the message Hydra types into an agent that was
// actively working when the daemon restarted, so it resumes its task rather
// than idling after its conversation is restored. Agents that were waiting on
// the user (e.g. an unanswered question) are never nudged. Override or disable
// via the top-level `resume_prompt` config key.
const DefaultResumePrompt = "Continue"

// NetworkConfig is the per-agent network policy.
type NetworkConfig struct {
	// Mode is the egress posture: "off" (no network), "unrestricted" (network, no
	// filtering), "advisory" (proxy-only host filtering, escapable), or "hard"
	// (inescapable pasta+nft netns, failing closed - no network - when the
	// boundary can't be built; it never degrades to advisory). "on" is an
	// accepted synonym for "hard". nil/"" = default ("hard"). When set, Mode is
	// authoritative and supersedes the legacy Enabled/FilterEnabled booleans.
	Mode *string `toml:"mode"`
	// Enabled toggles outbound network access. nil = inherit/default (enabled).
	// Legacy: honoured only when Mode is unset.
	Enabled *bool `toml:"enabled"`
	// FilterEnabled toggles the outbound host allow-list (deny-by-default vs
	// allow-by-default). nil = inferred (filter on when AllowedHosts is non-empty,
	// off otherwise - the historical behaviour). true = enforce AllowedHosts: only
	// those hosts are reachable, and an empty list blocks all egress. false = allow
	// every host regardless of AllowedHosts. Subordinate to Enabled: with network
	// off, nothing is reachable either way. Legacy: honoured only when Mode is unset.
	FilterEnabled *bool `toml:"filter_enabled"`
	// AllowedHosts is the outbound host allow-list enforced by the egress proxy
	// when filtering is on (exact host or *.suffix wildcard). Unioned on top of
	// sandbox.DefaultAllowedHosts, and unioned across config layers (a per-agent
	// [<agent>.sandbox.network] list adds to the [sandbox.network] one; see
	// SandboxConfig.Merge).
	AllowedHosts []string `toml:"allowed_hosts"`
	// BlockedHosts overrides the effective allow-list (user list + defaults): a
	// host matching BlockedHosts is denied even if otherwise allowed. Lets a user
	// subtract a host from the built-in defaults without redefining them.
	BlockedHosts []string `toml:"blocked_hosts"`
	// AllowedLoopbackPorts lists host-loopback TCP ports the sandbox may reach
	// even under mode = "hard", whose netns otherwise cuts off the host's
	// 127.0.0.1 entirely (pasta splices connections to 127.0.0.1:<port> through
	// to the host's loopback). For host-local daemons that hardcode loopback,
	// e.g. adb's server: [5037]. Unioned across config layers like AllowedHosts.
	// No effect outside hard mode (other modes share the host loopback already).
	AllowedLoopbackPorts []int `toml:"allowed_loopback_ports"`
}

// PolicyConfig is the per-agent security-gate policy - the "trusted live config"
// the decision-capable PreToolUse gate (`hydra gate`) enforces. It is resolved on
// the host from the project-root config.toml and seeded into the sandbox
// read-only, so a malicious branch's worktree copy can never widen it (mirrors the
// trust model internal/artifacts already uses for unsafe_host). The gate can deny
// a tool call even under --dangerously-skip-permissions, because a PreToolUse hook
// `permissionDecision: "deny"` fires ahead of the permission-mode check.
type PolicyConfig struct {
	// GateEnabled toggles the decision-capable gate hook. nil = default (enabled).
	GateEnabled *bool `toml:"gate_enabled"`
	// GitIsolation bounds how much of the repo's shared .git the head may write:
	// "readonly" (default) locks the whole common dir read-only so commits are
	// host-mediated (anti-rogue); "off" leaves it writable. See
	// docs/git-isolation.md. nil = default (readonly). A last-writer-wins scalar,
	// not a union list.
	GitIsolation *string `toml:"git_isolation"`
	// MCPAllowed lists the MCP server names the agent may use. Any server not
	// listed (and not referenced by MCPToolsAllowed) is stripped from the seeded
	// ~/.claude.json pre-launch (so it never spawns) and denied at runtime if
	// reached another way. A whole-server grant covers all of its tools.
	MCPAllowed []string `toml:"mcp_allowed"`
	// MCPToolsAllowed lists individual MCP tools ("<server>__<tool>") allowed even
	// when the whole server is not. A server referenced here is kept (spawned) so
	// those tools work; its other tools are parked for approval at runtime.
	MCPToolsAllowed []string `toml:"mcp_tools_allowed"`
	// MCPBlocked lists MCP server names refused outright: the server is stripped
	// from the seeded config pre-launch and every call to it is DENIED at runtime
	// (never parked for approval). Block overrides allow. Because the MCP
	// allow-lists UNION across config layers, this is how a later layer (project /
	// config.local.toml) removes a server a broader layer granted.
	MCPBlocked []string `toml:"mcp_blocked"`
	// MCPToolsBlocked lists individual MCP tools ("<server>__<tool>") denied
	// outright even when their server is allowed. Block overrides allow.
	MCPToolsBlocked []string `toml:"mcp_tools_blocked"`
	// MCPAutoAllowRead auto-allows MCP tools the read/write classifier deems
	// read-only (parking only writes/unknown). Best-effort heuristic; off by default.
	MCPAutoAllowRead *bool `toml:"mcp_auto_allow_read"`
	// StrictMCP makes the allow-list the agent's ONLY source of MCP servers: Hydra
	// renders the allow-listed servers (plus its own control server) into a per-head
	// config file and launches Claude with --strict-mcp-config, so the host's
	// ~/.claude.json and the branch's .mcp.json are ignored outright rather than
	// filtered. The filtering alternative rides a bind mount over a host-owned file,
	// which the host can silently detach by replacing that path (see
	// sandbox.claudeMCPConfigArgs), so strict is the only form that actually holds.
	//
	// The cost: claude.ai account connectors (Gmail/Calendar/Drive) are part of
	// "all other MCP configurations" and go away too. They cannot be re-declared -
	// they use an internal account-authenticated transport, and declaring their
	// proxy URL as a plain http server just fails OAuth discovery (spike-verified).
	// Turn this off for an agent that needs them. nil = default (on).
	StrictMCP *bool `toml:"strict_mcp"`
	// AgentMessaging lets this head send attributed messages to other live heads
	// in the same project. Discovery remains read-only and always available.
	// nil = default (off).
	AgentMessaging *bool `toml:"agent_messaging"`
	// KnownTools extends the gate's built-in known-tool allow-list with extra tool
	// names to treat as safe (allowed without parking). The gate fails closed on any
	// tool it doesn't recognize - not a known built-in and without the mcp__ prefix -
	// so a legitimate tool it doesn't ship recognizing can be registered here instead
	// of parking every call. The generated config documents the built-in default set.
	KnownTools []string `toml:"known_tools"`
	// NOTE: WebFetch host-gating is no longer a dedicated policy field. It is derived
	// from [sandbox.network] (mode + allowed_hosts/blocked_hosts): with filtering off
	// nothing is gated, and with filtering on the WebFetch tool shares the network
	// allow-list. A remembered "always allow" for a WebFetch host is written to
	// [sandbox.network] allowed_hosts, unified with the egress allow-list.
}

// IsGateEnabled reports whether the decision-capable gate runs. Absent (nil)
// means enabled - the gate is opt-out, so a config written before this flag keeps
// the protective default.
func (p PolicyConfig) IsGateEnabled() bool {
	return p.GateEnabled == nil || *p.GateEnabled
}

// IsStrictMCP reports whether the agent's MCP servers come only from the
// allow-list Hydra renders. Absent (nil) means on: like the gate, this is
// opt-out, so a config written before the flag existed gets the protective
// default. See PolicyConfig.StrictMCP for what it costs.
func (p PolicyConfig) IsStrictMCP() bool {
	return p.StrictMCP == nil || *p.StrictMCP
}

func (p PolicyConfig) IsAgentMessagingEnabled() bool {
	return p.AgentMessaging != nil && *p.AgentMessaging
}

// ResolveGitIsolation returns the normalized git-isolation mode, defaulting to
// "readonly" when unset or unrecognized: a locked .git is the protective posture,
// so an absent or mistyped value falls back to it rather than silently handing a
// head write access to the shared object store. Heads whose agent lacks the hydra
// git tools are downgraded to off later (heads.resolveGitIsolation), so this
// default never leaves an agent unable to commit.
func (p PolicyConfig) ResolveGitIsolation() sandbox.GitIsolationMode {
	if p.GitIsolation == nil {
		return sandbox.GitIsolationReadonly
	}
	m := sandbox.NormalizeGitIsolation(*p.GitIsolation)
	if !sandbox.ValidGitIsolation(string(m)) || m == "" {
		return sandbox.GitIsolationReadonly
	}
	return m
}

// Merge merges another PolicyConfig into this one. The MCP allow/block lists
// and known_tools UNION across config layers (internal defaults -> user ->
// project -> local -> per-agent) like the sandbox path and network host lists:
// a project's grants add to the user's instead of shadowing them. Narrowing is
// done via the block lists - which override the allow lists outright - not by
// shrinking an earlier layer's grant. A nil field leaves the existing value.
func (p *PolicyConfig) Merge(other PolicyConfig) {
	if other.GateEnabled != nil {
		p.GateEnabled = other.GateEnabled
	}
	if other.GitIsolation != nil {
		p.GitIsolation = other.GitIsolation
	}
	if other.MCPAllowed != nil {
		p.MCPAllowed = unionStrings(p.MCPAllowed, other.MCPAllowed)
	}
	if other.MCPToolsAllowed != nil {
		p.MCPToolsAllowed = unionStrings(p.MCPToolsAllowed, other.MCPToolsAllowed)
	}
	if other.MCPBlocked != nil {
		p.MCPBlocked = unionStrings(p.MCPBlocked, other.MCPBlocked)
	}
	if other.MCPToolsBlocked != nil {
		p.MCPToolsBlocked = unionStrings(p.MCPToolsBlocked, other.MCPToolsBlocked)
	}
	if other.MCPAutoAllowRead != nil {
		p.MCPAutoAllowRead = other.MCPAutoAllowRead
	}
	if other.StrictMCP != nil {
		p.StrictMCP = other.StrictMCP
	}
	if other.AgentMessaging != nil {
		p.AgentMessaging = other.AgentMessaging
	}
	if other.KnownTools != nil {
		p.KnownTools = unionStrings(p.KnownTools, other.KnownTools)
	}
}

// SandboxConfig holds user-editable sandbox policy. All path lists are additive
// on top of the baked-in defaults (sandbox.Defaults()).
type SandboxConfig struct {
	// WritablePaths are extra paths made writable inside the sandbox.
	WritablePaths []string `toml:"writable_paths"`
	// MaskedPaths are extra paths hidden inside the sandbox.
	MaskedPaths []string `toml:"masked_paths"`
	// RestoreRO re-exposes paths read-only after masking their parent.
	RestoreRO []string `toml:"restore_ro"`
	// CowPaths are paths mounted copy-on-write: the agent reads the source
	// (read-only) and may overwrite it, but writes land in a per-head layer and
	// never touch the real files. A worktree-relative entry ("pipeline/out")
	// mirrors that path from the project root into the worktree; a home/absolute
	// entry ("~/.gradle", "/opt/cache") - resolved against HOME like the other
	// path lists - is overlaid in place and supersedes any default writable bind
	// on it (so per-head builds share the real cache read-only but keep their
	// writes and lock files private). Useful for large gitignored build
	// inputs/outputs or shared tool caches too big to copy. See sandbox.CowMount;
	// on Linux this needs an overlay-capable bwrap.
	CowPaths []string `toml:"cow_paths"`
	// InheritEnv names additional variables copied from the Hydra daemon's
	// environment into this agent. The head otherwise receives only Hydra's
	// baseline and the selected provider's authentication variables. Names union
	// across config layers; values are resolved only at launch and never stored.
	InheritEnv []string `toml:"inherit_env"`
	// Network is the network policy.
	Network *NetworkConfig `toml:"network"`
	// PreSpawnScript is an optional shell script run inside the sandbox
	// immediately before each agent is launched (e.g. `mise trust` or other
	// arbitrary setup). It runs in the agent's worktree with the same environment
	// and confinement as the agent, under the interpreter named by a leading `#!`
	// shebang or /bin/bash by default. When that interpreter is bash it runs under
	// `set -eo pipefail`, so a failing setup step aborts the launch (lead the
	// script with `set +e` to opt out). nil/empty = no script.
	PreSpawnScript *string `toml:"pre_spawn_script"`
	// PreExitScript is an optional shell script run inside a sandbox when a head
	// ends - after the agent's session is killed but BEFORE the worktree/branch
	// are torn down (kill/merge/restart/ephemeral-cleanup). It runs in a fresh
	// sandbox with this agent's policy, in the worktree (which still exists), with
	// the same HYDRA_* head-context variables plus HYDRA_END_STATE
	// ("killed"|"merged"|""). Use it for per-head teardown the agent didn't do
	// itself - e.g. releasing a claimed emulator slot from the worktree's
	// .hydra/emu.env. It is best-effort and bounded by a timeout. It runs via
	// `bash -c` under `set -eo pipefail`, so a failing step aborts the rest of the
	// teardown; lead the script with `set +e` (or use `cmd || true`) if cleanup
	// must continue past errors. Being sandboxed, it cannot reach host-only
	// resources (the host adb server, /dev/kvm); those belong to a host-side
	// [[services]] pool. nil/empty = no script.
	PreExitScript *string `toml:"pre_exit_script"`
}

// inheritedEnvReserved contains variables whose values Hydra constructs or
// controls for each launch. Letting config copy the daemon's value first would
// make their meaning depend on launch mode and could bypass the egress proxy.
var inheritedEnvReserved = map[string]bool{
	"HOME": true, "USER": true, "LOGNAME": true, "PATH": true, "SHELL": true,
	"LANG": true, "LC_ALL": true, "TERM": true, "COLORTERM": true,
	"TMPDIR": true, "TMP": true, "TEMP": true,
	"GIT_AUTHOR_NAME": true, "GIT_AUTHOR_EMAIL": true,
	"GIT_COMMITTER_NAME": true, "GIT_COMMITTER_EMAIL": true,
	"CLAUDE_CONFIG_DIR": true, "CODEX_HOME": true,
	"GEMINI_SYSTEM_MD": true, "GEMINI_WRITE_SYSTEM_MD": true,
	"CLAUDE_CODE_NO_FLICKER": true, "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN": true,
	"MISE_TRUSTED_CONFIG_PATHS": true,
	"HTTP_PROXY":                true, "HTTPS_PROXY": true, "ALL_PROXY": true, "NO_PROXY": true,
}

// ValidateInheritedEnvName checks one sandbox.inherit_env entry. It is exported
// so the launch-side environment builder can defend against programmatically
// constructed Config values as well as decoded files.
func ValidateInheritedEnvName(name string) error {
	if name == "" {
		return errtrace.Errorf("environment variable name is empty")
	}
	for i, r := range name {
		valid := r == '_' || r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' || i > 0 && r >= '0' && r <= '9'
		if !valid {
			return errtrace.Errorf("invalid environment variable name %q", name)
		}
	}
	upperName := strings.ToUpper(name)
	if strings.HasPrefix(upperName, "HYDRA_") || inheritedEnvReserved[upperName] {
		return errtrace.Errorf("environment variable %q is managed by Hydra and cannot be inherited", name)
	}
	return nil
}

func (c Config) validateInheritedEnv() error {
	validate := func(scope string, a AgentConfig) error {
		if a.Sandbox == nil {
			return nil
		}
		for _, name := range a.Sandbox.InheritEnv {
			if err := ValidateInheritedEnvName(name); err != nil {
				return errtrace.Wrap(fmt.Errorf("%s.sandbox.inherit_env: %w", scope, err))
			}
		}
		return nil
	}
	if err := validate("defaults", c.Defaults); err != nil {
		return errtrace.Wrap(err)
	}
	names := make([]string, 0, len(c.Agents))
	for name := range c.Agents {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if err := validate(name, c.Agents[name]); err != nil {
			return errtrace.Wrap(err)
		}
	}
	return nil
}

// ServiceScript describes a per-project long-running command Hydra supervises
// while the project is registered with the daemon. It is started on daemon boot
// (and when the project is added), restarted with capped backoff if it exits
// unexpectedly, and process-group-killed on daemon shutdown / project removal /
// config save. The canonical use is a host-side resource pool (e.g. a pool of
// Android emulators) shared by all heads of a project.
type ServiceScript struct {
	// Name uniquely identifies the service; used as the UI label and in logs.
	Name string `toml:"name"`
	// Script is the shell script run (via `bash -c`) from the project root.
	Script string `toml:"script"`
	// LegacyCommand is the old `command` spelling of Script, and is always "" past
	// decodeConfig - upgradeCommandKeys folds it in. It is still decoded so an
	// older config, or an older git ref's config (read as-is when a diff or
	// preview is generated), keeps working; the renderer only ever writes
	// `script`, so a save migrates the file. An entry setting BOTH keys is a
	// mistake, and `script` wins. Deliberately NOT named Command: nothing outside
	// the fold should read it, and a distinct name makes that a compile error
	// rather than a silent empty string.
	LegacyCommand string `toml:"command"`
	// Host, when true, runs the command directly on the host with NO sandbox -
	// full access to the machine, network and credentials. Required for services
	// that need host devices the sandbox hides (e.g. /dev/kvm for emulators).
	// Default false (the command is confined like an agent, rooted at the project).
	Host bool `toml:"host"`
	// MaxRestarts bounds how many times Hydra relaunches the command after an
	// unexpected exit before giving up and marking the service failed. nil =
	// default (DefaultServiceMaxRestarts); 0 = never restart. The counter resets
	// once the process has stayed up past the backoff window.
	MaxRestarts *int `toml:"max_restarts"`
	// Enabled gates whether the service is supervised at all. nil or true means
	// active; false means the daemon skips it entirely (not started, restarted,
	// or shown a live status). nil is the default so configs written before this
	// flag keep their services running.
	Enabled *bool `toml:"enabled"`
	// Strict runs the command under `set -eo pipefail` (errexit + pipefail) so a
	// failure in the startup script surfaces as a crash (and triggers the restart
	// policy) instead of a healthy-looking process whose setup silently failed.
	// nounset (-u) is not applied. nil or true = strict; false runs the command
	// exactly as written. nil is the default so pre-flag configs become strict; a
	// service needing lenient execution sets it false or leads with `set +e`.
	Strict *bool `toml:"strict"`
}

// IsEnabled reports whether the service should be supervised. An absent flag
// (nil) means enabled, for backward compatibility with pre-flag configs.
func (s ServiceScript) IsEnabled() bool { return scriptFlagEnabled(s.Enabled) }

// IsStrict reports whether the command runs under `set -eo pipefail`. An absent
// flag (nil) means strict, so a failed startup step surfaces rather than hiding.
func (s ServiceScript) IsStrict() bool { return scriptFlagEnabled(s.Strict) }

// scriptFlagEnabled is the shared absent-means-on rule for enabled and strict
// across services, artifacts, previews and tests.
func scriptFlagEnabled(flag *bool) bool { return flag == nil || *flag }

// AutoRunMode is the cache scheduling policy shared by tests and artifacts.
type AutoRunMode string

const (
	AutoRunAlways  AutoRunMode = "always"
	AutoRunSettled AutoRunMode = "settled"
	AutoRunNever   AutoRunMode = "never"
)

// DefaultServiceMaxRestarts is the restart cap applied when a service does not
// set max_restarts.
const DefaultServiceMaxRestarts = 3

// AgentConfig holds per-agent-type configuration.
type AgentConfig struct {
	// Sandbox overrides sandbox policy for this agent type.
	Sandbox *SandboxConfig `toml:"sandbox"`
	// Policy overrides the security-gate policy for this agent type.
	Policy *PolicyConfig `toml:"policy"`
	// PrePrompt is prepended to every agent prompt.
	PrePrompt *string `toml:"pre_prompt"`
	// Fullscreen enables Claude Code's fullscreen (alternate-screen) rendering.
	// nil/false means disabled, in which case Hydra forces the classic renderer
	// (see ResolveFullscreen / claudeRenderingEnv). It is a Claude-only setting:
	// although it lives on the shared AgentConfig type, it is accepted, rendered
	// and resolved ONLY under [claude] - a value at the defaults level or under any
	// other agent is ignored and dropped on save.
	Fullscreen *bool `toml:"fullscreen"`
}

// ArtifactScript describes a per-project command that generates visual
// artifacts (e.g. screenshots) for a checkout of the repository. The diff
// viewer runs it against both sides of a comparison and shows the outputs that
// differ. See internal/artifacts for the runner.
//
// Contract: the command is run with the checkout directory as its working
// directory and these environment variables set:
//   - HYDRA_ARTIFACT_OUTPUT: directory the script must write image files into
//   - HYDRA_ARTIFACT_SOURCE: the checkout directory (same as cwd)
//   - HYDRA_ARTIFACT_REF:    the resolved git ref/sha being rendered (best-effort)
//
// Streaming (optional): after writing a file (and its `<file>.meta` sidecar) the
// command may print `::hydra:artifact:: <path>` (path relative to
// HYDRA_ARTIFACT_OUTPUT) on stdout; Hydra then scans and diffs just that file and
// streams the tile to the UI immediately, rather than surfacing every output at
// once when the command exits. Emitting no markers still works - the final
// post-exit scan collects everything (see artifacts.FileMarker).
type ArtifactScript struct {
	// Name uniquely identifies the script; used as the UI label and cache dir.
	Name string `toml:"name"`
	// Script is the shell script run (via `bash -c`) in the checkout directory.
	Script string `toml:"script"`
	// LegacyCommand is the old `command` spelling of Script, and is always "" past
	// decodeConfig - upgradeCommandKeys folds it in. It is still decoded so an
	// older config, or an older git ref's config (read as-is when a diff or
	// preview is generated), keeps working; the renderer only ever writes
	// `script`, so a save migrates the file. An entry setting BOTH keys is a
	// mistake, and `script` wins. Deliberately NOT named Command: nothing outside
	// the fold should read it, and a distinct name makes that a compile error
	// rather than a silent empty string.
	LegacyCommand string `toml:"command"`
	// TimeoutSec bounds how long the command may run (0 = default, see artifacts).
	TimeoutSec int `toml:"timeout_sec"`
	// UnsafeHost, when true, runs the command directly on the host with NO
	// sandbox - full access to the user's credentials, network, and machine.
	// Default false (the command is confined like an agent). Only enable for a
	// self-contained, audited command when you trust every ref you will ever
	// compare: the command executes the *diffed ref's* code (build tooling,
	// package lifecycle scripts, the script file itself), and "trusted config"
	// authorizes only which command runs - not the contents of the checkout it
	// runs against. Heavy build scripts are the most tempted to set this and the
	// ones running the most untrusted code; prefer leaving it off.
	UnsafeHost bool `toml:"unsafe_host"`
	// CleanIgnored, when true, also removes git-ignored files (dependency/build
	// caches like node_modules) from the checkout before each run - `git clean
	// -fdx` instead of the default `git clean -fd`. Artifact generations reuse a
	// small pool of worktrees (see internal/artifacts), switching commits with
	// `git checkout --force`, which resets *tracked* files but leaves *ignored*
	// files in place so caches stay warm between runs. Leave this false for that
	// speed (a cold install/build every generation is slow). Set it true only if
	// your generator can be contaminated by a previous run's ignored output (stale
	// build artifacts leaking between commits): it trades the warm cache for a
	// guaranteed-pristine tree. Default false.
	CleanIgnored bool `toml:"clean_ignored"`
	// AutoRun controls when a missing artifact generation starts automatically:
	// "always" (or empty) preserves the historical behavior, "settled" waits
	// until the agent is no longer actively working, and "never" requires an
	// explicit refresh. Cached generations are returned in every mode.
	AutoRun AutoRunMode `toml:"auto_run"`
	// Enabled gates whether the diff viewer runs this script. nil or true means
	// active; false means it is skipped entirely. nil is the default so configs
	// written before this flag keep their artifacts running. Like unsafe_host,
	// the live (human-controlled) config is authoritative - a disabled script is
	// skipped regardless of what a diffed ref's own config claims.
	Enabled *bool `toml:"enabled"`
	// Strict runs the command under `set -eo pipefail` (errexit + pipefail) so a
	// failing step - or a failure mid-pipeline - aborts and propagates a non-zero
	// exit instead of being swallowed into a 0 that caches a half-broken render as
	// a success. nounset (-u) is not applied, since generators commonly read
	// optional env vars. nil or true = strict; false runs the command exactly as
	// written (bash defaults). nil is the default so pre-flag configs become
	// strict (the safer behavior); a script needing lenient execution sets it
	// false or leads its command with `set +e`.
	Strict *bool `toml:"strict"`
	// Type is LEGACY, and is always "" past decodeConfig. Live previews used to be
	// artifacts with type = "server"; they are now their own [previews.<name>]
	// section (see PreviewScript). The field is still decoded so an older config -
	// or an older git ref's config, which is read as-is when a diff is generated -
	// keeps working, but upgradeServerArtifacts consumes it at the end of
	// decodeConfig: a "server" entry moves to Previews, and any other value
	// ("media", "", a typo) is cleared, since all of them meant the one artifact
	// behavior there has ever been (a run-to-completion generator whose
	// image/video outputs the diff viewer compares). The renderer never writes it
	// back either, so a save drops the key from [artifacts.<name>] whichever value
	// it held.
	Type string `toml:"type"`
	// IdleTimeoutSec is LEGACY, decoded only to carry a type = "server" entry's
	// value across the upgrade to PreviewScript.IdleTimeoutSec.
	IdleTimeoutSec int `toml:"idle_timeout_sec"`
	// ReadyTimeoutSec is LEGACY, decoded only to carry a type = "server" entry's
	// value across the upgrade to PreviewScript.ReadyTimeoutSec.
	ReadyTimeoutSec int `toml:"ready_timeout_sec"`
}

// ArtifactTypeServer is the legacy ArtifactScript.Type value that used to select
// the live server preview behavior, before previews became their own section. It
// survives as the marker upgradeServerArtifacts matches on.
const ArtifactTypeServer = "server"

// IsEnabled reports whether the artifact script should run. An absent flag (nil)
// means enabled, for backward compatibility with pre-flag configs.
func (a ArtifactScript) IsEnabled() bool { return scriptFlagEnabled(a.Enabled) }

// IsStrict reports whether the command runs under `set -eo pipefail`. An absent
// flag (nil) means strict, so a failing step surfaces rather than being swallowed.
func (a ArtifactScript) IsStrict() bool { return scriptFlagEnabled(a.Strict) }

// IsServer reports whether this entry is a legacy type = "server" artifact, i.e.
// a preview written in the pre-[previews.<name>] syntax. Only the decode-time
// upgrade should need this: past decodeConfig, Artifacts never holds one.
func (a ArtifactScript) IsServer() bool { return a.Type == ArtifactTypeServer }

// PreviewScript describes a per-project command that starts a live HTTP server
// for a checkout of the repository - a "preview" of the head's app that you can
// click through, as opposed to the still images an ArtifactScript renders. Hydra
// proxies a dedicated port to it on demand: the server is spawned when the
// preview link is first opened, kept warm while requests flow, and torn down
// once idle (the next visit transparently respawns it). See internal/preview for
// the runner.
//
// Contract: the command is run with the checkout directory as its working
// directory and these environment variables set:
//   - HYDRA_PREVIEW_PORT:   the TCP port the server must listen on
//   - HYDRA_PREVIEW_ADDR:   the full host:port to bind - 0.0.0.0:PORT under
//     network mode hard, else 127.0.0.1:PORT. Bind this rather than hardcoding
//     127.0.0.1, or the proxy cannot reach the server under hard mode.
//   - HYDRA_PREVIEW_SOURCE: the checkout directory (same as cwd)
//
// Readiness (optional): the command may print `::hydra:server:ready::` on stdout
// once it is serving; otherwise the first successful dial of the port counts.
// `::hydra:progress:: <text>` sets the headline shown while it boots.
//
// Previews were originally written as [artifacts.<name>] tables with
// type = "server"; that spelling still parses and is upgraded to this type on
// load (see upgradeServerArtifacts).
type PreviewScript struct {
	// Name uniquely identifies the preview; used as the UI label and instance key.
	Name string `toml:"name"`
	// Script is the shell script run (via `bash -c`) in the checkout directory.
	// It must start a server on $HYDRA_PREVIEW_ADDR and stay in the foreground.
	Script string `toml:"script"`
	// LegacyCommand is the old `command` spelling of Script, and is always "" past
	// decodeConfig - upgradeCommandKeys folds it in. It is still decoded so an
	// older config, or an older git ref's config (read as-is when a diff or
	// preview is generated), keeps working; the renderer only ever writes
	// `script`, so a save migrates the file. An entry setting BOTH keys is a
	// mistake, and `script` wins. Deliberately NOT named Command: nothing outside
	// the fold should read it, and a distinct name makes that a compile error
	// rather than a silent empty string.
	LegacyCommand string `toml:"command"`
	// UnsafeHost, when true, runs the command directly on the host with NO
	// sandbox - full access to the user's credentials, network, and machine.
	// Default false. The same loud caveat as ArtifactScript.UnsafeHost applies,
	// and doubly so here: a preview runs the *previewed ref's* code, and it runs
	// it as a long-lived resident process rather than a one-shot render.
	UnsafeHost bool `toml:"unsafe_host"`
	// Enabled gates whether the preview is offered at all. nil or true means
	// active; false hides it from the agent page's Previews row. Like unsafe_host,
	// the live (human-controlled) config is authoritative - a disabled preview
	// stays disabled regardless of what a previewed ref's own config claims.
	Enabled *bool `toml:"enabled"`
	// Strict runs the command under `set -eo pipefail` so a failing build step
	// aborts the spawn (surfacing as a preview error) instead of being swallowed
	// into a server that boots against a half-built tree. nil or true = strict.
	Strict *bool `toml:"strict"`
	// IdleTimeoutSec is how long an instance may sit with zero in-flight proxied
	// requests before its process is torn down. Open WebSocket or long-poll
	// connections count as in-flight, so a live app tab keeps its preview
	// running. 0 = default (see internal/preview). The next visit to the preview
	// link transparently respawns it.
	IdleTimeoutSec int `toml:"idle_timeout_sec"`
	// ReadyTimeoutSec bounds how long a spawn may take to become ready - the
	// command may build first, so this is generous. Readiness is a successful TCP
	// dial of the child port, or an explicit `::hydra:server:ready::` line on
	// stdout, whichever comes first. 0 = default (see internal/preview).
	ReadyTimeoutSec int `toml:"ready_timeout_sec"`
}

// IsEnabled reports whether the preview should be offered. An absent flag (nil)
// means enabled, for backward compatibility with pre-flag configs.
func (p PreviewScript) IsEnabled() bool { return scriptFlagEnabled(p.Enabled) }

// IsStrict reports whether the command runs under `set -eo pipefail`. An absent
// flag (nil) means strict, so a failing build step surfaces as a failed spawn.
func (p PreviewScript) IsStrict() bool { return scriptFlagEnabled(p.Strict) }

// previewFromArtifact converts a legacy type = "server" artifact into the
// PreviewScript it now means. The artifact-only fields (timeout_sec,
// clean_ignored) never applied to a server entry, so nothing is lost.
func previewFromArtifact(a ArtifactScript) PreviewScript {
	return PreviewScript{
		Name:            a.Name,
		Script:          a.Script,
		UnsafeHost:      a.UnsafeHost,
		Enabled:         a.Enabled,
		Strict:          a.Strict,
		IdleTimeoutSec:  a.IdleTimeoutSec,
		ReadyTimeoutSec: a.ReadyTimeoutSec,
	}
}

// upgradeCommandKeys folds the legacy `command` key into `script` across all
// four script sections, in place, at the end of decodeConfig - so every consumer
// reads one field and a config predating the rename (including one at an older
// git ref, read as-is when a diff or preview is generated) keeps working. The
// legacy field is cleared afterwards, and the renderer only writes `script`, so
// a save migrates the file.
//
// `script` wins when an entry sets both. That combination is a mistake either
// way; preferring the current spelling makes the mistake behave the way someone
// mid-rename would expect, and keeps the fold idempotent.
func upgradeCommandKeys(cfg *Config) {
	for i := range cfg.Artifacts {
		foldCommand(&cfg.Artifacts[i].Script, &cfg.Artifacts[i].LegacyCommand)
	}
	for i := range cfg.Previews {
		foldCommand(&cfg.Previews[i].Script, &cfg.Previews[i].LegacyCommand)
	}
	for i := range cfg.Services {
		foldCommand(&cfg.Services[i].Script, &cfg.Services[i].LegacyCommand)
	}
	for i := range cfg.Tests {
		foldCommand(&cfg.Tests[i].Script, &cfg.Tests[i].LegacyCommand)
	}
}

// foldCommand moves a legacy `command` value into `script` unless `script` is
// already set, then clears it either way.
func foldCommand(script, legacyCommand *string) {
	if *script == "" {
		*script = *legacyCommand
	}
	*legacyCommand = ""
}

// upgradeServerArtifacts migrates the pre-[previews.<name>] spelling in place:
// every artifact with type = "server" is removed from cfg.Artifacts and appended
// to cfg.Previews as a PreviewScript. It runs at the END of decodeConfig, on ONE
// config layer, so the rest of the codebase only ever sees the new shape -
// including specs read from a git ref whose config.toml predates the split.
//
// An explicit [previews.<name>] in the same file wins over a same-named legacy
// artifact (the file's own new-syntax entry is the more deliberate statement);
// the legacy entry is still dropped from Artifacts, so a half-migrated file
// cannot end up running the script twice.
func upgradeServerArtifacts(cfg *Config) {
	if len(cfg.Artifacts) == 0 {
		return
	}
	byName := make(map[string]bool, len(cfg.Previews))
	for _, p := range cfg.Previews {
		byName[p.Name] = true
	}
	kept := make([]ArtifactScript, 0, len(cfg.Artifacts))
	for _, a := range cfg.Artifacts {
		if !a.IsServer() {
			// Every OTHER value - "media", "", or a typo - meant the one artifact
			// behavior there has ever been, so the key carries no information and
			// is cleared here rather than left to confuse a reader (or a future
			// caller) into thinking artifacts still have kinds. Cleared in memory
			// AND unrendered, so a `type = "media"` disappears from the file on the
			// next save exactly as a `type = "server"` does.
			a.Type = ""
			kept = append(kept, a)
			continue
		}
		if !byName[a.Name] {
			cfg.Previews = append(cfg.Previews, previewFromArtifact(a))
			byName[a.Name] = true
		}
		// The artifacts section's syntax decided how this entry layers, so carry
		// that decision over to the previews section it now belongs to.
		cfg.PreviewsNamed = cfg.PreviewsNamed || cfg.ArtifactsNamed
	}
	// A file that held ONLY server artifacts still declared the section, so keep
	// the (now empty) non-nil slice: nil means "not declared here", which the
	// renderer reads as preserve-mode and Merge reads as inherit.
	cfg.Artifacts = kept
}

// TestScript describes a per-project command that runs a test suite against a
// checkout of the repository and writes a machine-readable report. Hydra parses
// the report into a pass/fail verdict surfaced as a merge gate on the head's
// branch (see internal/tests and PLAN #68). It deliberately mirrors
// ArtifactScript field-for-field - the generation/cache/sandbox machinery is
// shared - differing only in the env contract and that the post-run step parses
// a report instead of scanning images.
//
// Contract: the command runs with the checkout directory as its working
// directory and these environment variables set:
//   - HYDRA_TEST_OUTPUT: directory the command must write a results file into
//     (JUnit XML *.xml or a Hydra-native *.json; see internal/tests for the shape)
//   - HYDRA_TEST_SOURCE: the checkout directory (same as cwd)
//   - HYDRA_TEST_REF:    the resolved git ref/sha being tested (best-effort)
type TestScript struct {
	// Name uniquely identifies the runner; used as the UI label and cache dir.
	Name string `toml:"name"`
	// Script is the shell script run (via `bash -c`) in the checkout directory.
	// It should write a JUnit-XML or Hydra-JSON report into $HYDRA_TEST_OUTPUT; if
	// it writes none, the exit code alone becomes a degenerate red/green verdict.
	Script string `toml:"script"`
	// LegacyCommand is the old `command` spelling of Script, and is always "" past
	// decodeConfig - upgradeCommandKeys folds it in. It is still decoded so an
	// older config, or an older git ref's config (read as-is when a diff or
	// preview is generated), keeps working; the renderer only ever writes
	// `script`, so a save migrates the file. An entry setting BOTH keys is a
	// mistake, and `script` wins. Deliberately NOT named Command: nothing outside
	// the fold should read it, and a distinct name makes that a compile error
	// rather than a silent empty string.
	LegacyCommand string `toml:"command"`
	// TimeoutSec bounds how long the command may run (0 = default, see internal/tests).
	TimeoutSec int `toml:"timeout_sec"`
	// UnsafeHost, when true, runs the command directly on the host with NO sandbox.
	// Same loud caveat as ArtifactScript.UnsafeHost: a [[tests]] command runs the
	// *diffed ref's* code (its test files, its bun install/go test), so leave it
	// off unless every ref you will ever test is trusted. Default false.
	UnsafeHost bool `toml:"unsafe_host"`
	// CleanIgnored, when true, also removes git-ignored files (dependency/build
	// caches) before each run - `git clean -fdx` instead of the default `-fd`.
	// Leave false to keep caches warm between runs. Default false.
	CleanIgnored bool `toml:"clean_ignored"`
	// AutoRun controls when a missing test run starts automatically. See
	// ArtifactScript.AutoRun for the accepted values and cache behavior.
	AutoRun AutoRunMode `toml:"auto_run"`
	// Enabled gates whether the test gate runs this command. nil or true means
	// active; false skips it entirely. nil is the default for backward compat.
	Enabled *bool `toml:"enabled"`
	// Strict runs the command under `set -eo pipefail`. nil or true = strict;
	// false runs the command exactly as written. Note: a test runner exiting
	// non-zero because tests FAILED is a valid (cacheable) result, not a strict
	// abort - strict only governs the shell pipeline, the verdict comes from the
	// parsed report. nil is the default.
	Strict *bool `toml:"strict"`
	// Type selects how the run's results are read (see internal/tests):
	//   - "junit" (default, also for ""): parse the *.xml/*.json report files the
	//     command wrote into $HYDRA_TEST_OUTPUT after it exits.
	//   - "stdout": parse `::hydra:test:<pass|fail|warn|skip>[:<ms>]:: location › name | msg`
	//     markers live from the command's stdout - the accumulated cases ARE the
	//     report (no file needed), and counts stream into the UI as they happen.
	//     One marker per line; the optional `:<ms>` suffix carries the case's
	//     duration, and a message may use `\n`/`\t`/`\r`/`\\` escapes to carry a
	//     multi-line failure on that single line (see internal/tests).
	Type string `toml:"type"`
}

// IsEnabled reports whether the test runner should run. An absent flag (nil)
// means enabled, for backward compatibility with pre-flag configs.
func (t TestScript) IsEnabled() bool { return scriptFlagEnabled(t.Enabled) }

// IsStrict reports whether the command runs under `set -eo pipefail`. An absent
// flag (nil) means strict.
func (t TestScript) IsStrict() bool { return scriptFlagEnabled(t.Strict) }

// IsStreaming reports whether results are parsed live from stdout markers
// (type = "stdout") rather than from report files after exit.
func (t TestScript) IsStreaming() bool { return t.Type == "stdout" }

// ResourceLimits configures the cgroup limits applied to every scoped workload
// (agent, preview, service, artifact) of a project via its transient systemd
// scope. It is deliberately per-project and one section for all workload kinds -
// this matches the failure mode it guards against (total machine load), not any
// single agent. All fields are pointers so a config layer can override one
// without clobbering the rest (nil = inherit the layer below, then the built-in
// default). Values resolve into a sandbox.ScopeLimits at each call site via
// ResolveResourceLimits; the sandbox package never reads config.
//
// Weights are soft (they only bite under contention). CPU and IO throughput use
// machine-scaled safe defaults because those are the resources most likely to
// make the desktop unresponsive; an explicit 0 opts out. Memory and task caps
// remain opt-in because crossing either can terminate otherwise valid work.
type ResourceLimits struct {
	// CPUWeight is the relative CPU share under contention (systemd CPUWeight,
	// 1-10000). Soft. nil = the built-in default (sandbox.ScopeCPUWeight).
	CPUWeight *int `toml:"cpu_weight"`
	// IOWeight is the relative block-IO share under contention (systemd IOWeight,
	// 1-10000). Soft, like CPUWeight. Needs a weight-capable IO scheduler. nil =
	// the built-in default (sandbox.ScopeIOWeight).
	IOWeight *int `toml:"io_weight"`
	// CPUQuota is a hard CPU cap in percent of one core (systemd CPUQuota; 200 =
	// 2 cores). nil = the machine-scaled safe default; 0 = no cap.
	CPUQuota *int `toml:"cpu_quota"`
	// MemoryMax is a hard memory ceiling in MB (systemd MemoryMax); the cgroup is
	// OOM-killed past it. nil / 0 = no cap.
	MemoryMax *int `toml:"memory_max"`
	// TasksMax is a hard cap on processes/threads (systemd TasksMax); guards
	// against fork bombs / PID exhaustion. nil / 0 = no cap.
	TasksMax *int `toml:"tasks_max"`
	// IOReadBandwidthMax / IOWriteBandwidthMax are hard throughput ceilings in
	// MB/s (systemd IOReadBandwidthMax=/IOWriteBandwidthMax=, i.e. cgroup io.max),
	// applied to the device backing the project root. nil = the safe default
	// (80/40 MB/s); 0 = no cap.
	//
	// Reach for these rather than io_weight when a single head can still stall the
	// machine: weights only work under BFQ or blk-iocost, and on a typical NVMe
	// (`none` scheduler, iocost unconfigured) io_weight is accepted and does
	// nothing. These are blk-throttle, which needs no host setup. The daemon logs
	// a warning at startup when it detects that io_weight is inert.
	IOReadBandwidthMax  *int `toml:"io_read_bandwidth_max"`
	IOWriteBandwidthMax *int `toml:"io_write_bandwidth_max"`

	// Machine and background fields are machine-wide and are resolved only from
	// the user config. Project/local values are preserved but never applied.
	MachineCPUQuota               *int `toml:"machine_cpu_quota"`
	MachineIOReadBandwidthMax     *int `toml:"machine_io_read_bandwidth_max"`
	MachineIOWriteBandwidthMax    *int `toml:"machine_io_write_bandwidth_max"`
	BackgroundCPUQuota            *int `toml:"background_cpu_quota"`
	BackgroundIOReadBandwidthMax  *int `toml:"background_io_read_bandwidth_max"`
	BackgroundIOWriteBandwidthMax *int `toml:"background_io_write_bandwidth_max"`
}

// isEmpty reports whether no field is set at this layer (all pointers nil), so
// the renderer emits the commented example instead of an empty [resources] table.
func (r ResourceLimits) isEmpty() bool {
	return r.CPUWeight == nil && r.IOWeight == nil && r.CPUQuota == nil &&
		r.MemoryMax == nil && r.TasksMax == nil &&
		r.IOReadBandwidthMax == nil && r.IOWriteBandwidthMax == nil &&
		r.MachineCPUQuota == nil && r.MachineIOReadBandwidthMax == nil &&
		r.MachineIOWriteBandwidthMax == nil && r.BackgroundCPUQuota == nil &&
		r.BackgroundIOReadBandwidthMax == nil && r.BackgroundIOWriteBandwidthMax == nil
}

// Merge merges another ResourceLimits into this one: per-field last-wins, so a
// later layer overriding one field leaves the rest inherited. A nil field in
// other leaves the existing value (NOT union - these are scalars).
func (r *ResourceLimits) Merge(other ResourceLimits) {
	if other.CPUWeight != nil {
		r.CPUWeight = other.CPUWeight
	}
	if other.IOWeight != nil {
		r.IOWeight = other.IOWeight
	}
	if other.CPUQuota != nil {
		r.CPUQuota = other.CPUQuota
	}
	if other.MemoryMax != nil {
		r.MemoryMax = other.MemoryMax
	}
	if other.TasksMax != nil {
		r.TasksMax = other.TasksMax
	}
	if other.IOReadBandwidthMax != nil {
		r.IOReadBandwidthMax = other.IOReadBandwidthMax
	}
	if other.IOWriteBandwidthMax != nil {
		r.IOWriteBandwidthMax = other.IOWriteBandwidthMax
	}
	if other.MachineCPUQuota != nil {
		r.MachineCPUQuota = other.MachineCPUQuota
	}
	if other.MachineIOReadBandwidthMax != nil {
		r.MachineIOReadBandwidthMax = other.MachineIOReadBandwidthMax
	}
	if other.MachineIOWriteBandwidthMax != nil {
		r.MachineIOWriteBandwidthMax = other.MachineIOWriteBandwidthMax
	}
	if other.BackgroundCPUQuota != nil {
		r.BackgroundCPUQuota = other.BackgroundCPUQuota
	}
	if other.BackgroundIOReadBandwidthMax != nil {
		r.BackgroundIOReadBandwidthMax = other.BackgroundIOReadBandwidthMax
	}
	if other.BackgroundIOWriteBandwidthMax != nil {
		r.BackgroundIOWriteBandwidthMax = other.BackgroundIOWriteBandwidthMax
	}
}

type Config struct {
	// Defaults for all agents.
	Defaults AgentConfig `toml:"defaults"`
	// Per-agent overrides (e.g. claude, gemini).
	Agents map[string]AgentConfig `toml:"agents"`
	// Artifacts are per-project visual-artifact generation scripts.
	Artifacts []ArtifactScript `toml:"artifacts"`
	// Previews are per-project live-server scripts, each proxied on demand as a
	// clickable preview of the head's app. Populated from [previews.<name>] and,
	// for configs written before previews were their own section, from legacy
	// [artifacts.<name>] entries with type = "server" (see upgradeServerArtifacts).
	Previews []PreviewScript `toml:"previews"`
	// Services are per-project long-running commands the daemon supervises.
	Services []ServiceScript `toml:"services"`
	// Tests are per-project test-runner commands whose pass/fail verdict gates a
	// head's merge button (see internal/tests, PLAN #68).
	Tests []TestScript `toml:"tests"`
	// ArtifactsNamed / ServicesNamed / TestsNamed record which SYNTAX this
	// file's section used, because the syntax selects the layer-merge behavior:
	//
	//   [tests.go]      named-table form (canonical): entries MERGE by name into
	//                   the list inherited from earlier config layers (internal
	//                   defaults -> user -> project -> config.local.toml). A
	//                   same-named entry patches the inherited one - set fields
	//                   override, zero/absent fields inherit, so a local
	//                   `[tests.lint]` with just `enabled = false` disables one
	//                   runner without restating its command - and a new name
	//                   appends.
	//   [[tests]]       legacy array form: replaces the inherited list wholesale,
	//                   as it always has.
	//
	// Set by decodeConfig, not by a TOML key (toml:"-" keeps a literal
	// artifacts_named key from masquerading as the real thing).
	//
	// PreviewsNamed additionally counts a legacy type = "server" artifact that
	// was upgraded into Previews: the syntax that carried it selects the merge
	// behavior, exactly as if it had been written as [previews.<name>].
	ArtifactsNamed bool `toml:"-"`
	PreviewsNamed  bool `toml:"-"`
	ServicesNamed  bool `toml:"-"`
	TestsNamed     bool `toml:"-"`
	// Icon is an optional custom project icon shown in the web UI's project
	// switcher and dropdown, in place of the default folder glyph. A single string
	// interpreted by its content: an emoji (e.g. "🚀") renders as-is; a lucide-react
	// icon name (e.g. "Rocket") renders that icon; a value ending in an image
	// extension (.png/.svg/.ico/.jpg/...) is an image - an http(s)/data URI is used
	// directly, any other value is a path served from the project by the backend
	// (see the /project-icon route). nil/"" = the default folder icon.
	Icon *string `toml:"icon"`
	// ResumePrompt is the message typed into an agent that was actively working
	// when the daemon was restarted, so it picks up where it left off instead of
	// sitting idle after its conversation is restored (see DefaultResumePrompt).
	// nil = use DefaultResumePrompt; "" = disable the auto-continue nudge.
	ResumePrompt *string `toml:"resume_prompt"`
	// ArtifactConcurrency caps how many visual-artifact generations run at once,
	// shared across foreground (a user viewing a diff) and background (proactive
	// pre-generation) work. Generations can be heavy - a full build per ref, and
	// some boot RAM-hungry tooling (e.g. emulators) - so this bounds how many run
	// in parallel; lower it for memory-hungry generators. Foreground requests are
	// always served before queued background ones, and a running generation is
	// never preempted. It is a pointer so three states are distinct: nil/absent =
	// use DefaultArtifactConcurrency; 0 = unlimited (no cap); N>0 = at most N.
	ArtifactConcurrency *int `toml:"artifact_concurrency"`
	// ArtifactPrefetch toggles the daemon's proactive background pre-generation of
	// artifacts for settled heads (see internal/http/prefetch.go). When on (the
	// default) a head's diff artifacts are rendered in the background once its
	// working tree stops changing, so they are ready the instant the user opens the
	// panel. Turn it off for a project whose generators are too heavy to run
	// speculatively: foreground generation (on open) and the concurrency cap above
	// still apply. nil/absent = enabled.
	ArtifactPrefetch *bool `toml:"artifact_prefetch"`
	// TestConcurrency caps how many test-runner generations run at once, like
	// ArtifactConcurrency. nil/absent = DefaultTestConcurrency; 0 = unlimited.
	TestConcurrency *int `toml:"test_concurrency"`
	// PreviewPorts is the inclusive TCP port range ("min-max", e.g. "26601-26699")
	// the daemon allocates live server-preview listeners from (see PreviewScript
	// and internal/preview). A fixed, contiguous
	// range keeps firewall rules simple when the web UI is exposed beyond
	// localhost; listeners bind the same host as the web server. Ports already in
	// use are skipped. nil/absent = DefaultPreviewPorts.
	PreviewPorts *string `toml:"preview_ports"`
	// TestPrefetch toggles the daemon's proactive background re-running of a head's
	// test suites once its branch tip has a verdict that is missing or stale (a
	// cached result computed for an older commit). It mirrors ArtifactPrefetch (see
	// internal/http/tests_prefetch.go). When on (the default) a head's verdict is
	// kept fresh in the background so it is ready the instant the user opens the
	// tests panel or the merge gate runs. Turn it off for a project whose suites are
	// too heavy to run speculatively: foreground runs (on open / at merge) and the
	// concurrency cap above still apply. nil/absent = enabled.
	TestPrefetch *bool `toml:"test_prefetch"`
	// Review configures how Hydra talks to a forge (GitHub/GitLab) and supplies
	// defaults for the Create MR dialog (docs/non-local-integration.md). nil = unset
	// (a local-first project never touches any of it). Pointer so its own fields'
	// nil-means-default convention is preserved across the merge layers.
	Review *ReviewConfig `toml:"review"`
	// Notify configures which events wake a head with a short message. Its own
	// section rather than switches scattered through [review] and [tests], because
	// the list of things that can notify keeps growing and one place to look is
	// worth more than each switch sitting next to its source. nil = defaults.
	Notify *NotifyConfig `toml:"notify"`
	// Jira is the deprecated issue-pattern spelling, retained as a compatibility
	// fallback for [review].issue_pattern.
	Jira *JiraConfig `toml:"jira"`
	// Resources configures the cgroup limits (CPU/IO weight, CPU quota, memory max,
	// tasks max) applied to every scoped workload of this project via its transient
	// systemd scope. nil = all safe defaults. Pointer so its own fields'
	// nil-means-default convention is preserved across merge layers.
	Resources *ResourceLimits `toml:"resources"`
}

// ResolveResourceLimits resolves this project's [resources] table into the
// sandbox.ScopeLimits threaded to each scoped-workload call site. Unset weights,
// CPU quota and IO throughput limits use built-in safe defaults; explicit zero
// disables a hard cap. Memory and task caps remain off unless configured. This
// is the single seam all workload call sites use, so limits never leak config
// into the sandbox package.
//
// ioPath is the project root: the IO bandwidth caps are per-device, and systemd
// resolves a plain path to the device backing it. It is a parameter rather than
// a config field because it is never the user's to choose - passing it here is
// what stops a call site configuring a cap that then silently has no device to
// apply to.
func (c Config) ResolveResourceLimits(ioPath string) sandbox.ScopeLimits {
	limits := sandbox.ScopeLimits{
		CPUWeight:           sandbox.ScopeCPUWeight,
		IOWeight:            sandbox.ScopeIOWeight,
		CPUQuota:            sandbox.DefaultWorkloadCPUQuota(runtime.NumCPU()),
		IOPath:              ioPath,
		IOReadBandwidthMax:  sandbox.DefaultWorkloadIOReadBandwidthMax,
		IOWriteBandwidthMax: sandbox.DefaultWorkloadIOWriteBandwidthMax,
	}
	r := c.Resources
	if r == nil {
		return limits
	}
	if r.CPUWeight != nil {
		limits.CPUWeight = *r.CPUWeight
	}
	if r.IOWeight != nil {
		limits.IOWeight = *r.IOWeight
	}
	if r.CPUQuota != nil {
		limits.CPUQuota = *r.CPUQuota
	}
	if r.MemoryMax != nil {
		limits.MemoryMax = *r.MemoryMax
	}
	if r.IOReadBandwidthMax != nil {
		limits.IOReadBandwidthMax = *r.IOReadBandwidthMax
	}
	if r.IOWriteBandwidthMax != nil {
		limits.IOWriteBandwidthMax = *r.IOWriteBandwidthMax
	}
	if r.TasksMax != nil {
		limits.TasksMax = *r.TasksMax
	}
	return limits
}

// ResolveAggregateResourceLimits resolves machine-wide parent-slice ceilings.
// Call this only on the raw user config, never a project-merged Config.
func (c Config) ResolveAggregateResourceLimits() sandbox.AggregateLimits {
	limits := sandbox.DefaultAggregateLimits(runtime.NumCPU())
	if c.Resources == nil {
		return limits
	}
	r := c.Resources
	if r.MachineCPUQuota != nil {
		limits.MachineCPUQuota = *r.MachineCPUQuota
	}
	if r.MachineIOReadBandwidthMax != nil {
		limits.MachineIOReadBandwidthMax = *r.MachineIOReadBandwidthMax
	}
	if r.MachineIOWriteBandwidthMax != nil {
		limits.MachineIOWriteBandwidthMax = *r.MachineIOWriteBandwidthMax
	}
	if r.BackgroundCPUQuota != nil {
		limits.BackgroundCPUQuota = *r.BackgroundCPUQuota
	}
	if r.BackgroundIOReadBandwidthMax != nil {
		limits.BackgroundIOReadBandwidthMax = *r.BackgroundIOReadBandwidthMax
	}
	if r.BackgroundIOWriteBandwidthMax != nil {
		limits.BackgroundIOWriteBandwidthMax = *r.BackgroundIOWriteBandwidthMax
	}
	return limits
}

// DefaultTestConcurrency is the test-runner parallelism used when the config
// does not set test_concurrency. Test suites are typically heavier and more
// resource-hungry than artifact renders (and a head usually has just one), so it
// defaults lower than DefaultArtifactConcurrency.
const DefaultTestConcurrency = 1

// ResolveTestConcurrency returns the effective test-runner concurrency: the
// configured value when set (0 = unlimited), or DefaultTestConcurrency when unset.
func (c Config) ResolveTestConcurrency() int {
	if c.TestConcurrency == nil {
		return DefaultTestConcurrency
	}
	return *c.TestConcurrency
}

// IsTestPrefetchEnabled reports whether the daemon should proactively re-run a
// head's test suites in the background when its verdict is missing/stale. Absent
// (nil) means enabled, mirroring IsArtifactPrefetchEnabled.
func (c Config) IsTestPrefetchEnabled() bool {
	return c.TestPrefetch == nil || *c.TestPrefetch
}

// DefaultArtifactConcurrency is the artifact-generation parallelism used when
// the config does not set artifact_concurrency. Two saturates a normal diff
// view (left+right of one script) while keeping heavy builds from fanning out.
const DefaultArtifactConcurrency = 2

// ResolveArtifactConcurrency returns the effective artifact-generation
// concurrency limit: the configured value when set (0 means unlimited), or
// DefaultArtifactConcurrency when unset (nil). The result is the cap passed to
// the generator's scheduler, where 0 disables the cap entirely.
func (c Config) ResolveArtifactConcurrency() int {
	if c.ArtifactConcurrency == nil {
		return DefaultArtifactConcurrency
	}
	return *c.ArtifactConcurrency
}

// IsArtifactPrefetchEnabled reports whether the daemon should proactively
// pre-generate artifacts for settled heads. Absent (nil) means enabled.
func (c Config) IsArtifactPrefetchEnabled() bool {
	return c.ArtifactPrefetch == nil || *c.ArtifactPrefetch
}

// DefaultPreviewPorts is the server-preview listener port range used when the
// config does not set preview_ports. It sits directly above the default web
// port (26600) so Hydra's whole footprint is one contiguous block.
const DefaultPreviewPorts = "26601-26699"

// ResolvePreviewPortRange returns the effective inclusive port range previews
// allocate listeners from. A missing or malformed preview_ports falls back to
// DefaultPreviewPorts rather than failing: preview spin-up is interactive and a
// typo'd range should not brick the daemon.
func (c Config) ResolvePreviewPortRange() (min, max int) {
	if c.PreviewPorts != nil {
		if lo, hi, err := ParsePortRange(*c.PreviewPorts); err == nil {
			return lo, hi
		}
	}
	lo, hi, _ := ParsePortRange(DefaultPreviewPorts)
	return lo, hi
}

// ParsePortRange parses an inclusive "min-max" TCP port range like
// "26601-26699". A single port ("26601") is the degenerate one-port range.
func ParsePortRange(s string) (min, max int, err error) {
	lo, hi, found := strings.Cut(strings.TrimSpace(s), "-")
	if !found {
		hi = lo
	}
	min, err = strconv.Atoi(strings.TrimSpace(lo))
	if err != nil {
		return 0, 0, errtrace.Errorf("invalid port range %q: %w", s, err)
	}
	max, err = strconv.Atoi(strings.TrimSpace(hi))
	if err != nil {
		return 0, 0, errtrace.Errorf("invalid port range %q: %w", s, err)
	}
	if min < 1 || max > 65535 || min > max {
		return 0, 0, errtrace.Errorf("invalid port range %q: want 1 <= min <= max <= 65535", s)
	}
	return min, max, nil
}

// ResumeContinueMessage returns the message to auto-send to a resumed,
// previously-working agent. An empty string disables the nudge.
func (c Config) ResumeContinueMessage() string {
	if c.ResumePrompt == nil {
		return DefaultResumePrompt
	}
	return *c.ResumePrompt
}

// rawConfig is the intermediate decode target. It accepts BOTH the legacy
// nested layout ([defaults], [defaults.sandbox], [agents.<name>]) and the new
// flattened layout (top-level pre_prompt/[sandbox], and one top-level table per
// agent, e.g. [claude]). decodeConfig folds it into a Config. The dynamic agent
// tables of the new layout are not fields here - they are captured separately
// via toml.Primitive (any top-level table whose name is not reserved).
type rawConfig struct {
	// Legacy layout.
	Defaults *AgentConfig           `toml:"defaults"`
	Agents   map[string]AgentConfig `toml:"agents"`
	// New flattened defaults (top level).
	PrePrompt *string        `toml:"pre_prompt"`
	Sandbox   *SandboxConfig `toml:"sandbox"`
	Policy    *PolicyConfig  `toml:"policy"`
	// Shared. The three script sections accept two shapes - the canonical named
	// tables ([tests.go]) and the legacy array-of-tables ([[tests]]) - so they
	// are captured as primitives and decoded by decodeScriptSection.
	Artifacts           toml.Primitive  `toml:"artifacts"`
	Previews            toml.Primitive  `toml:"previews"`
	Services            toml.Primitive  `toml:"services"`
	Tests               toml.Primitive  `toml:"tests"`
	Icon                *string         `toml:"icon"`
	ResumePrompt        *string         `toml:"resume_prompt"`
	ArtifactConcurrency *int            `toml:"artifact_concurrency"`
	ArtifactPrefetch    *bool           `toml:"artifact_prefetch"`
	TestConcurrency     *int            `toml:"test_concurrency"`
	TestPrefetch        *bool           `toml:"test_prefetch"`
	PreviewPorts        *string         `toml:"preview_ports"`
	Review              *ReviewConfig   `toml:"review"`
	Notify              *NotifyConfig   `toml:"notify"`
	Jira                *JiraConfig     `toml:"jira"`
	Resources           *ResourceLimits `toml:"resources"`
}

// reservedTopLevel are the top-level TOML names that are NOT agent tables. Any
// other top-level table is treated as an agent override, so new agent types
// need no code change. Consequently an agent literally named one of these is
// unrepresentable in the flattened layout - fine for real agent types
// (claude/gemini/bash/copilot/codex).
var reservedTopLevel = map[string]bool{
	"defaults": true, "agents": true,
	"pre_prompt": true, "sandbox": true, "policy": true, "artifacts": true, "previews": true,
	"services":      true,
	"tests":         true,
	"icon":          true,
	"resume_prompt": true, "artifact_concurrency": true, "artifact_prefetch": true, "test_concurrency": true,
	"test_prefetch": true, "preview_ports": true,
	// "tickets" is reserved so the removed experimental table is ignored rather
	// than misread as an agent-type override. It supplies no configuration.
	"review": true, "tickets": true, "jira": true, "resources": true,
}

// GetUserConfigPath returns the path to the global user configuration file.
func GetUserConfigPath() (string, error) {
	configDir, err := os.UserConfigDir()
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	return filepath.Join(configDir, "hydra", "config.toml"), nil
}

// GetProjectConfigPath returns the path to the project-specific configuration file.
func GetProjectConfigPath(projectRoot string) string {
	return filepath.Join(projectRoot, ".hydra", "config.toml")
}

// ReadProjectConfigTOML returns the raw bytes of the project's .hydra/config.toml
// and whether the file exists. An absent file is (nil, false, nil) - not an error.
// The raw bytes (rather than the parsed config) are what the UI shows the user
// when they open a project, so they can review what they're about to run.
func ReadProjectConfigTOML(projectRoot string) ([]byte, bool, error) {
	if projectRoot == "" {
		return nil, false, nil
	}
	data, err := os.ReadFile(GetProjectConfigPath(projectRoot))
	if os.IsNotExist(err) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, errtrace.Wrap(err)
	}
	return data, true, nil
}

// LoadInternalDefaults returns the hardcoded internal default configuration.
// Note: DefaultPrePrompt is not stored here - it is always prepended by BuildFinalPrePrompt.
func LoadInternalDefaults() Config {
	return Config{}
}

// BuildFinalPrePrompt constructs the final pre-prompt for an agent by merging:
// 1. The built-in DefaultPrePrompt (always first)
// 2. The configured defaults pre-prompt (if set)
// 3. The agent-specific pre-prompt (if set)
// The result ends with "\n\nTask:\n" to separate the pre-prompt from the user task.
// The <network-info> placeholder is resolved here (it needs cfg + agentType); the
// <branch> and <base-branch> placeholders are substituted later by the caller.
func BuildFinalPrePrompt(cfg Config, agentType string) string {
	parts := []string{DefaultPrePrompt, shellSectionPrompt}
	if agentType == string(sandbox.AgentTypeCodex) {
		parts = append(parts, codexBashDescriptionPrompt)
	}
	if agentType == string(sandbox.AgentTypeClaude) {
		parts = append(parts, claudeShellCwdPrompt)
	}
	if cfg.Defaults.PrePrompt != nil && *cfg.Defaults.PrePrompt != "" {
		parts = append(parts, *cfg.Defaults.PrePrompt)
	}
	if agentCfg, ok := cfg.Agents[agentType]; ok && agentCfg.PrePrompt != nil && *agentCfg.PrePrompt != "" {
		parts = append(parts, *agentCfg.PrePrompt)
	}
	final := strings.Join(parts, "\n") + "\n\nTask:\n"
	return strings.ReplaceAll(final, "<network-info>", networkInfoLine(cfg, agentType))
}

// RunModeLine renders the head's run mode as a pre-prompt bullet, substituted
// into the <run-mode> placeholder. It states a neutral fact - chat/stream-json
// vs interactive terminal - that standing instructions (e.g. CLAUDE.md) can
// branch on, rather than baking mode-specific behaviour into the pre-prompt
// itself. Resolved per-launch from the live chatMode (see SpawnHead/ResumeHead),
// so a chat<->terminal toggle is reflected on the next launch. The mode is fixed
// for a session, so this never changes the system prompt mid-conversation.
func RunModeLine(chatMode bool) string {
	if chatMode {
		return "- Run mode: chat (stream-json). You are driven through a structured " +
			"JSON protocol and your replies are rendered as Markdown in Hydra's web " +
			"chat UI, not written to a terminal. To SHOW the user a picture - a " +
			"screenshot you took, a generated image - embed its path as a markdown " +
			"image (`![what it shows](/tmp/shot@2x.png)`): Hydra serves image files " +
			"from your worktree and your /tmp, so they render inline in the chat. " +
			"Capture screenshots at 2x device scale and name them `<name>@2x.png` - " +
			"the chat lays an image out at its logical size (pixels / the @Nx in its " +
			"name), so a 2x capture is the same size as a 1x one but stays sharp on " +
			"a HiDPI display, where a 1x image is blown up and looks blurry. VIDEO " +
			"works the same way and through the same syntax: point a markdown image " +
			"at a .webm/.mp4 (`![the popover opening](/tmp/demo.webm)`) and it renders " +
			"as an inline player with controls, so a transition, an animation or a " +
			"short flow that a still cannot show can be demoed by recording it (e.g. " +
			"Playwright's `recordVideo`, or ffmpeg). The @Nx naming applies to a clip " +
			"too. Keep clips short and prefer .webm - it is the format that plays " +
			"everywhere without a codec question.\n"
	}
	return "- Run mode: terminal. You are attached to an interactive terminal (PTY) " +
		"session.\n"
}

// networkInfoLine renders the agent's resolved egress posture as a pre-prompt
// bullet, so the head knows up-front whether it has network and what happens when
// it reaches a non-allow-listed host. Substituted into the <network-info>
// placeholder. Mirrors resolveNetworkPolicy's resolution (explicit mode, else
// legacy booleans, else the hard default). Note: like <branch>, this is baked in
// at spawn and stored on the head, so it reflects the mode at spawn time - a later
// config change to network.mode is not re-resolved on resume.
func networkInfoLine(cfg Config, agentType string) string {
	var nc *NetworkConfig
	if sb := cfg.GetResolvedConfig(agentType).Sandbox; sb != nil {
		nc = sb.Network
	}
	net := resolveNetworkPolicy(nc)

	// Shared explanation of the allow-list approval flow for the filtered modes.
	const approval = " When you reach a host on neither the allow-list nor the " +
		"block-list, the connection is HELD while the user is prompted to approve or " +
		"deny it - this covers ALL egress (`curl`, `git`, the `WebFetch` tool, ...), not " +
		"just one tool. Approve and the host is allowed for the rest of the session " +
		"(\"always allow\" also persists it to `network.allowed_hosts`); deny - or wait " +
		"out the ~5-minute timeout with no answer - and the connection is refused. A " +
		"block-listed host is refused outright with no prompt. So a first request to a " +
		"new host will PAUSE rather than fail instantly; wait for the decision instead " +
		"of retrying, and if it's denied, ask the user rather than working around it."

	switch net.Mode {
	case sandbox.NetOff:
		return "- Network access is OFF: all outbound connections are blocked. If the " +
			"task needs the network, STOP and ask the user to change `network.mode`.\n"
	case sandbox.NetUnrestricted:
		return "- Network access is unrestricted: every host is reachable and no host " +
			"filtering is applied.\n"
	case sandbox.NetAdvisory:
		return "- Network egress is filtered (advisory mode - a per-head HTTP(S) proxy " +
			"allow-list, best-effort rather than an inescapable boundary): only hosts on " +
			"the allow-list (a built-in default set plus the project's " +
			"`network.allowed_hosts`) are reachable; everything else is blocked." + approval + "\n"
	default: // NetHard
		return "- Network egress is filtered (hard mode - an inescapable allow-list " +
			"boundary): only hosts on the allow-list (a built-in default set plus the " +
			"project's `network.allowed_hosts`) are reachable; everything else is " +
			"blocked." + approval + "\n"
	}
}

// decodeConfig parses config.toml content, accepting BOTH the legacy nested
// layout ([defaults]/[defaults.sandbox]/[agents.<name>]) and the new flattened
// layout (top-level pre_prompt/[sandbox], one top-level table per agent). Empty
// content decodes to a zero Config (not an error).
func decodeConfig(data []byte) (Config, error) {
	var cfg Config
	if len(strings.TrimSpace(string(data))) == 0 {
		return cfg, nil
	}

	// Pass 1: enumerate every top-level name as a primitive so we can find the
	// new-layout agent tables (any name that is not reserved).
	var prims map[string]toml.Primitive
	md, err := toml.Decode(string(data), &prims)
	if err != nil {
		return cfg, errtrace.Wrap(err)
	}
	// Pass 2: decode the reserved keys with their full nested typing.
	var raw rawConfig
	md2, err := toml.Decode(string(data), &raw)
	if err != nil {
		return cfg, errtrace.Wrap(err)
	}

	cfg.Artifacts, cfg.ArtifactsNamed, err = decodeScriptSection(md2, raw.Artifacts, "artifacts",
		func(a *ArtifactScript) *string { return &a.Name })
	if err != nil {
		return cfg, errtrace.Wrap(err)
	}
	cfg.Previews, cfg.PreviewsNamed, err = decodeScriptSection(md2, raw.Previews, "previews",
		func(p *PreviewScript) *string { return &p.Name })
	if err != nil {
		return cfg, errtrace.Wrap(err)
	}
	cfg.Services, cfg.ServicesNamed, err = decodeScriptSection(md2, raw.Services, "services",
		func(s *ServiceScript) *string { return &s.Name })
	if err != nil {
		return cfg, errtrace.Wrap(err)
	}
	cfg.Tests, cfg.TestsNamed, err = decodeScriptSection(md2, raw.Tests, "tests",
		func(t *TestScript) *string { return &t.Name })
	if err != nil {
		return cfg, errtrace.Wrap(err)
	}
	// Both upgrades run once every script section is decoded, and in this order:
	// the command->script fold first, so upgradeServerArtifacts only ever has to
	// carry the current spelling across into a PreviewScript.
	upgradeCommandKeys(&cfg)
	upgradeServerArtifacts(&cfg)
	cfg.Icon = raw.Icon
	cfg.ResumePrompt = raw.ResumePrompt
	cfg.ArtifactConcurrency = raw.ArtifactConcurrency
	cfg.ArtifactPrefetch = raw.ArtifactPrefetch
	cfg.TestConcurrency = raw.TestConcurrency
	cfg.TestPrefetch = raw.TestPrefetch
	cfg.PreviewPorts = raw.PreviewPorts
	cfg.Review = raw.Review
	cfg.Notify = raw.Notify
	cfg.Jira = raw.Jira
	cfg.Resources = raw.Resources
	if err := cfg.Review.Validate(); err != nil {
		return cfg, errtrace.Wrap(err)
	}
	if err := cfg.Jira.Validate(); err != nil {
		return cfg, errtrace.Wrap(err)
	}

	// Defaults: legacy [defaults] first, then the new top-level fields win.
	if raw.Defaults != nil {
		cfg.Defaults = *raw.Defaults
	}
	if raw.PrePrompt != nil {
		cfg.Defaults.PrePrompt = raw.PrePrompt
	}
	if raw.Sandbox != nil {
		cfg.Defaults.Sandbox = raw.Sandbox
	}
	if raw.Policy != nil {
		cfg.Defaults.Policy = raw.Policy
	}

	// Agents: legacy [agents.*] map, then every non-reserved top-level table.
	if raw.Agents != nil {
		cfg.Agents = raw.Agents
	}
	for name := range prims {
		if reservedTopLevel[name] {
			continue
		}
		var ac AgentConfig
		if err := md.PrimitiveDecode(prims[name], &ac); err != nil {
			return cfg, errtrace.Wrap(fmt.Errorf("decode agent %q: %w", name, err))
		}
		if cfg.Agents == nil {
			cfg.Agents = make(map[string]AgentConfig)
		}
		cfg.Agents[name] = ac
	}
	if err := cfg.validateInheritedEnv(); err != nil {
		return cfg, errtrace.Wrap(err)
	}

	return cfg, nil
}

// configCache memoises decoded config files keyed by (path, mtime, size), so the
// many per-operation LoadFile calls (every head spawn/resume and HTTP request
// re-reads config - there is no long-lived Config anywhere) don't re-parse an
// unchanged file. It is a cache, not a source of truth: any change to the file's
// mtime or size invalidates the entry, so an on-disk edit is always picked up on the
// next read - which is how a saved config "auto-applies" to the next operation. It
// does NOT retroactively re-apply to already-running heads (their sandbox/egress/gate
// are fixed at launch); that would need live re-injection, which the daemon only does
// for [[services]] today.
var configCache = struct {
	sync.Mutex
	m map[string]configCacheEntry
}{m: map[string]configCacheEntry{}}

type configCacheEntry struct {
	mtime time.Time
	size  int64
	cfg   *Config
}

// LoadFile loads a configuration from a file. A missing file yields (nil, nil).
// Results are memoised by mtime+size (see configCache) and every caller gets an
// independent deep copy, so a consumer that mutates the returned config (e.g. to add
// an allow-listed host before saving) can never corrupt the cache or another caller.
func LoadFile(path string) (*Config, error) {
	if fi, err := os.Stat(path); err == nil && !fi.IsDir() {
		configCache.Lock()
		if e, ok := configCache.m[path]; ok && e.mtime.Equal(fi.ModTime()) && e.size == fi.Size() {
			cfg := cloneConfig(e.cfg)
			configCache.Unlock()
			return cfg, nil
		}
		configCache.Unlock()
	}

	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	cfg, err := decodeConfig(data)
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("load config: %s: %w", path, err))
	}
	// Re-stat so the cached mtime/size match the bytes we actually decoded (a
	// concurrent write between the read and here just misses the cache next time).
	if fi, err := os.Stat(path); err == nil && !fi.IsDir() {
		configCache.Lock()
		configCache.m[path] = configCacheEntry{mtime: fi.ModTime(), size: fi.Size(), cfg: cloneConfig(&cfg)}
		configCache.Unlock()
	}
	return cloneConfig(&cfg), nil
}

// cloneConfig returns a deep copy of c. Config is plain data (primitives, pointers
// to primitives, slices, maps and nested structs of the same), so a JSON round-trip
// is a correct and maintenance-free deep copy - new fields are covered automatically.
// It is used at the cache boundary so a cached config is never shared (and thus never
// mutated) across callers. A nil input clones to nil.
func cloneConfig(c *Config) *Config {
	if c == nil {
		return nil
	}
	data, err := json.Marshal(c)
	if err != nil {
		// Config has no un-marshalable fields; if that ever changes, fall back to a
		// shallow copy rather than returning the shared pointer.
		cp := *c
		return &cp
	}
	var out Config
	if err := json.Unmarshal(data, &out); err != nil {
		cp := *c
		return &cp
	}
	return &out
}

// Merge merges another configuration into this one.
func (c *Config) Merge(other Config) {
	c.Defaults.Merge(other.Defaults)

	if other.Agents != nil {
		if c.Agents == nil {
			c.Agents = make(map[string]AgentConfig)
		}
		for name, otherAgent := range other.Agents {
			agent := c.Agents[name]
			agent.Merge(otherAgent)
			c.Agents[name] = agent
		}
	}

	// Artifact/service/test scripts: the overriding file's SYNTAX selects the
	// behavior (see the Named fields on Config). The canonical named-table form
	// ([tests.go]) merges by name into the inherited list; the legacy array form
	// ([[tests]]) replaces it wholesale.
	if other.Artifacts != nil {
		arts := other.Artifacts
		if other.ArtifactsNamed {
			// An [artifacts.<name>] patch aimed at a name this config already knows
			// as a PREVIEW is redirected there. Only the layer that defines a
			// preview needs to spell it type = "server" / [previews.<name>]; a
			// later layer flipping one field (the config.local.toml `enabled =
			// false` kill-switch) has always been written without a type, so it
			// would otherwise land in the artifacts list and quietly do nothing.
			arts = arts[:0:0]
			var redirected []PreviewScript
			for _, a := range other.Artifacts {
				if a.Name != "" && a.Type == "" && c.hasPreview(a.Name) {
					redirected = append(redirected, previewFromArtifact(a))
					continue
				}
				arts = append(arts, a)
			}
			if len(redirected) > 0 {
				c.Previews = mergeByName(c.Previews, redirected,
					func(p PreviewScript) string { return p.Name }, patchPreviewScript)
			}
			c.Artifacts = mergeByName(c.Artifacts, arts,
				func(a ArtifactScript) string { return a.Name }, patchArtifactScript)
		} else {
			c.Artifacts = arts
		}
	}
	if other.Previews != nil {
		if other.PreviewsNamed {
			c.Previews = mergeByName(c.Previews, other.Previews,
				func(p PreviewScript) string { return p.Name }, patchPreviewScript)
		} else {
			c.Previews = other.Previews
		}
	}
	if other.Services != nil {
		if other.ServicesNamed {
			c.Services = mergeByName(c.Services, other.Services,
				func(s ServiceScript) string { return s.Name }, patchServiceScript)
		} else {
			c.Services = other.Services
		}
	}
	if other.Tests != nil {
		if other.TestsNamed {
			c.Tests = mergeByName(c.Tests, other.Tests,
				func(t TestScript) string { return t.Name }, patchTestScript)
		} else {
			c.Tests = other.Tests
		}
	}
	// Test concurrency is overridden only when the other config sets it (non-nil).
	if other.TestConcurrency != nil {
		c.TestConcurrency = other.TestConcurrency
	}
	// Test prefetch toggle: overridden only when the other config sets it (non-nil);
	// a nil pointer means "unset", so it inherits.
	if other.TestPrefetch != nil {
		c.TestPrefetch = other.TestPrefetch
	}
	// Artifact concurrency is overridden only when the other config sets it
	// (non-nil); a nil pointer means "unset", so it inherits. 0 is a real value
	// here (unlimited), distinct from unset.
	if other.ArtifactConcurrency != nil {
		c.ArtifactConcurrency = other.ArtifactConcurrency
	}
	// Preview port range is overridden only when the other config sets it (non-nil).
	if other.PreviewPorts != nil {
		c.PreviewPorts = other.PreviewPorts
	}
	// Artifact prefetch toggle: overridden only when the other config sets it
	// (non-nil); a nil pointer means "unset", so it inherits.
	if other.ArtifactPrefetch != nil {
		c.ArtifactPrefetch = other.ArtifactPrefetch
	}
	// Review/Jira sections merge field-by-field (their own nil-means-default
	// convention), so a later layer overriding one field leaves the rest intact.
	if other.Review != nil {
		if c.Review == nil {
			c.Review = &ReviewConfig{}
		}
		c.Review.Merge(*other.Review)
	}
	if other.Jira != nil {
		if c.Jira == nil {
			c.Jira = &JiraConfig{}
		}
		c.Jira.Merge(*other.Jira)
	}
	if other.Notify != nil {
		if c.Notify == nil {
			c.Notify = &NotifyConfig{}
		}
		if other.Notify.TestFailures != nil {
			c.Notify.TestFailures = other.Notify.TestFailures
		}
	}
	// Resources merges field-by-field (its own nil-means-default convention), so a
	// later layer overriding one limit leaves the rest inherited.
	if other.Resources != nil {
		if c.Resources == nil {
			c.Resources = &ResourceLimits{}
		}
		c.Resources.Merge(*other.Resources)
	}
}

// clone returns a deep-enough copy of the AgentConfig that Merge can mutate it
// without touching the original's nested Sandbox/Network/Policy structs. (Merge
// replaces the PreSpawnScript pointer wholesale and joins PrePrompt into a
// freshly allocated string, so only the Sandbox, Network and Policy structs need
// fresh copies.)
func (a AgentConfig) clone() AgentConfig {
	out := a
	if a.Sandbox != nil {
		sb := *a.Sandbox
		if a.Sandbox.Network != nil {
			n := *a.Sandbox.Network
			sb.Network = &n
		}
		out.Sandbox = &sb
	}
	if a.Policy != nil {
		p := *a.Policy
		out.Policy = &p
	}
	return out
}

// Merge merges another AgentConfig into this one.
func (a *AgentConfig) Merge(other AgentConfig) {
	if other.Sandbox != nil {
		if a.Sandbox == nil {
			a.Sandbox = &SandboxConfig{}
		}
		a.Sandbox.Merge(*other.Sandbox)
	}
	if other.Policy != nil {
		if a.Policy == nil {
			a.Policy = &PolicyConfig{}
		}
		a.Policy.Merge(*other.Policy)
	}
	// Pre-prompts UNION across config layers (user -> project -> local) like the
	// sandbox path lists, joined by a blank line, so a project adding its own
	// rules doesn't silently drop the user's machine-wide ones. An identical
	// value is not doubled; a nil or empty value inherits (there is no way to
	// clear an inherited pre-prompt from a later layer, matching list semantics).
	// This is the layer axis only - the defaults -> per-agent axis is combined
	// separately at spawn time (BuildFinalPrePrompt).
	if other.PrePrompt != nil && *other.PrePrompt != "" {
		if a.PrePrompt == nil || *a.PrePrompt == "" {
			a.PrePrompt = other.PrePrompt
		} else if *a.PrePrompt != *other.PrePrompt {
			joined := *a.PrePrompt + "\n\n" + *other.PrePrompt
			a.PrePrompt = &joined
		}
	}
	if other.Fullscreen != nil {
		a.Fullscreen = other.Fullscreen
	}
}

// Merge merges another SandboxConfig into this one. The path lists UNION across
// config layers (internal defaults -> user -> project -> per-agent) rather than
// replacing, mirroring the network host lists (see unionStrings): a project's
// writable_paths adds to whatever the user config declared instead of shadowing
// it, so machine-wide caches in ~/.config/hydra/config.toml apply everywhere.
// You cannot subtract a path this way (masks already can't be un-masked, and a
// writable default can't be dropped); narrowing is not a goal here. nil leaves
// the existing value.
func (s *SandboxConfig) Merge(other SandboxConfig) {
	if other.WritablePaths != nil {
		s.WritablePaths = unionStrings(s.WritablePaths, other.WritablePaths)
	}
	if other.MaskedPaths != nil {
		s.MaskedPaths = unionStrings(s.MaskedPaths, other.MaskedPaths)
	}
	if other.RestoreRO != nil {
		s.RestoreRO = unionStrings(s.RestoreRO, other.RestoreRO)
	}
	if other.CowPaths != nil {
		s.CowPaths = unionStrings(s.CowPaths, other.CowPaths)
	}
	if other.InheritEnv != nil {
		s.InheritEnv = unionStrings(s.InheritEnv, other.InheritEnv)
	}
	if other.Network != nil {
		if s.Network == nil {
			s.Network = &NetworkConfig{}
		}
		if other.Network.Mode != nil {
			s.Network.Mode = other.Network.Mode
		}
		if other.Network.Enabled != nil {
			s.Network.Enabled = other.Network.Enabled
		}
		if other.Network.FilterEnabled != nil {
			s.Network.FilterEnabled = other.Network.FilterEnabled
		}
		// Host lists UNION across layers (internal defaults → user → project →
		// per-agent) rather than replacing: a per-agent [<agent>.sandbox.network]
		// adds to the shared [sandbox.network] list instead of shadowing it, which is
		// the intuitive model for an allow-list and avoids a per-agent override
		// silently dropping the broader set. Narrowing is done via BlockedHosts (which
		// overrides the allow-list), not by shrinking AllowedHosts. unionHosts always
		// returns a fresh slice, so it never mutates the shared backing array that
		// clone() leaves aliased on s.Network.
		if other.Network.AllowedHosts != nil {
			s.Network.AllowedHosts = unionStrings(s.Network.AllowedHosts, other.Network.AllowedHosts)
		}
		if other.Network.BlockedHosts != nil {
			s.Network.BlockedHosts = unionStrings(s.Network.BlockedHosts, other.Network.BlockedHosts)
		}
		if other.Network.AllowedLoopbackPorts != nil {
			s.Network.AllowedLoopbackPorts = unionPorts(s.Network.AllowedLoopbackPorts, other.Network.AllowedLoopbackPorts)
		}
	}
	if other.PreSpawnScript != nil {
		s.PreSpawnScript = other.PreSpawnScript
	}
	if other.PreExitScript != nil {
		s.PreExitScript = other.PreExitScript
	}
}

// unionStrings returns a fresh slice containing the elements of a followed by any
// elements of b not already present, preserving order and dropping duplicates. It
// never aliases or mutates either input, so it is safe to use on the shallowly
// cloned slices that AgentConfig.clone leaves sharing a backing array. Used for
// the network host/block lists and the sandbox path lists, which all union across
// config layers rather than replacing.
func unionStrings(a, b []string) []string {
	out := make([]string, 0, len(a)+len(b))
	seen := make(map[string]bool, len(a)+len(b))
	for _, list := range [][]string{a, b} {
		for _, v := range list {
			if !seen[v] {
				seen[v] = true
				out = append(out, v)
			}
		}
	}
	return out
}

// decodeScriptSection decodes one of the artifacts/services/tests sections,
// which accepts two shapes:
//
//   - named tables (canonical): [tests.go] / [artifacts."web shots"] - the
//     table key is the entry's name, and named entries MERGE by name across
//     config layers (see Config.Merge). An explicit name field inside the
//     table overrides the key (tolerated for copy-pasted entries, and used by
//     the renderer to keep duplicate names representable).
//   - the legacy array-of-tables: [[tests]] with a name field - kept parseable
//     forever (old commits' config.toml are read at-ref), replacing the
//     inherited list wholesale as it always has.
//
// Entries are returned in document order (via the decode metadata's ordered
// key list); named reports which shape was used.
func decodeScriptSection[T any](md toml.MetaData, prim toml.Primitive, section string, name func(*T) *string) ([]T, bool, error) {
	if !md.IsDefined(section) {
		return nil, false, nil
	}
	var arr []T
	if err := md.PrimitiveDecode(prim, &arr); err == nil {
		return arr, false, nil
	}
	var m map[string]toml.Primitive
	if err := md.PrimitiveDecode(prim, &m); err != nil {
		return nil, false, errtrace.Wrap(fmt.Errorf("decode [%s]: neither [[%s]] entries nor [%s.<name>] tables: %w", section, section, section, err))
	}
	var out []T
	for _, k := range md.Keys() {
		if len(k) != 2 || k[0] != section {
			continue
		}
		p, ok := m[k[1]]
		if !ok {
			continue
		}
		var t T
		if err := md.PrimitiveDecode(p, &t); err != nil {
			return nil, false, errtrace.Wrap(fmt.Errorf("decode [%s.%s]: %w", section, k[1], err))
		}
		if n := name(&t); *n == "" {
			*n = k[1]
		}
		out = append(out, t)
	}
	return out, true, nil
}

// mergeByName merges override entries into base by name - the layering rule
// for the named-table script sections ([tests.go] etc.): an override entry
// whose name matches a base entry patches it in place (see the patch functions
// below), an unmatched (or unnamed) one appends. Base order is preserved; new
// entries append in their own order. Always returns a fresh slice.
func mergeByName[T any](base, over []T, name func(T) string, patch func(T, T) T) []T {
	out := make([]T, len(base))
	copy(out, base)
	idx := make(map[string]int, len(out))
	for i, b := range out {
		idx[name(b)] = i
	}
	for _, o := range over {
		if i, ok := idx[name(o)]; ok && name(o) != "" {
			out[i] = patch(out[i], o)
		} else {
			out = append(out, o)
			idx[name(o)] = len(out) - 1
		}
	}
	return out
}

// patchArtifactScript overlays the set fields of o onto b: strings override
// when non-empty, ints when positive, plain bools when true, pointers when
// non-nil. Zero values inherit - so a config.local.toml entry can flip one
// field (enabled = false) without restating the command. The flip side: a
// patch cannot reset a field back to its zero value; restate it in the layer
// that owns the entry for that.
func patchArtifactScript(b, o ArtifactScript) ArtifactScript {
	if o.Script != "" {
		b.Script = o.Script
	}
	if o.TimeoutSec > 0 {
		b.TimeoutSec = o.TimeoutSec
	}
	if o.UnsafeHost {
		b.UnsafeHost = true
	}
	if o.CleanIgnored {
		b.CleanIgnored = true
	}
	if o.AutoRun != "" {
		b.AutoRun = o.AutoRun
	}
	if o.Enabled != nil {
		b.Enabled = o.Enabled
	}
	if o.Strict != nil {
		b.Strict = o.Strict
	}
	if o.Type != "" {
		b.Type = o.Type
	}
	if o.IdleTimeoutSec > 0 {
		b.IdleTimeoutSec = o.IdleTimeoutSec
	}
	if o.ReadyTimeoutSec > 0 {
		b.ReadyTimeoutSec = o.ReadyTimeoutSec
	}
	return b
}

// hasPreview reports whether a preview of this name is already known to the
// config, used by Merge to redirect a typeless [artifacts.<name>] patch to the
// preview it is really aiming at.
func (c *Config) hasPreview(name string) bool {
	for _, p := range c.Previews {
		if p.Name == name {
			return true
		}
	}
	return false
}

// patchPreviewScript is patchArtifactScript for [previews.<name>] entries.
func patchPreviewScript(b, o PreviewScript) PreviewScript {
	if o.Script != "" {
		b.Script = o.Script
	}
	if o.UnsafeHost {
		b.UnsafeHost = true
	}
	if o.Enabled != nil {
		b.Enabled = o.Enabled
	}
	if o.Strict != nil {
		b.Strict = o.Strict
	}
	if o.IdleTimeoutSec > 0 {
		b.IdleTimeoutSec = o.IdleTimeoutSec
	}
	if o.ReadyTimeoutSec > 0 {
		b.ReadyTimeoutSec = o.ReadyTimeoutSec
	}
	return b
}

// patchServiceScript is patchArtifactScript for [[services]] entries.
func patchServiceScript(b, o ServiceScript) ServiceScript {
	if o.Script != "" {
		b.Script = o.Script
	}
	if o.Host {
		b.Host = true
	}
	if o.MaxRestarts != nil {
		b.MaxRestarts = o.MaxRestarts
	}
	if o.Enabled != nil {
		b.Enabled = o.Enabled
	}
	if o.Strict != nil {
		b.Strict = o.Strict
	}
	return b
}

// patchTestScript is patchArtifactScript for [[tests]] entries.
func patchTestScript(b, o TestScript) TestScript {
	if o.Script != "" {
		b.Script = o.Script
	}
	if o.TimeoutSec > 0 {
		b.TimeoutSec = o.TimeoutSec
	}
	if o.UnsafeHost {
		b.UnsafeHost = true
	}
	if o.CleanIgnored {
		b.CleanIgnored = true
	}
	if o.AutoRun != "" {
		b.AutoRun = o.AutoRun
	}
	if o.Enabled != nil {
		b.Enabled = o.Enabled
	}
	if o.Strict != nil {
		b.Strict = o.Strict
	}
	if o.Type != "" {
		b.Type = o.Type
	}
	return b
}

// unionPorts is unionHosts for the loopback-port allow-list: fresh slice,
// order-preserving, duplicate-dropping, never aliasing either input.
func unionPorts(a, b []int) []int {
	out := make([]int, 0, len(a)+len(b))
	seen := make(map[int]bool, len(a)+len(b))
	for _, list := range [][]int{a, b} {
		for _, v := range list {
			if !seen[v] {
				seen[v] = true
				out = append(out, v)
			}
		}
	}
	return out
}

// Load loads the merged configuration for a project.
func Load(projectRoot string) (Config, error) {
	cfg := LoadInternalDefaults()

	// 1. User config
	userPath, err := GetUserConfigPath()
	if err == nil {
		userCfg, err := LoadFile(userPath)
		if err == nil && userCfg != nil {
			cfg.Merge(*userCfg)
		}
	}

	// 2. Project config
	if projectRoot != "" {
		projectPath := GetProjectConfigPath(projectRoot)
		projectCfg, err := LoadFile(projectPath)
		if err != nil {
			return Config{}, errtrace.Wrap(err)
		}
		if projectCfg != nil {
			cfg.Merge(*projectCfg)
		}

		// 3. Project-local override (.hydra/config.local.toml): untracked, non-secret,
		// per-user-per-project. Same schema and union/last-wins merge semantics as the
		// committed project config, applied last so it wins (docs/non-local-integration.md
		// 3.1). Absent file is not an error.
		localCfg, err := LoadFile(paths.GetProjectConfigLocalPath(projectRoot))
		if err != nil {
			return Config{}, errtrace.Wrap(err)
		}
		if localCfg != nil {
			cfg.Merge(*localCfg)
		}
	}

	return cfg, nil
}

// ArtifactsAtProjectTOML resolves the [[artifacts]] scripts that apply when the
// project's .hydra/config.toml holds the given content. It mirrors Load's merge
// order (internal defaults, then user config, then project), so it can be used
// to load the artifact scripts exactly as they existed at a specific git ref by
// passing that ref's config.toml content (an empty/absent file inherits the user
// config's artifacts, just like the live path). Project config that fails to
// parse returns an error.
func ArtifactsAtProjectTOML(content []byte) ([]ArtifactScript, error) {
	cfg := LoadInternalDefaults()

	// User config (best-effort, matching Load).
	if userPath, err := GetUserConfigPath(); err == nil {
		if userCfg, err := LoadFile(userPath); err == nil && userCfg != nil {
			cfg.Merge(*userCfg)
		}
	}

	projectCfg, err := decodeConfig(content)
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("parse project config: %w", err))
	}
	cfg.Merge(projectCfg)

	return cfg.Artifacts, nil
}

// PreviewsAtProjectTOML resolves the [previews.<name>] scripts that apply when
// the project's .hydra/config.toml holds the given content, mirroring Load's
// merge order exactly as ArtifactsAtProjectTOML does for artifacts. A ref whose
// config still spells its previews as [artifacts.<name>] with type = "server"
// resolves identically - decodeConfig upgrades them on the way through.
func PreviewsAtProjectTOML(content []byte) ([]PreviewScript, error) {
	cfg := LoadInternalDefaults()

	// User config (best-effort, matching Load).
	if userPath, err := GetUserConfigPath(); err == nil {
		if userCfg, err := LoadFile(userPath); err == nil && userCfg != nil {
			cfg.Merge(*userCfg)
		}
	}

	projectCfg, err := decodeConfig(content)
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("parse project config: %w", err))
	}
	cfg.Merge(projectCfg)

	return cfg.Previews, nil
}

// TestsAtProjectTOML resolves the [[tests]] scripts that apply when the project's
// .hydra/config.toml holds the given content, mirroring Load's merge order (and
// ArtifactsAtProjectTOML). Like artifacts, [[tests]] are read from the diffed ref's
// own config so a branch's edits take effect on that branch; the security-sensitive
// bits (unsafe_host, and a live kill-switch) stay gated by the trusted root config
// at the call site (see internal/http testRunnersFor).
func TestsAtProjectTOML(content []byte) ([]TestScript, error) {
	cfg := LoadInternalDefaults()
	if userPath, err := GetUserConfigPath(); err == nil {
		if userCfg, err := LoadFile(userPath); err == nil && userCfg != nil {
			cfg.Merge(*userCfg)
		}
	}
	projectCfg, err := decodeConfig(content)
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("parse project config: %w", err))
	}
	cfg.Merge(projectCfg)
	return cfg.Tests, nil
}

// GetResolvedConfig returns the fully resolved AgentConfig for a specific agent type.
func (c Config) GetResolvedConfig(agentType string) AgentConfig {
	resolved := c.Defaults.clone()

	if agentCfg, ok := c.Agents[agentType]; ok {
		resolved.Merge(agentCfg)
	}

	return resolved
}

// ResolveSandboxOptions merges the baked-in sandbox defaults with the resolved
// per-agent config into concrete path lists + network policy. User config is
// additive for the path lists.
func (c Config) ResolveSandboxOptions(agentType string) (writable, masked, restore, cow []string, net sandbox.NetworkPolicy, preSpawn string) {
	def := sandbox.Defaults()
	writable = append([]string{}, def.WritablePaths...)
	masked = append([]string{}, def.MaskedPaths...)
	restore = append([]string{}, def.RestoreRO...)
	resolved := c.GetResolvedConfig(agentType)
	var nc *NetworkConfig
	if sb := resolved.Sandbox; sb != nil {
		writable = append(writable, sb.WritablePaths...)
		masked = append(masked, sb.MaskedPaths...)
		restore = append(restore, sb.RestoreRO...)
		cow = append(cow, sb.CowPaths...)
		nc = sb.Network
		if sb.PreSpawnScript != nil {
			preSpawn = *sb.PreSpawnScript
		}
	}
	net = resolveNetworkPolicy(nc)
	return writable, masked, restore, cow, net, preSpawn
}

// ResolveInheritedEnv returns the daemon environment-variable names explicitly
// opted into a head, merged from the defaults and per-agent sandbox config.
// Built-in baseline and provider-auth variables are added by heads.agentEnv.
func (c Config) ResolveInheritedEnv(agentType string) []string {
	resolved := c.GetResolvedConfig(agentType)
	if resolved.Sandbox == nil {
		return nil
	}
	return append([]string(nil), resolved.Sandbox.InheritEnv...)
}

// resolveNetworkPolicy turns the (possibly nil) config into the effective
// sandbox.NetworkPolicy. The explicit `mode` is authoritative when set; otherwise
// it falls back to the legacy enabled/filter_enabled booleans, and when NOTHING is
// specified it defaults to hard (network on, deny-by-default filtering behind the
// inescapable pasta+nft boundary, failing closed where that can't be built).
func resolveNetworkPolicy(nc *NetworkConfig) sandbox.NetworkPolicy {
	net := sandbox.NetworkPolicy{Mode: sandbox.NetHard, Enabled: true, FilterHosts: true}
	if nc == nil {
		return net
	}
	net.AllowedHosts = nc.AllowedHosts
	net.BlockedHosts = nc.BlockedHosts
	net.AllowedLoopbackPorts = nc.AllowedLoopbackPorts

	switch {
	case nc.Mode != nil && *nc.Mode != "":
		// Explicit mode wins. "on" is an accepted synonym for "hard".
		net.Mode = sandbox.NormalizeNetworkMode(*nc.Mode)
	case nc.Enabled != nil || nc.FilterEnabled != nil:
		// Legacy booleans: derive a mode so downstream only reasons about Mode.
		enabled := nc.Enabled == nil || *nc.Enabled
		filter := len(nc.AllowedHosts) > 0
		if nc.FilterEnabled != nil {
			filter = *nc.FilterEnabled
		}
		switch {
		case !enabled:
			net.Mode = sandbox.NetOff
		case !filter:
			net.Mode = sandbox.NetUnrestricted
		default:
			net.Mode = sandbox.NetHard
		}
	}

	// Derive the convenience booleans from the mode so the sandbox builder and
	// egress setup can key off either.
	switch net.Mode {
	case sandbox.NetOff:
		net.Enabled, net.FilterHosts = false, false
	case sandbox.NetUnrestricted:
		net.Enabled, net.FilterHosts = true, false
	default: // advisory | hard
		net.Enabled, net.FilterHosts = true, true
	}
	return net
}

// ResolvePolicy returns the effective security-gate policy for an agent type:
// the defaults-level [policy] merged with the per-agent [<agent>.policy] override.
// The gate hook reads this from the trusted project-root config (never the
// branch's worktree copy); gate_enabled defaults to true when unset.
func (c Config) ResolvePolicy(agentType string) PolicyConfig {
	resolved := c.GetResolvedConfig(agentType)
	if resolved.Policy != nil {
		return *resolved.Policy
	}
	return PolicyConfig{}
}

// ResolveFullscreen reports whether Claude Code's fullscreen (alternate-screen)
// rendering should be enabled for an agent type. It defaults to false: with
// fullscreen off Hydra forces the classic renderer, which keeps the web
// terminal's native scrollbar and select-to-copy working and avoids the one-time
// opt-in prompt that collides with the resume "Continue" nudge. The setting is
// accepted ONLY under [claude] - not at the defaults level or under any other
// agent - so it is read straight from the claude table rather than the resolved
// (defaults-merged) config.
func (c Config) ResolveFullscreen(agentType string) bool {
	if agentType != string(sandbox.AgentTypeClaude) {
		return false
	}
	a, ok := c.Agents[string(sandbox.AgentTypeClaude)]
	return ok && a.Fullscreen != nil && *a.Fullscreen
}

// ResolvePreExitScript returns the sandboxed pre-exit teardown script for an
// agent type (the per-agent override, else the defaults), or "" when unset.
func (c Config) ResolvePreExitScript(agentType string) string {
	resolved := c.GetResolvedConfig(agentType)
	if sb := resolved.Sandbox; sb != nil && sb.PreExitScript != nil {
		return *sb.PreExitScript
	}
	return ""
}

// Save saves a configuration to the project-specific configuration file.
func Save(projectRoot string, cfg Config) error {
	return errtrace.Wrap(SaveToFile(GetProjectConfigPath(projectRoot), cfg))
}

// SaveToFile saves a configuration to the given file path. It reads any
// existing file first and renders on top of it, so hand-written comments and
// unmanaged content (e.g. [[artifacts]] blocks) survive the round-trip and a
// legacy-format file is migrated to the new flattened layout.
func SaveToFile(path string, cfg Config) error {
	if err := cfg.validateInheritedEnv(); err != nil {
		return errtrace.Wrap(err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return errtrace.Wrap(fmt.Errorf("create config parent: %s: %w", path, err))
	}
	existing, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return errtrace.Wrap(fmt.Errorf("read existing config: %s: %w", path, err))
	}
	content := renderConfig(existing, cfg)
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		return errtrace.Wrap(fmt.Errorf("save config: %s: %w", path, err))
	}
	return nil
}

// tomlStringValue returns the TOML value representation of a string.
// Multi-line strings prefer the triple-apostrophe ”' literal syntax, which
// needs no escaping, and fall back to triple-quoted """ basic strings only when
// the content cannot be represented literally (see canUseTomlLiteral).
func tomlStringValue(s string) string {
	if strings.Contains(s, "\n") {
		if canUseTomlLiteral(s) {
			return "'''" + "\n" + s + "'''"
		}
		escaped := strings.ReplaceAll(s, `\`, `\\`)
		escaped = strings.ReplaceAll(escaped, `"""`, `\"\"\"`)
		return `"""` + "\n" + escaped + `"""`
	}
	escaped := strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(s)
	return `"` + escaped + `"`
}

// canUseTomlLiteral reports whether s can be encoded as a multi-line literal
// (”') TOML string. Literal strings interpret content verbatim with no escape
// mechanism, so they cannot represent: a run of three apostrophes (that would be
// read as the closing delimiter), a trailing apostrophe (adjacent to the closing
// ”' it becomes an ambiguous four-apostrophe run), or control characters other
// than tab and newline. Such strings fall back to the escaping """ form.
func canUseTomlLiteral(s string) bool {
	if strings.Contains(s, "'''") || strings.HasSuffix(s, "'") {
		return false
	}
	for _, r := range s {
		if r == '\t' || r == '\n' {
			continue
		}
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}

// tomlStringArray renders a string slice as a TOML inline array.
func tomlStringArray(vals []string) string {
	parts := make([]string, len(vals))
	for i, v := range vals {
		parts[i] = tomlStringValue(v)
	}
	return "[" + strings.Join(parts, ", ") + "]"
}

// tomlIntArray renders an int slice as a TOML inline array.
func tomlIntArray(vals []int) string {
	parts := make([]string, len(vals))
	for i, v := range vals {
		parts[i] = strconv.Itoa(v)
	}
	return "[" + strings.Join(parts, ", ") + "]"
}

// docPrefix marks Hydra-generated documentation comment lines. Using a distinct
// prefix ("##" - a doubled comment marker, rendered above each setting) lets the
// renderer recognise and replace its own docs on every save - so they update when
// Hydra updates - while leaving the user's own single-"#" comments untouched.
const docPrefix = "##"

// legacyDocPrefixes are the earlier docPrefix spellings ("# :" then "#:"). They
// are still recognised when reading so older files have their doc lines replaced
// (not duplicated) on the next render.
var legacyDocPrefixes = []string{"# :", "#:"}

// specEntry describes one managed default setting for the self-documenting
// writer. The set of entries is the single source of truth for which default
// settings exist, their order, their documentation, and the commented-out
// default shown when they are unset.
type specEntry struct {
	table string // "" (root), "sandbox", or "sandbox.network"
	key   string
	doc   string        // one-line documentation (no leading marker)
	def   func() string // TOML value text shown commented-out when unset
	// get returns the TOML value text and whether the setting is set in cfg.
	get func(AgentConfig) (string, bool)
}

// sandboxSlice builds a get func for a []string sandbox field.
func sandboxSlice(pick func(*SandboxConfig) []string) func(AgentConfig) (string, bool) {
	return func(a AgentConfig) (string, bool) {
		if a.Sandbox == nil {
			return "", false
		}
		v := pick(a.Sandbox)
		if len(v) == 0 {
			return "", false
		}
		return tomlStringArray(v), true
	}
}

// policySlice builds a get func for a []string policy field.
func policySlice(pick func(*PolicyConfig) []string) func(AgentConfig) (string, bool) {
	return func(a AgentConfig) (string, bool) {
		if a.Policy == nil {
			return "", false
		}
		v := pick(a.Policy)
		if len(v) == 0 {
			return "", false
		}
		return tomlStringArray(v), true
	}
}

// allowedHostsDoc builds the documentation for the allowed_hosts setting. It
// enumerates the built-in default allow-list - the hosts already reachable
// before the user adds anything - so the written config is self-explanatory. The
// host lists are sourced from the sandbox package (InfraAllowedHosts /
// ProviderHostGroups), the same source the egress boundary enforces, so what is
// documented can never drift from what is actually allowed.
func allowedHostsDoc() string {
	var b strings.Builder
	b.WriteString("extra outbound hosts (exact host or *.suffix) allowed when filtering is on,\n")
	b.WriteString("unioned on top of the built-in default allow-list below. Leaving this empty\n")
	b.WriteString("does NOT disable the defaults - to remove one, list it in blocked_hosts.\n")
	b.WriteString("Built-in defaults, always allowed regardless of agent (package registries,\n")
	b.WriteString("language toolchains, git hosts):")
	for _, line := range wrapHosts(sandbox.InfraAllowedHosts()) {
		b.WriteString("\n    ")
		b.WriteString(line)
	}
	b.WriteString("\nPlus the AI-provider hosts for the agent's own type (a bash or unknown agent\n")
	b.WriteString("gets the union of every provider's hosts):")
	for _, g := range sandbox.ProviderHostGroups() {
		b.WriteString("\n    ")
		b.WriteString(string(g.Type))
		b.WriteString(": ")
		for i, line := range wrapHosts(g.Hosts) {
			if i > 0 {
				b.WriteString("\n      ")
			}
			b.WriteString(line)
		}
	}
	return b.String()
}

// writablePathsDoc builds the documentation for the writable_paths setting,
// mirroring allowedHostsDoc: it enumerates the built-in default writable paths
// (already writable before the user adds anything) and lists the common
// ecosystem caches kept OUT of the defaults, so the written config is
// self-documenting and points at the per-project additions people usually want.
// Both lists are sourced from the sandbox package so the docs can't drift from
// the policy. Like the host lists, writable_paths unions across config layers
// (defaults, user config, project) - see SandboxConfig.Merge.
func writablePathsDoc() string {
	var b strings.Builder
	b.WriteString("extra paths made writable in the sandbox, unioned on top of the built-in\n")
	b.WriteString("defaults below AND across config layers (this list in ~/.config/hydra/\n")
	b.WriteString("config.toml applies to every project; a project's own list adds to it).\n")
	b.WriteString("A path can be ~ (HOME), absolute, or a $VAR. Secrets are hidden separately\n")
	b.WriteString("via masked_paths, so nothing here holds credentials.\n")
	b.WriteString("Built-in defaults, always writable (broad caches + toolchain + agent state):")
	for _, line := range wrapHosts(sandbox.Defaults().WritablePaths) {
		b.WriteString("\n    ")
		b.WriteString(line)
	}
	b.WriteString("\nCommon per-project additions (NOT writable by default - add the ones you use\n")
	b.WriteString("here, or to cow_paths for per-head copy-on-write isolation):")
	for _, s := range sandbox.SuggestedWritablePaths() {
		b.WriteString("\n    ")
		b.WriteString(s.Path)
		b.WriteString(" - ")
		b.WriteString(s.Purpose)
	}
	return b.String()
}

// wrapHosts groups host patterns into comma-separated lines of a readable width
// so an enumerated default list stays legible inside a doc comment.
func wrapHosts(hosts []string) []string {
	const width = 68
	var lines []string
	cur := ""
	for _, h := range hosts {
		switch {
		case cur == "":
			cur = h
		case len(cur)+2+len(h) > width:
			lines = append(lines, cur+",")
			cur = h
		default:
			cur += ", " + h
		}
	}
	if cur != "" {
		lines = append(lines, cur)
	}
	return lines
}

// defaultsSpec is the ordered, declarative description of the managed default
// settings. Root scalars come first because TOML requires root keys to precede
// any table header. Adding an entry here makes it appear (commented-out) on the
// next render of any existing file - the "intelligent update" behaviour.
func defaultsSpec() []specEntry {
	return []specEntry{
		{
			table: "", key: "pre_prompt",
			doc: "extra instructions appended to every agent's system prompt. Layers combine:\na user-config pre_prompt stays in force and a project's is appended after it.",
			def: func() string { return `""` },
			get: func(a AgentConfig) (string, bool) {
				if a.PrePrompt != nil {
					return tomlStringValue(*a.PrePrompt), true
				}
				return "", false
			},
		},
		{
			table: "sandbox", key: "writable_paths",
			doc: writablePathsDoc(),
			def: func() string { return tomlStringArray(sandbox.Defaults().WritablePaths) },
			get: sandboxSlice(func(s *SandboxConfig) []string { return s.WritablePaths }),
		},
		{
			table: "sandbox", key: "masked_paths",
			doc: "extra paths hidden in the sandbox (added to the built-in defaults).",
			def: func() string { return tomlStringArray(sandbox.Defaults().MaskedPaths) },
			get: sandboxSlice(func(s *SandboxConfig) []string { return s.MaskedPaths }),
		},
		{
			table: "sandbox", key: "restore_ro",
			doc: "paths re-exposed read-only after a masked parent (added to the built-in defaults).",
			def: func() string { return tomlStringArray(sandbox.Defaults().RestoreRO) },
			get: sandboxSlice(func(s *SandboxConfig) []string { return s.RestoreRO }),
		},
		{
			table: "sandbox", key: "cow_paths",
			doc: "paths mounted copy-on-write (read source, writes kept per-head): worktree-relative (mirrored from project root) or home/absolute like ~/.gradle (overlaid in place, supersedes its writable bind).",
			def: func() string { return "[]" },
			get: sandboxSlice(func(s *SandboxConfig) []string { return s.CowPaths }),
		},
		{
			table: "sandbox", key: "inherit_env",
			doc: "additional daemon environment variable names passed into heads (added across config layers). Heads otherwise receive only a fixed baseline plus authentication variables for their selected provider. Values are resolved at launch and never written to config or logs. Hydra-owned names, including every HYDRA_* variable, cannot be inherited.",
			def: func() string { return "[]" },
			get: sandboxSlice(func(s *SandboxConfig) []string { return s.InheritEnv }),
		},
		{
			table: "sandbox", key: "pre_spawn_script",
			doc: "shell script run in the sandbox before every agent launch - spawn and resume, so it must be idempotent (e.g. mise trust). To set environment variables for the agent, append `KEY=value` lines to the file at $HYDRA_ENV (e.g. `echo \"GRADLE_USER_HOME=/tmp/gradle-iso\" >> \"$HYDRA_ENV\"`); each is exported into the agent and every command it runs, overriding any inherited value (the GitHub Actions $GITHUB_ENV model). Those same vars are also injected into the head's sandboxed bash shells (the terminal '+' tabs) so a shell shares the agent's environment - the script is not re-run there; the non-sandboxed 'Regular shell' is left out. It also gets the HYDRA_* head-context vars (HYDRA_HEAD_ID, HYDRA_WORKTREE, ...).",
			def: func() string { return `""` },
			get: func(a AgentConfig) (string, bool) {
				if a.Sandbox != nil && a.Sandbox.PreSpawnScript != nil && *a.Sandbox.PreSpawnScript != "" {
					return tomlStringValue(*a.Sandbox.PreSpawnScript), true
				}
				return "", false
			},
		},
		{
			table: "sandbox", key: "pre_exit_script",
			doc: "shell script run in a sandbox when a head ends, before its worktree is removed - gets HYDRA_* + HYDRA_END_STATE; e.g. release a claimed resource.",
			def: func() string { return `""` },
			get: func(a AgentConfig) (string, bool) {
				if a.Sandbox != nil && a.Sandbox.PreExitScript != nil && *a.Sandbox.PreExitScript != "" {
					return tomlStringValue(*a.Sandbox.PreExitScript), true
				}
				return "", false
			},
		},
		{
			table: "sandbox.network", key: "mode",
			doc: `egress posture: "off" (no network), "unrestricted" (network, no host filtering), "advisory" (proxy-only host filtering - every honest client is filtered, but escapable), or "hard" (inescapable pasta+nft netns, failing closed - no network - when the boundary can't be built; "on" is a synonym for "hard"). Default "hard". Supersedes the legacy enabled/filter_enabled booleans.`,
			def: func() string { return `"hard"` },
			get: func(a AgentConfig) (string, bool) {
				if a.Sandbox != nil && a.Sandbox.Network != nil && a.Sandbox.Network.Mode != nil && *a.Sandbox.Network.Mode != "" {
					return tomlStringValue(*a.Sandbox.Network.Mode), true
				}
				return "", false
			},
		},
		{
			table: "sandbox.network", key: "enabled",
			doc: "LEGACY (use mode): allow outbound network access from the sandbox. Honoured only when mode is unset.",
			def: func() string { return "true" },
			get: func(a AgentConfig) (string, bool) {
				if a.Sandbox != nil && a.Sandbox.Network != nil && a.Sandbox.Network.Enabled != nil {
					return fmt.Sprintf("%t", *a.Sandbox.Network.Enabled), true
				}
				return "", false
			},
		},
		{
			table: "sandbox.network", key: "filter_enabled",
			doc: "LEGACY (use mode): enforce the allowed_hosts list (deny-by-default egress). Honoured only when mode is unset. Unset = on when allowed_hosts is non-empty; true = only allowed_hosts reachable; false = allow every host.",
			def: func() string { return "false" },
			get: func(a AgentConfig) (string, bool) {
				if a.Sandbox != nil && a.Sandbox.Network != nil && a.Sandbox.Network.FilterEnabled != nil {
					return fmt.Sprintf("%t", *a.Sandbox.Network.FilterEnabled), true
				}
				return "", false
			},
		},
		{
			table: "sandbox.network", key: "allowed_hosts",
			doc: allowedHostsDoc(),
			def: func() string { return "[]" },
			get: func(a AgentConfig) (string, bool) {
				if a.Sandbox != nil && a.Sandbox.Network != nil && len(a.Sandbox.Network.AllowedHosts) > 0 {
					return tomlStringArray(a.Sandbox.Network.AllowedHosts), true
				}
				return "", false
			},
		},
		{
			table: "sandbox.network", key: "blocked_hosts",
			doc: "outbound hosts (exact host or *.suffix) to deny even when otherwise allowed - overrides both allowed_hosts and the built-in defaults, so you can subtract a default host without redefining the list.",
			def: func() string { return "[]" },
			get: func(a AgentConfig) (string, bool) {
				if a.Sandbox != nil && a.Sandbox.Network != nil && len(a.Sandbox.Network.BlockedHosts) > 0 {
					return tomlStringArray(a.Sandbox.Network.BlockedHosts), true
				}
				return "", false
			},
		},
		{
			table: "sandbox.network", key: "allowed_loopback_ports",
			doc: `host-loopback TCP ports reachable from the sandbox even under mode = "hard" (whose netns otherwise cuts off the host's 127.0.0.1) - for host-local daemons that hardcode loopback, e.g. adb's server: [5037]. No effect in other modes (they share the host loopback already).`,
			def: func() string { return "[]" },
			get: func(a AgentConfig) (string, bool) {
				if a.Sandbox != nil && a.Sandbox.Network != nil && len(a.Sandbox.Network.AllowedLoopbackPorts) > 0 {
					return tomlIntArray(a.Sandbox.Network.AllowedLoopbackPorts), true
				}
				return "", false
			},
		},
		{
			table: "policy", key: "gate_enabled",
			doc: "enable the decision-capable gate that can deny tool calls (non-allow-listed MCP, credential reads, policy-file writes, global installs) even under skip-permissions (default true).",
			def: func() string { return "true" },
			get: func(a AgentConfig) (string, bool) {
				if a.Policy != nil && a.Policy.GateEnabled != nil {
					return fmt.Sprintf("%t", *a.Policy.GateEnabled), true
				}
				return "", false
			},
		},
		{
			table: "policy", key: "git_isolation",
			doc: `how much of the repo's shared .git the head may write: "readonly" (default) locks the whole .git read-only so commits go through the mcp__hydra__git_commit tool (anti-rogue); "off" leaves it writable. See docs/git-isolation.md.`,
			def: func() string { return `"readonly"` },
			get: func(a AgentConfig) (string, bool) {
				if a.Policy != nil && a.Policy.GitIsolation != nil {
					return strconv.Quote(*a.Policy.GitIsolation), true
				}
				return "", false
			},
		},
		{
			table: "policy", key: "mcp_allowed",
			doc: "MCP server names the agent may use (whole-server grant covers all its tools); any other server is stripped before launch and denied at runtime (default none).",
			def: func() string { return "[]" },
			get: policySlice(func(p *PolicyConfig) []string { return p.MCPAllowed }),
		},
		{
			table: "policy", key: "mcp_tools_allowed",
			doc: `individual MCP tools ("<server>__<tool>") allowed even when the whole server is not; the server is kept (spawned) so those tools work, other tools park for approval (default none).`,
			def: func() string { return "[]" },
			get: policySlice(func(p *PolicyConfig) []string { return p.MCPToolsAllowed }),
		},
		{
			table: "policy", key: "mcp_blocked",
			doc: "MCP server names refused outright: stripped before launch and every call DENIED at runtime (never parked for approval). Block overrides allow; since the allow-lists union across config layers, this is how a project or config.local.toml removes a server a broader layer granted (default none).",
			def: func() string { return "[]" },
			get: policySlice(func(p *PolicyConfig) []string { return p.MCPBlocked }),
		},
		{
			table: "policy", key: "mcp_tools_blocked",
			doc: `individual MCP tools ("<server>__<tool>") denied outright even when their server is allowed. Block overrides allow (default none).`,
			def: func() string { return "[]" },
			get: policySlice(func(p *PolicyConfig) []string { return p.MCPToolsBlocked }),
		},
		{
			table: "policy", key: "mcp_auto_allow_read",
			doc: "auto-allow MCP tools the read/write classifier deems read-only (parking only writes/unknown). Best-effort heuristic - off by default.",
			def: func() string { return "false" },
			get: func(a AgentConfig) (string, bool) {
				if a.Policy != nil && a.Policy.MCPAutoAllowRead != nil {
					return fmt.Sprintf("%t", *a.Policy.MCPAutoAllowRead), true
				}
				return "", false
			},
		},
		{
			table: "policy", key: "strict_mcp",
			doc: "make the allow-list the ONLY source of MCP servers: Hydra renders the allow-listed servers (plus its own control server) into a per-head config and launches Claude with --strict-mcp-config, so the host's ~/.claude.json and a branch's .mcp.json are ignored outright rather than filtered (filtering rides a bind mount the host can silently detach). Costs the claude.ai account connectors - Gmail/Calendar/Drive - which cannot be re-declared; turn it off for an agent that needs them. On by default.",
			def: func() string { return "true" },
			get: func(a AgentConfig) (string, bool) {
				if a.Policy != nil && a.Policy.StrictMCP != nil {
					return fmt.Sprintf("%t", *a.Policy.StrictMCP), true
				}
				return "", false
			},
		},
		{
			table: "policy", key: "agent_messaging",
			doc: "allow this head to send attributed messages to other live heads in the same project. Discovery stays available when this is off. Off by default.",
			def: func() string { return "false" },
			get: func(a AgentConfig) (string, bool) {
				if a.Policy != nil && a.Policy.AgentMessaging != nil {
					return fmt.Sprintf("%t", *a.Policy.AgentMessaging), true
				}
				return "", false
			},
		},
		{
			table: "policy", key: "known_tools",
			doc: "extra tool names to treat as safe (allowed without approval), extending the gate's built-in set. The gate fails closed on any tool it doesn't recognize (not a known built-in and no mcp__ prefix), parking it for approval; register a legitimate tool here to stop that. The default value below is the built-in set the gate already recognizes - add names to it, don't remove.",
			def: func() string { return tomlStringArray(gate.DefaultKnownTools()) },
			get: policySlice(func(p *PolicyConfig) []string { return p.KnownTools }),
		},
	}
}

// managedKeySet returns the set of setting keys the renderer owns. A commented
// assignment of one of these (e.g. "# masked_paths = [...]") in an existing file
// is recognised as a regenerated default and dropped before re-rendering.
func managedKeySet() map[string]bool {
	m := map[string]bool{}
	for _, e := range defaultsSpec() {
		m[e.key] = true
	}
	// icon is rendered outside the spec (Config-level, emitIcon); its regenerated
	// "# icon = ..." default line is recognised and dropped rather than kept as a
	// stray user comment on the next save.
	m["icon"] = true
	// resume_prompt is rendered outside the spec (it is Config-level, not
	// per-agent), but is still managed: a regenerated "# resume_prompt = ..."
	// line must be recognised and dropped rather than kept as a user comment.
	m["resume_prompt"] = true
	// artifact_concurrency is likewise Config-level (emitArtifactConcurrency), so
	// its regenerated "# artifact_concurrency = N" default line is recognised and
	// dropped rather than kept as a stray user comment on the next save.
	m["artifact_concurrency"] = true
	// artifact_prefetch is Config-level too (emitArtifactPrefetch); its regenerated
	// "# artifact_prefetch = true" default line is likewise recognised and dropped.
	m["artifact_prefetch"] = true
	// test_concurrency is Config-level (emitTestConcurrency); its regenerated
	// "# test_concurrency = N" default line is recognised and dropped too.
	m["test_concurrency"] = true
	// test_prefetch is Config-level (emitTestPrefetch); its regenerated
	// "# test_prefetch = true" default line is recognised and dropped too.
	m["test_prefetch"] = true
	// preview_ports is Config-level (emitPreviewPorts); its regenerated
	// "# preview_ports = ..." default line is recognised and dropped too.
	m["preview_ports"] = true
	// fullscreen is rendered specially under [claude] (emitClaudeAgent), not via
	// the spec, but is likewise managed so its regenerated "# fullscreen = false"
	// default line is recognised and replaced rather than kept as a user comment.
	m["fullscreen"] = true
	return m
}

// artifactsDocLines is the Hydra-owned documentation block emitted before the
// [[artifacts]] section. Like every doc block it uses docPrefix, so it is
// replaced (kept current) on each save.
func artifactsDocLines() []string {
	return []string{
		docPrefix + " [artifacts.<name>]: per-project scripts that render visual artifacts (e.g.",
		docPrefix + " screenshots) of a checkout. The diff viewer runs each against both sides of a",
		docPrefix + " comparison and shows the outputs that differ. The <name> table key is the unique",
		docPrefix + " label, also used as the cache directory. Fields:",
		docPrefix + "   script       shell script run via `bash -c` in the checkout directory (required).",
		docPrefix + "                Write it as a multi-line ''' block - it is a script, not a one-liner:",
		docPrefix + "                each step on its own line, comments where a step needs explaining.",
		docPrefix + "   timeout_sec  max seconds the command may run (0 = built-in default).",
		docPrefix + "   unsafe_host  run on the host with NO sandbox - full access to your machine and",
		docPrefix + "                credentials; only for audited, self-contained commands (default false).",
		docPrefix + "   clean_ignored  also delete git-ignored files (e.g. node_modules) before each run -",
		docPrefix + "                a pristine checkout (git clean -fdx) instead of the default that keeps",
		docPrefix + "                dependency/build caches warm (-fd). Slower; set true only if stale",
		docPrefix + "                ignored output can leak between commits (default false).",
		docPrefix + `   auto_run     "always" (default), "settled" (wait while agent works), or "never"`,
		docPrefix + "                (Refresh only). Cached artifacts still display in every mode.",
		docPrefix + "   strict       run the command under `set -eo pipefail` so a failing step aborts",
		docPrefix + "                and propagates instead of being swallowed (default true; set false",
		docPrefix + "                to run the command exactly as written).",
		docPrefix + "   enabled      set false to skip this script in the diff viewer (default true).",
		docPrefix + " A live, clickable preview of the app is a [previews.<name>] entry, not an",
		docPrefix + " artifact - see that section below. (The old spelling for one, an artifact with",
		docPrefix + " type = \"server\", still parses and is moved to [previews.<name>] on the next save.)",
		docPrefix + " Formats: .png, .jpg and .gif are diffed pixel-by-pixel; .webm video is diffed",
		docPrefix + " frame-by-frame when ffmpeg is installed (otherwise by byte hash). Other types",
		docPrefix + " (.webp .avif .svg .bmp .pdf) are compared by byte hash. Video is .webm ONLY, and",
		docPrefix + " should be LOSSLESS (e.g. ffmpeg ... -c:v libvpx-vp9 -lossless 1): the frame check",
		docPrefix + " compares decoded pixels, so a lossy encode of identical frames still reads as",
		docPrefix + " \"modified\".",
		docPrefix + " The command is given: HYDRA_ARTIFACT_OUTPUT (directory to write images into),",
		docPrefix + " HYDRA_ARTIFACT_SOURCE (the checkout dir), HYDRA_ARTIFACT_REF (the resolved ref).",
		docPrefix + " Streaming: after writing a file (and its .meta sidecar) the command may print",
		docPrefix + ` ::hydra:artifact:: <path> on stdout (path relative to HYDRA_ARTIFACT_OUTPUT, e.g.`,
		docPrefix + ` echo "::hydra:artifact:: home-dark.png"). Hydra then scans and diffs just that file`,
		docPrefix + " and streams the tile to the diff viewer immediately, so images trickle in as they",
		docPrefix + " render instead of all appearing when the command exits. It is optional - emit no",
		docPrefix + " markers and every output is still collected by the final scan on exit. Emit the",
		docPrefix + " marker only once the file is fully written. (Print ::hydra:progress:: <text> to set",
		docPrefix + " the live progress header shown while the command runs.)",
		docPrefix + " Tags: alongside an image foo.png the command may write a JSON sidecar foo.png.meta",
		docPrefix + ` like {"tags": ["theme::dark", "viewport::phone"]}. The diff viewer shows these as`,
		docPrefix + " labels and offers a filter. A \"category::value\" tag is a scoped label: only one",
		docPrefix + " value per category is kept (the last one wins); plain tags are free-form.",
		docPrefix + " The sidecar may also carry an optional dpi - the device-scale factor the shot was",
		docPrefix + ` captured at, e.g. {"tags": [...], "dpi": 2} - so the grid sizes a tile by its`,
		docPrefix + " logical width (pixels / dpi): a 2x shot lays out like a 1x one, only sharper.",
		docPrefix + ` For a video, an optional fps (e.g. {"fps": 60}) sets the frame rate the diff`,
		docPrefix + " viewer's frame-step buttons use (HTML5 video exposes no frame rate of its own).",
		docPrefix + " Layering: [artifacts.<name>] entries merge by name across config layers (user ->",
		docPrefix + " project -> config.local.toml) - set fields patch the same-named inherited entry,",
		docPrefix + " new names append. (The legacy [[artifacts]] array syntax still parses, but a file",
		docPrefix + " using it replaces the inherited list wholesale.)",
	}
}

// artifactsExampleLines is a commented-out example shown when no artifacts exist.
func artifactsExampleLines() []string {
	return []string{
		"# [artifacts.screenshots]",
		"# script = '''",
		"# cd web",
		"# npm install",
		"# node scripts/take-screenshots.ts",
		"# '''",
		"# timeout_sec = 900",
	}
}

// artifactComments holds the user-written comments preserved across a save for a
// single artifact, keyed by its name: lines before the [[artifacts]] header and
// comment lines inside the block.
type artifactComments struct {
	leading  []string
	interior []string
}

// sectionEntryHeader renders the named-table header for one artifacts/
// services/tests entry, e.g. `[tests.go]` or `[artifacts."web shots"]`.
func sectionEntryHeader(section, key string) string {
	if isBareTOMLKey(key) {
		return "[" + section + "." + key + "]"
	}
	return "[" + section + "." + strconv.Quote(key) + "]"
}

// uniqueSectionKey returns a table key for name that is unique within seen,
// suffixing "-2", "-3", ... on a collision (duplicate names are representable
// because an explicit name field inside the table overrides the key).
func uniqueSectionKey(seen map[string]bool, name string) string {
	key := name
	for i := 2; seen[key]; i++ {
		key = fmt.Sprintf("%s-%d", name, i)
	}
	seen[key] = true
	return key
}

// emitSectionEntryHeader appends the named-table header for an entry, plus an
// explicit name field when the (uniquified) key does not spell the name.
func emitSectionEntryHeader(out *[]string, section, name string, seen map[string]bool, interior []string) {
	key := uniqueSectionKey(seen, name)
	*out = append(*out, sectionEntryHeader(section, key))
	*out = append(*out, interior...)
	if key != name {
		*out = append(*out, "name = "+tomlStringValue(name))
	}
}

// artifactFieldLines renders the field assignments of one artifact (its name
// lives in the [artifacts.<name>] header, not a field).
func artifactFieldLines(a ArtifactScript) []string {
	var out []string
	// type / idle_timeout_sec / ready_timeout_sec are deliberately not rendered:
	// they only ever meant "this is really a preview", and decodeConfig has
	// already moved such an entry into [previews.<name>]. Writing the artifacts
	// section without them is what migrates a legacy file on its next save.
	out = append(out, "script = "+tomlStringValue(a.Script))
	if a.TimeoutSec > 0 {
		out = append(out, fmt.Sprintf("timeout_sec = %d", a.TimeoutSec))
	}
	if a.UnsafeHost {
		out = append(out, "unsafe_host = true")
	}
	if a.CleanIgnored {
		out = append(out, "clean_ignored = true")
	}
	if a.AutoRun != "" && a.AutoRun != "always" {
		out = append(out, "auto_run = "+tomlStringValue(string(a.AutoRun)))
	}
	if a.Strict != nil && !*a.Strict {
		out = append(out, "strict = false")
	}
	if a.Enabled != nil && !*a.Enabled {
		out = append(out, "enabled = false")
	}
	return out
}

// emitArtifactsAuthoritative renders arts as the source of truth, preserving any
// hand-written comments matched to an existing artifact by name. An empty list
// falls back to the commented example so the documentation never stands alone.
func emitArtifactsAuthoritative(out *[]string, arts []ArtifactScript, meta map[string]artifactComments) {
	rendered := 0
	seen := map[string]bool{}
	for _, a := range arts {
		if a.Name == "" && a.Script == "" {
			continue
		}
		if rendered > 0 {
			*out = append(*out, "")
		}
		rendered++
		m := meta[a.Name]
		*out = append(*out, m.leading...)
		emitSectionEntryHeader(out, "artifacts", a.Name, seen, m.interior)
		*out = append(*out, artifactFieldLines(a)...)
	}
	if rendered == 0 {
		*out = append(*out, artifactsExampleLines()...)
	}
}

// previewsDocLines is the Hydra-owned documentation block emitted before the
// [previews.<name>] section. Like every doc block it uses docPrefix, so it is
// replaced (kept current) on each save.
func previewsDocLines() []string {
	return []string{
		docPrefix + " [previews.<name>]: per-project scripts that boot a live, clickable preview of",
		docPrefix + " the app at a checkout. Each appears in the Previews row on the agent page; Hydra",
		docPrefix + " proxies a dedicated port to it, spawning the server when its link is first",
		docPrefix + " opened, keeping it warm while requests flow, and tearing it down once idle (the",
		docPrefix + " next visit respawns it). The <name> table key is the unique label. Fields:",
		docPrefix + "   script       shell script run via `bash -c` in the checkout directory (required).",
		docPrefix + "                It must build/boot a server that listens on $HYDRA_PREVIEW_ADDR and",
		docPrefix + "                stay in the foreground. Write it as a multi-line ''' block - it is a",
		docPrefix + "                script, not a one-liner: each step on its own line.",
		docPrefix + "   unsafe_host  run on the host with NO sandbox - full access to your machine and",
		docPrefix + "                credentials. Worse here than for an artifact: a preview runs the",
		docPrefix + "                previewed ref's code as a long-lived resident process (default false).",
		docPrefix + "   strict       run the command under `set -eo pipefail` so a failing build step",
		docPrefix + "                aborts the spawn instead of serving a half-built tree (default true).",
		docPrefix + "   enabled      set false to hide this preview from the agent page (default true).",
		docPrefix + "   idle_timeout_sec   teardown after this long with zero in-flight requests; open",
		docPrefix + "                WebSocket/long-poll connections count as in-flight, so a live app tab",
		docPrefix + "                keeps its preview running (0 = default 300).",
		docPrefix + "   ready_timeout_sec  max seconds from spawn to ready - builds included (0 = default",
		docPrefix + "                900). Ready = the first successful dial of the port, or an explicit",
		docPrefix + "                ::hydra:server:ready:: line on stdout, whichever comes first.",
		docPrefix + " The command is given: HYDRA_PREVIEW_PORT (the port to listen on), HYDRA_PREVIEW_ADDR",
		docPrefix + " (the full host:port to bind - 0.0.0.0:PORT under network mode hard, else",
		docPrefix + " 127.0.0.1:PORT; bind THIS, not a hardcoded 127.0.0.1, or hard mode 502s) and",
		docPrefix + " HYDRA_PREVIEW_SOURCE (the checkout dir). Print ::hydra:progress:: <text> to set the",
		docPrefix + " headline shown while it boots.",
		docPrefix + " Which ports the proxy allocates from is preview_ports, above.",
		docPrefix + " Layering: [previews.<name>] entries merge by name across config layers (user ->",
		docPrefix + " project -> config.local.toml) - set fields patch the same-named inherited entry,",
		docPrefix + " new names append.",
		docPrefix + " Previews used to be written as [artifacts.<name>] with type = \"server\". That still",
		docPrefix + " parses - such an entry is read as a preview and rewritten here on the next save.",
	}
}

// previewsExampleLines is a commented-out example shown when no previews exist.
func previewsExampleLines() []string {
	return []string{
		"# [previews.app]",
		"# script = '''",
		"# npm install",
		"# npm run build",
		"# npm run serve -- --host \"$HYDRA_PREVIEW_ADDR\"",
		"# '''",
		"# ready_timeout_sec = 900",
	}
}

// previewFieldLines renders the field assignments of one preview (its name lives
// in the [previews.<name>] header, not a field).
func previewFieldLines(p PreviewScript) []string {
	out := []string{"script = " + tomlStringValue(p.Script)}
	if p.IdleTimeoutSec > 0 {
		out = append(out, fmt.Sprintf("idle_timeout_sec = %d", p.IdleTimeoutSec))
	}
	if p.ReadyTimeoutSec > 0 {
		out = append(out, fmt.Sprintf("ready_timeout_sec = %d", p.ReadyTimeoutSec))
	}
	if p.UnsafeHost {
		out = append(out, "unsafe_host = true")
	}
	if p.Strict != nil && !*p.Strict {
		out = append(out, "strict = false")
	}
	if p.Enabled != nil && !*p.Enabled {
		out = append(out, "enabled = false")
	}
	return out
}

// emitPreviewsAuthoritative renders prevs as the source of truth, preserving any
// hand-written comments matched to an existing preview by name. Comments fall
// back to the artifacts section's when the preview has none of its own: that is
// the migration case - the entry was written as [artifacts.<name>] with
// type = "server", so its notes are filed under the artifact of the same name
// and would otherwise be dropped by the very save that moves it here.
func emitPreviewsAuthoritative(out *[]string, prevs []PreviewScript, meta, artMeta map[string]artifactComments) {
	rendered := 0
	seen := map[string]bool{}
	for _, p := range prevs {
		if p.Name == "" && p.Script == "" {
			continue
		}
		if rendered > 0 {
			*out = append(*out, "")
		}
		rendered++
		m, ok := meta[p.Name]
		if !ok {
			m = artMeta[p.Name]
		}
		*out = append(*out, m.leading...)
		emitSectionEntryHeader(out, "previews", p.Name, seen, m.interior)
		*out = append(*out, previewFieldLines(p)...)
	}
	if rendered == 0 {
		*out = append(*out, previewsExampleLines()...)
	}
}

// servicesDocLines is the Hydra-owned documentation block emitted before the
// [[services]] section. Like every doc block it uses docPrefix, so it is
// replaced (kept current) on each save.
func servicesDocLines() []string {
	return []string{
		docPrefix + " [services.<name>]: per-project long-running scripts the daemon supervises while",
		docPrefix + " the project is registered. Each is started on daemon boot (and when the project",
		docPrefix + " is added), restarted with capped backoff if it exits unexpectedly, and",
		docPrefix + " process-group-killed on daemon shutdown, project removal, or a config save.",
		docPrefix + " The <name> table key is the unique label shown in the UI and logs. Fields:",
		docPrefix + "   script        shell script run via `bash -c` from the project root (required).",
		docPrefix + "   host          run on the host with NO sandbox - full machine/credential access;",
		docPrefix + "                 needed for host devices the sandbox hides, e.g. /dev/kvm (default false).",
		docPrefix + fmt.Sprintf("   max_restarts  relaunch cap after an unexpected exit (default %d; 0 = never).", DefaultServiceMaxRestarts),
		docPrefix + "   strict        run the command under `set -eo pipefail` so a failed startup step",
		docPrefix + "                 surfaces as a crash instead of a healthy process (default true).",
		docPrefix + "   enabled       set false to stop the daemon supervising this service (default true).",
		docPrefix + " Layering: [services.<name>] entries merge by name across config layers (user ->",
		docPrefix + " project -> config.local.toml) - set fields patch the same-named inherited entry,",
		docPrefix + " new names append. (The legacy [[services]] array syntax still parses, but a file",
		docPrefix + " using it replaces the inherited list wholesale.)",
	}
}

// servicesExampleLines is a commented-out example shown when no services exist.
func servicesExampleLines() []string {
	return []string{
		"# [services.emu-pool]",
		"# script = '''",
		"# scripts/emu-pool.sh up 3 --foreground",
		"# '''",
		"# host = true",
		"# max_restarts = 3",
	}
}

// serviceFieldLines renders the field assignments of one service.
func serviceFieldLines(svc ServiceScript) []string {
	out := []string{
		"script = " + tomlStringValue(svc.Script),
	}
	if svc.Host {
		out = append(out, "host = true")
	}
	if svc.MaxRestarts != nil {
		out = append(out, fmt.Sprintf("max_restarts = %d", *svc.MaxRestarts))
	}
	if svc.Strict != nil && !*svc.Strict {
		out = append(out, "strict = false")
	}
	if svc.Enabled != nil && !*svc.Enabled {
		out = append(out, "enabled = false")
	}
	return out
}

// emitServicesAuthoritative renders svcs as the source of truth, preserving any
// hand-written comments matched to an existing service by name. An empty list
// falls back to the commented example so the documentation never stands alone.
func emitServicesAuthoritative(out *[]string, svcs []ServiceScript, meta map[string]artifactComments) {
	rendered := 0
	seen := map[string]bool{}
	for _, svc := range svcs {
		if svc.Name == "" && svc.Script == "" {
			continue
		}
		if rendered > 0 {
			*out = append(*out, "")
		}
		rendered++
		m := meta[svc.Name]
		*out = append(*out, m.leading...)
		emitSectionEntryHeader(out, "services", svc.Name, seen, m.interior)
		*out = append(*out, serviceFieldLines(svc)...)
	}
	if rendered == 0 {
		*out = append(*out, servicesExampleLines()...)
	}
}

// testsDocLines is the Hydra-owned documentation block emitted before the
// [[tests]] section.
func testsDocLines() []string {
	return []string{
		docPrefix + " [tests.<name>]: per-project test-runner scripts. Hydra runs each against a",
		docPrefix + " head's branch and parses the report into a pass/fail verdict that gates the",
		docPrefix + " merge button (failing/errored soft-block merge; force always available). The",
		docPrefix + " <name> table key is the unique label, also used as the cache directory. Fields:",
		docPrefix + "   script       shell script run via `bash -c` in the checkout directory (required).",
		docPrefix + "   timeout_sec  max seconds the command may run (0 = built-in default).",
		docPrefix + "   unsafe_host  run on the host with NO sandbox - runs the diffed ref's test code;",
		docPrefix + "                only for trusted refs (default false).",
		docPrefix + "   clean_ignored  also delete git-ignored files before each run (default false).",
		docPrefix + `   auto_run     "always" (default), "settled" (wait while agent works), or "never"`,
		docPrefix + "                (Refresh only). Cached verdicts still display in every mode.",
		docPrefix + "   strict       run the command under `set -eo pipefail` (default true). Note: a",
		docPrefix + "                runner exiting non-zero because tests FAILED is a valid verdict,",
		docPrefix + "                not a strict abort - strict only governs the shell pipeline.",
		docPrefix + "   enabled      set false to skip this runner (default true).",
		docPrefix + `   type         "junit" (default) reads report files after exit; "stdout" parses`,
		docPrefix + "                ::hydra:test:*:: markers live from stdout (see streaming note below).",
		docPrefix + " The command writes a report into $HYDRA_TEST_OUTPUT: JUnit XML (*.xml - go test",
		docPrefix + " via gotestsum, pytest, jest/vitest, cargo-nextest, ...) or a Hydra-native *.json",
		docPrefix + ` ({total,passed,failed,skipped,duration_ms,cases:[{name,status,duration_ms,message}]}).`,
		docPrefix + " Every *.xml / *.json in the dir is parsed and the cases are merged, so one",
		docPrefix + " command may emit several reports (e.g. a test report plus a lint report).",
		docPrefix + " If it writes no report, the exit code alone becomes a red/green verdict.",
		docPrefix + " Warnings: a case with status \"warning\" (Hydra JSON), or a JUnit <failure",
		docPrefix + " type=\"warning\">, is a non-failing diagnostic - it shows as an amber ⚠ N on the",
		docPrefix + " long verdict chip (agent header / tests panel) but never fails the run or gates",
		docPrefix + " the merge (lint errors stay failures and do gate). ESLint 9's junit formatters",
		docPrefix + " don't tag severity, so feed lint via `-f json` converted to a Hydra-JSON report",
		docPrefix + " (severity 2 → status \"failed\", severity 1 → \"warning\").",
		docPrefix + " It is also given HYDRA_TEST_SOURCE (the checkout dir) and HYDRA_TEST_REF (the",
		docPrefix + " resolved ref).",
		docPrefix + " Streaming (type = \"stdout\"): instead of a report file, print one marker per line",
		docPrefix + " and Hydra counts them live (into the panel and the sidebar chip):",
		docPrefix + "   ::hydra:test:total:: 4556                                  (optional denominator)",
		docPrefix + "   ::hydra:test:pass:: internal/artifacts › TestGenerateAndCache",
		docPrefix + "   ::hydra:test:fail:: auth/rotation.test.ts:48:24 › grace window | expected 3 got 2",
		docPrefix + "   ::hydra:test:warn:: web/src/x.ts:12:5 › no-console | Unexpected console statement",
		docPrefix + "   ::hydra:test:skip:: heads/resume_test.go › TestResumeOnBoot | needs daemon",
		docPrefix + "   ::hydra:test:pass:38:: internal/artifacts › TestFast       (38 = duration in ms)",
		docPrefix + " Print ::hydra:progress:: <text> for an explicit phase headline; ordinary stdout",
		docPrefix + " stays in the live log but is not used as compact status for streaming runners.",
		docPrefix + " The token before the first › is the location (path[:line[:col]] or dotted class),",
		docPrefix + " middle › tokens are scope levels, the last is the test name, text after | is the",
		docPrefix + " message. A verb takes an optional :<ms> duration suffix, giving a streamed case",
		docPrefix + " the timing a JUnit report carries in its `time` attribute; it rides on the verb",
		docPrefix + " (a closed set) so a test name can never be mistaken for it, and omitting it stays",
		docPrefix + " valid. A marker is one line; in the message an escape sequence expands -",
		docPrefix + " backslash-n to a newline, backslash-t to a tab, backslash-r to a carriage return",
		docPrefix + " (so a multi-line stack trace fits on the one line) - and a doubled backslash",
		docPrefix + " becomes one literal backslash. Any other escape is left as-is.",
		docPrefix + " Layering: [tests.<name>] entries merge by name across config layers (user ->",
		docPrefix + " project -> config.local.toml) - set fields patch the same-named inherited entry,",
		docPrefix + " new names append. E.g. config.local.toml can disable one runner with just",
		docPrefix + "   [tests.lint]",
		docPrefix + "   enabled = false",
		docPrefix + " without restating its command. (The legacy [[tests]] array syntax still parses,",
		docPrefix + " but a file using it replaces the inherited list wholesale.)",
	}
}

// testsExampleLines is a commented-out example shown when no tests exist.
func testsExampleLines() []string {
	return []string{
		"# [tests.go]",
		"# script = '''",
		`# gotestsum --junitfile $HYDRA_TEST_OUTPUT/go.xml ./...`,
		"# '''",
		"# timeout_sec = 600",
	}
}

// testFieldLines renders the field assignments of one test runner (its name
// lives in the [tests.<name>] header, not a field).
func testFieldLines(t TestScript) []string {
	out := []string{
		"script = " + tomlStringValue(t.Script),
	}
	if t.TimeoutSec > 0 {
		out = append(out, fmt.Sprintf("timeout_sec = %d", t.TimeoutSec))
	}
	if t.UnsafeHost {
		out = append(out, "unsafe_host = true")
	}
	if t.CleanIgnored {
		out = append(out, "clean_ignored = true")
	}
	if t.AutoRun != "" && t.AutoRun != "always" {
		out = append(out, "auto_run = "+tomlStringValue(string(t.AutoRun)))
	}
	if t.Strict != nil && !*t.Strict {
		out = append(out, "strict = false")
	}
	if t.Enabled != nil && !*t.Enabled {
		out = append(out, "enabled = false")
	}
	if t.Type != "" && t.Type != "junit" {
		out = append(out, "type = "+tomlStringValue(t.Type))
	}
	return out
}

// emitTestsAuthoritative renders tests as the source of truth, preserving any
// hand-written comments matched to an existing runner by name.
func emitTestsAuthoritative(out *[]string, tests []TestScript, meta map[string]artifactComments) {
	rendered := 0
	seen := map[string]bool{}
	for _, t := range tests {
		if t.Name == "" && t.Script == "" {
			continue
		}
		if rendered > 0 {
			*out = append(*out, "")
		}
		rendered++
		m := meta[t.Name]
		*out = append(*out, m.leading...)
		emitSectionEntryHeader(out, "tests", t.Name, seen, m.interior)
		*out = append(*out, testFieldLines(t)...)
	}
	if rendered == 0 {
		*out = append(*out, testsExampleLines()...)
	}
}

// existingAnalysis captures everything renderConfig needs to read from a prior
// config file: the user comments attached to managed tables and keys, and the
// existing [[artifacts]] blocks with their preserved comments. It is derived
// from a real TOML parse (go-toml/v2's unstable AST gives accurate byte ranges
// per expression), so multi-line string and array values can never confuse
// comment attribution the way a naive line-by-line scan once did.
type existingAnalysis struct {
	tableComments     map[string][]string         // normalized table -> leading user comments
	keyComments       map[string][]string         // "normTable\x00key" -> preceding user comments
	artifactBlocks    [][]string                  // verbatim [[artifacts]] blocks, in source order
	artifactMeta      map[string]artifactComments // artifact name -> preserved comments
	previewBlocks     [][]string                  // verbatim [previews.<name>] blocks, in source order
	previewMeta       map[string]artifactComments // preview name -> preserved comments
	serviceBlocks     [][]string                  // verbatim [[services]] blocks, in source order
	serviceMeta       map[string]artifactComments // service name -> preserved comments
	testBlocks        [][]string                  // verbatim [[tests]] blocks, in source order
	testMeta          map[string]artifactComments // test runner name -> preserved comments
	reviewBlock       []string                    // verbatim [review] table (comments + table), fallback when cfg.Review is unset
	reviewComments    []string                    // just the user comments above [review], kept when the table is regenerated from cfg.Review
	jiraBlock         []string                    // verbatim [jira] table, preserved on save
	resourcesBlock    []string                    // verbatim [resources] table, fallback when cfg.Resources is unset
	resourcesComments []string                    // just the user comments above [resources], kept when it is regenerated from cfg.Resources
}

// tomlItem is one top-level TOML expression (a table header or a key/value),
// located by the inclusive 0-based line range it occupies in the source.
type tomlItem struct {
	kind      unstable.Kind
	startLine int
	endLine   int
	key       string // first key segment, for a KeyValue
	strVal    string // decoded value, for a string-valued KeyValue (used to read "name")
	norm      string // normalized table name, for a Table/ArrayTable
}

// lineIndexer returns a function mapping a byte offset to its 0-based line.
func lineIndexer(data []byte) func(off uint32) int {
	var newlines []int
	for i, b := range data {
		if b == '\n' {
			newlines = append(newlines, i)
		}
	}
	return func(off uint32) int {
		o := int(off)
		lo, hi := 0, len(newlines)
		for lo < hi {
			mid := (lo + hi) / 2
			if newlines[mid] < o {
				lo = mid + 1
			} else {
				hi = mid
			}
		}
		return lo
	}
}

// parseTOMLItems parses data (already CRLF-normalized) into its ordered
// top-level expressions, each tagged with the source line range it spans. The
// unstable parser leaves a table header's Raw range empty, so its line is taken
// from the first key segment, whose Data references the input bytes for a bare
// key. A quoted key decodes to an allocated slice that Parser.Range rejects with
// a panic; the deferred recover turns that (and any other unstable-API surprise)
// into an error so the caller degrades to a fresh render instead of crashing.
func parseTOMLItems(data []byte) (items []tomlItem, err error) {
	defer func() {
		if r := recover(); r != nil {
			items, err = nil, errtrace.Wrap(fmt.Errorf("parse toml structure: %v", r))
		}
	}()
	offsetLine := lineIndexer(data)
	var p unstable.Parser
	p.Reset(data)
	for p.NextExpression() {
		e := p.Expression()
		switch e.Kind {
		case unstable.Table, unstable.ArrayTable:
			var parts []string
			var firstKey []byte // the first segment's bytes, still referencing the input
			it := e.Key()
			for it.Next() {
				if firstKey == nil {
					firstKey = it.Node().Data
				}
				parts = append(parts, string(it.Node().Data))
			}
			if len(parts) == 0 {
				continue
			}
			line := offsetLine(p.Range(firstKey).Offset)
			items = append(items, tomlItem{
				kind:      e.Kind,
				startLine: line,
				endLine:   line,
				norm:      normalizeTableParts(parts),
			})
		case unstable.KeyValue:
			it := e.Key()
			if !it.Next() {
				continue
			}
			item := tomlItem{
				kind:      e.Kind,
				startLine: offsetLine(e.Raw.Offset),
				endLine:   offsetLine(e.Raw.Offset + e.Raw.Length),
				key:       string(it.Node().Data),
			}
			if v := e.Value(); v.Kind == unstable.String {
				item.strVal = string(v.Data)
			}
			items = append(items, item)
		}
	}
	if err := p.Error(); err != nil {
		return nil, errtrace.Wrap(err)
	}
	return items, nil
}

// analyzeExisting parses prior config bytes and attributes every user comment to
// the managed table, key, or [[artifacts]] block it precedes. An empty input (or
// one that fails to parse) yields an empty analysis, so renderConfig still emits
// a valid file. keys is the managed-key set used to strip Hydra's own docs.
func analyzeExisting(data []byte, keys map[string]bool) *existingAnalysis {
	res := &existingAnalysis{
		tableComments: map[string][]string{},
		keyComments:   map[string][]string{},
		artifactMeta:  map[string]artifactComments{},
		previewMeta:   map[string]artifactComments{},
		serviceMeta:   map[string]artifactComments{},
		testMeta:      map[string]artifactComments{},
	}
	if len(data) == 0 {
		return res
	}
	text := strings.ReplaceAll(string(data), "\r\n", "\n")
	lines := strings.Split(text, "\n")
	if n := len(lines); n > 0 && lines[n-1] == "" {
		lines = lines[:n-1] // drop the empty element from a trailing newline
	}
	items, err := parseTOMLItems([]byte(text))
	if err != nil {
		return res // malformed file: degrade to a fresh render rather than fail the save
	}

	// gap returns the comment/blank source lines between the previous item's end
	// and the start of the next item - i.e. the lines preceding that item.
	gap := func(prevEnd, start int) []string {
		from := max(prevEnd+1, 0)
		if from >= start || start > len(lines) {
			return nil
		}
		return lines[from:start]
	}

	prevEnd := -1
	curNorm := "" // normalized managed table for the current section (root = "")

	// Accumulators for the array-of-tables ([[artifacts]] / [[services]]) block
	// currently being read. curArray is the normalized table name, which routes
	// the flushed block to the right slice; an unknown name falls back to
	// artifacts, preserving the historical "all array tables are artifacts"
	// behaviour for back-compat.
	inArray := false
	curArray := ""
	var artLeading, artInterior []string
	var artName string
	artHeaderLine, artLastLine := 0, 0
	flushArray := func() {
		if !inArray {
			return
		}
		block := append([]string{}, userComments(artLeading, keys)...)
		block = append(block, lines[artHeaderLine:artLastLine+1]...)
		meta := artifactComments{leading: userComments(artLeading, keys), interior: artInterior}
		switch curArray {
		case "previews":
			res.previewBlocks = append(res.previewBlocks, block)
			if artName != "" {
				res.previewMeta[artName] = meta
			}
		case "services":
			res.serviceBlocks = append(res.serviceBlocks, block)
			if artName != "" {
				res.serviceMeta[artName] = meta
			}
		case "tests":
			res.testBlocks = append(res.testBlocks, block)
			if artName != "" {
				res.testMeta[artName] = meta
			}
		default:
			res.artifactBlocks = append(res.artifactBlocks, block)
			if artName != "" {
				res.artifactMeta[artName] = meta
			}
		}
		inArray, curArray, artLeading, artInterior, artName = false, "", nil, nil, ""
	}

	// [review] and [jira] are top-level single tables Hydra parses but does not
	// render through the spec machinery, so preserve them verbatim (like the
	// [[artifacts]] blocks) rather than dropping them on a Settings save.
	inVerbatim := false
	verbNorm := ""
	var verbLeading []string
	verbHeaderLine, verbLastLine := 0, 0
	flushVerbatim := func() {
		if !inVerbatim {
			return
		}
		comments := userComments(verbLeading, keys)
		block := append([]string{}, comments...)
		block = append(block, lines[verbHeaderLine:verbLastLine+1]...)
		switch verbNorm {
		case "review":
			res.reviewBlock = block
			res.reviewComments = comments
		case "jira":
			res.jiraBlock = block
		case "resources":
			res.resourcesBlock = block
			res.resourcesComments = comments
		}
		inVerbatim, verbNorm, verbLeading = false, "", nil
	}
	isVerbatimTable := func(norm string) bool {
		return norm == "review" || norm == "jira" || norm == "resources"
	}

	for _, it := range items {
		g := gap(prevEnd, it.startLine)
		switch it.kind {
		case unstable.ArrayTable:
			flushArray()
			flushVerbatim()
			inArray = true
			curArray = it.norm
			artLeading = g
			artHeaderLine, artLastLine = it.startLine, it.endLine
		case unstable.Table:
			flushArray()
			flushVerbatim()
			// A named script entry ([artifacts.<x>] / [services.<x>] / [tests.<x>])
			// is accumulated exactly like a [[section]] block: preserved verbatim in
			// preserve mode, comments keyed by the entry's effective name otherwise.
			if sec, key, ok := splitSectionEntry(it.norm); ok {
				inArray = true
				curArray = sec
				artLeading = g
				artName = key
				artHeaderLine, artLastLine = it.startLine, it.endLine
				break
			}
			if isVerbatimTable(it.norm) {
				inVerbatim = true
				verbNorm = it.norm
				verbLeading = g
				verbHeaderLine, verbLastLine = it.startLine, it.endLine
				curNorm = it.norm
				break
			}
			curNorm = it.norm
			if uc := userComments(g, keys); len(uc) > 0 {
				res.tableComments[curNorm] = append(res.tableComments[curNorm], uc...)
			}
		case unstable.KeyValue:
			switch {
			case inArray:
				for _, ln := range g {
					if strings.HasPrefix(strings.TrimSpace(ln), "#") {
						artInterior = append(artInterior, ln)
					}
				}
				// An explicit name field overrides a named table's key (mirroring
				// decodeScriptSection), and names a legacy [[section]] entry.
				if it.key == "name" && it.strVal != "" {
					artName = it.strVal
				}
				artLastLine = it.endLine
			case inVerbatim:
				verbLastLine = it.endLine
			default:
				if uc := userComments(g, keys); len(uc) > 0 {
					res.keyComments[curNorm+"\x00"+it.key] = uc
				}
			}
		}
		if it.endLine > prevEnd {
			prevEnd = it.endLine
		}
	}
	flushArray()
	flushVerbatim()
	return res
}

// normalizeTableParts joins a table header's key segments into the canonical
// new-layout name, dropping a leading "defaults"/"agents" container: e.g.
// ["defaults"]→"", ["defaults","sandbox"]→"sandbox", ["agents","claude",
// "sandbox"]→"claude.sandbox", ["sandbox"]→"sandbox".
func normalizeTableParts(parts []string) string {
	if len(parts) > 0 && (parts[0] == "defaults" || parts[0] == "agents") {
		parts = parts[1:]
	}
	return strings.Join(parts, ".")
}

// isManagedDoc reports whether a line is a Hydra-generated documentation comment.
func isManagedDoc(line string) bool {
	t := strings.TrimSpace(line)
	if strings.HasPrefix(t, docPrefix) {
		return true
	}
	for _, p := range legacyDocPrefixes {
		if strings.HasPrefix(t, p) {
			return true
		}
	}
	return false
}

// isManagedCommentedAssign reports whether a line is a commented-out assignment
// of a managed key (e.g. "# masked_paths = [...]"), i.e. a regenerated default.
func isManagedCommentedAssign(line string, keys map[string]bool) bool {
	t := strings.TrimSpace(line)
	if !strings.HasPrefix(t, "#") || isManagedDoc(t) {
		return false
	}
	t = strings.TrimSpace(strings.TrimPrefix(t, "#"))
	if eq := strings.Index(t, "="); eq > 0 {
		return keys[strings.TrimSpace(t[:eq])]
	}
	return false
}

// managedArraySections are the array-of-tables ([[name]]) sections Hydra owns and
// regenerates. When empty, each is rendered as a commented-out example block (a
// commented "# [[name]]" header followed by commented "# key = value" fields).
var managedArraySections = []string{"artifacts", "previews", "services", "tests"}

// splitSectionEntry reports whether a normalized table name is a named script
// entry of one of the managed sections - "tests.go" -> ("tests", "go", true).
// The key may itself contain dots (a quoted [tests."a.b"] normalizes to
// "tests.a.b"), so only the first segment is split off.
func splitSectionEntry(norm string) (section, key string, ok bool) {
	sec, rest, found := strings.Cut(norm, ".")
	if !found || rest == "" {
		return "", "", false
	}
	if slices.Contains(managedArraySections, sec) {
		return sec, rest, true
	}
	return "", "", false
}

// isManagedCommentedArrayHeader reports whether a line is a commented-out header
// for a managed script section - the legacy "# [[services]]" form or a named
// "# [services.emu-pool]" entry - i.e. the start of a regenerated example block.
func isManagedCommentedArrayHeader(line string) bool {
	t := strings.TrimSpace(line)
	if !strings.HasPrefix(t, "#") || isManagedDoc(t) {
		return false
	}
	t = strings.TrimSpace(strings.TrimPrefix(t, "#"))
	for _, s := range managedArraySections {
		if t == "[["+s+"]]" {
			return true
		}
		if strings.HasPrefix(t, "["+s+".") && strings.HasSuffix(t, "]") {
			return true
		}
	}
	return false
}

// managedExampleTables are the single tables whose commented-out example blocks
// ("# [review]" followed by "# key = value" lines) Hydra regenerates on every
// save, mirroring managedArraySections for array-of-tables examples.
var managedExampleTables = []string{"review", "jira", "resources"}

// isManagedCommentedTableHeader reports whether a line is a commented-out header
// for a managed example table (e.g. "# [review]") - the start of a regenerated
// example block.
func isManagedCommentedTableHeader(line string) bool {
	t := strings.TrimSpace(line)
	if !strings.HasPrefix(t, "#") || isManagedDoc(t) {
		return false
	}
	t = strings.TrimSpace(strings.TrimPrefix(t, "#"))
	for _, s := range managedExampleTables {
		if t == "["+s+"]" {
			return true
		}
	}
	return false
}

// isCommentedSimpleAssign reports whether a line is a commented-out "key = value"
// where key is a bare TOML key - i.e. an example field line like `# name = "x"`,
// not prose that merely contains "=". Used to consume the body of a commented
// example block regardless of the (regenerable) values it shows.
func isCommentedSimpleAssign(line string) bool {
	t := strings.TrimSpace(line)
	if !strings.HasPrefix(t, "#") || isManagedDoc(t) {
		return false
	}
	t = strings.TrimSpace(strings.TrimPrefix(t, "#"))
	eq := strings.IndexByte(t, '=')
	if eq <= 0 {
		return false
	}
	return isBareTOMLKey(strings.TrimSpace(t[:eq]))
}

// isBareTOMLKey reports whether s is a non-empty TOML bare key (A-Z a-z 0-9 _ -).
func isBareTOMLKey(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r != '_' && r != '-' && !(r >= 'a' && r <= 'z') && !(r >= 'A' && r <= 'Z') && !(r >= '0' && r <= '9') {
			return false
		}
	}
	return true
}

// userComments keeps only the user's own comments, dropping Hydra-generated doc,
// commented-default, commented-agent-header, and commented array-section example
// lines (all regenerated) and any blank lines. The example blocks are recognised
// structurally - a "# [[services]]" header followed by "# key = value" body lines -
// so they are dropped rather than swallowed into the next section as pseudo-user
// comments and re-emitted next to a fresh example, duplicating on every save.
func userComments(comments []string, keys map[string]bool) []string {
	var out []string
	inExample := false   // inside a commented array-section example block
	inMultiline := false // inside a commented ''' value within that block
	for _, c := range comments {
		t := strings.TrimSpace(c)
		if t == "" {
			inExample, inMultiline = false, false // a blank line ends an example block
			continue
		}
		// A commented ''' body belongs to the assignment that opened it, so keep
		// dropping until its closing delimiter. Without this the script examples -
		// whose value is a multi-line ''' block, not a one-line string - left their
		// body lines behind as "user comments" on every save, and the example was
		// then re-emitted below them, accumulating a copy per save.
		if inMultiline {
			if commentedMultilineDelim(c) {
				inMultiline = false
			}
			continue
		}
		if isManagedDoc(c) || isManagedCommentedAssign(c, keys) || isManagedCommentedAgentHeader(c) {
			continue
		}
		if isManagedCommentedArrayHeader(c) || isManagedCommentedTableHeader(c) {
			inExample = true
			continue
		}
		if inExample && isCommentedSimpleAssign(c) {
			inMultiline = commentedMultilineDelim(c)
			continue
		}
		inExample = false
		out = append(out, c)
	}
	return out
}

// commentedMultilineDelim reports whether a commented line ends with a ”' TOML
// multi-line delimiter - either opening one (`# script = ”'`) or closing one
// (`# ”'`). Both spellings end in the delimiter, so one check covers the pair.
func commentedMultilineDelim(line string) bool {
	t := strings.TrimSpace(line)
	if !strings.HasPrefix(t, "#") {
		return false
	}
	return strings.HasSuffix(strings.TrimSpace(strings.TrimPrefix(t, "#")), "'''")
}

// configHeaderLines is the explanatory banner at the top of every rendered
// config. Like every doc block it uses docPrefix ("##"), so it is recognised as
// Hydra-owned and regenerated on each save rather than preserved as user comment.
func configHeaderLines() []string {
	return []string{
		docPrefix + " Hydra project configuration - .hydra/config.toml",
		docPrefix + "",
		docPrefix + " Hydra runs autonomous coding agents (\"heads\"), each on its own git branch in an",
		docPrefix + " isolated worktree and OS sandbox, supervised by a per-project daemon. This file",
		docPrefix + " configures those agents and the daemon: the default pre-prompt, the sandbox",
		docPrefix + " policy (what agents may read, write and reach over the network), the decision",
		docPrefix + " gate, per-agent ([claude], [gemini], ...) overrides, and the [artifacts.<name>],",
		docPrefix + " [previews.<name>], [services.<name>] and [tests.<name>] scripts run per project.",
		docPrefix + "",
		docPrefix + " Reading this file:",
		docPrefix + "   ##  lines are Hydra's own docs and defaults - rewritten on every save, so edit",
		docPrefix + "       the setting below each, not the ## text itself.",
		docPrefix + "   # key = value   is a commented-out default; delete the leading \"# \" to override it.",
		docPrefix + "   # your note     a single-# comment is yours and is preserved across saves.",
		docPrefix + " Most settings are also editable from the Settings screen in the web UI.",
	}
}

// renderConfig serializes cfg to the new flattened TOML layout, rendered on top
// of the existing file content: user comments and unmanaged [[artifacts]] blocks
// are preserved, managed values reflect cfg, and unset default settings are
// emitted commented-out with up-to-date documentation.
func renderConfig(existing []byte, cfg Config) string {
	keys := managedKeySet()
	prior := analyzeExisting(existing, keys)
	keyComments := prior.keyComments     // "<table>\x00<key>" -> user comments
	tableComments := prior.tableComments // normalized table -> leading user comments
	artifactBlocks := prior.artifactBlocks
	artifactMeta := prior.artifactMeta // name -> preserved comments
	previewBlocks := prior.previewBlocks
	previewMeta := prior.previewMeta // name -> preserved comments
	serviceBlocks := prior.serviceBlocks
	serviceMeta := prior.serviceMeta // name -> preserved comments
	testBlocks := prior.testBlocks
	testMeta := prior.testMeta // name -> preserved comments

	// icon is not part of the structured save payload (the Settings UI's config
	// save doesn't send it - it is written via its own SetProjectIcon path), so a
	// save that doesn't carry it must preserve whatever the file already had rather
	// than silently dropping it. An explicit cfg.Icon (incl. "" to clear) wins.
	icon := cfg.Icon
	if icon == nil {
		if prev, err := decodeConfig(existing); err == nil {
			icon = prev.Icon
		}
	}
	// resume_prompt is not part of the structured save payload (the Settings UI
	// doesn't send it), so a save that doesn't carry it must preserve whatever the
	// file already had rather than silently dropping a hand-edited value. An
	// explicit cfg.ResumePrompt still wins.
	resumePrompt := cfg.ResumePrompt
	if resumePrompt == nil {
		if prev, err := decodeConfig(existing); err == nil {
			resumePrompt = prev.ResumePrompt
		}
	}
	// artifact_concurrency is authoritative from cfg (unlike resume_prompt, the
	// Settings editor DOES send it): a positive value is written, and 0 ("unset")
	// renders the commented default instead of preserving the existing file's
	// value - so clearing the field in the UI actually resets it to the default.
	artifactConcurrency := cfg.ArtifactConcurrency
	// test_concurrency is authoritative from cfg like artifact_concurrency.
	testConcurrency := cfg.TestConcurrency
	// artifact_prefetch isn't in the Settings editor, so (like resume_prompt) a save
	// that doesn't carry it preserves the file's existing value rather than dropping
	// a hand-edited toggle. An explicit cfg value still wins.
	artifactPrefetch := cfg.ArtifactPrefetch
	if artifactPrefetch == nil {
		if prev, err := decodeConfig(existing); err == nil {
			artifactPrefetch = prev.ArtifactPrefetch
		}
	}
	// test_prefetch mirrors artifact_prefetch: authoritative from cfg when the
	// editor sends it, otherwise preserve the file's existing hand-edited value.
	testPrefetch := cfg.TestPrefetch
	if testPrefetch == nil {
		if prev, err := decodeConfig(existing); err == nil {
			testPrefetch = prev.TestPrefetch
		}
	}
	// preview_ports isn't in the Settings editor, so (like resume_prompt) a save
	// that doesn't carry it preserves the file's existing hand-edited value.
	previewPorts := cfg.PreviewPorts
	if previewPorts == nil {
		if prev, err := decodeConfig(existing); err == nil {
			previewPorts = prev.PreviewPorts
		}
	}
	var out []string
	spec := defaultsSpec()

	// Explanatory banner at the very top of the file.
	out = append(out, configHeaderLines()...)

	// Root defaults (pre_prompt) - must precede any table header.
	if tc := tableComments[""]; len(tc) > 0 {
		out = append(out, tc...)
	}
	emitSpecTable(&out, spec, "", "", cfg.Defaults, keyComments, tableComments)
	emitIcon(&out, icon, keyComments)
	emitResumePrompt(&out, resumePrompt, keyComments)
	emitArtifactConcurrency(&out, artifactConcurrency, keyComments)
	emitArtifactPrefetch(&out, artifactPrefetch, keyComments)
	emitTestConcurrency(&out, testConcurrency, keyComments)
	emitTestPrefetch(&out, testPrefetch, keyComments)
	emitPreviewPorts(&out, previewPorts, keyComments)
	emitSpecTable(&out, spec, "sandbox", "[sandbox]", cfg.Defaults, keyComments, tableComments)
	emitSpecTable(&out, spec, "sandbox.network", "[sandbox.network]", cfg.Defaults, keyComments, tableComments)
	emitSpecTable(&out, spec, "policy", "[policy]", cfg.Defaults, keyComments, tableComments)

	// Per-agent overrides. The well-known agent types always get a documented
	// mention: their real table when configured, otherwise a commented-out header
	// so the file self-documents that per-agent overrides are possible.
	emitted := map[string]bool{}
	for _, name := range docAgents {
		emitted[name] = true
		a := cfg.Agents[name] // zero value when unconfigured
		if name == "claude" {
			// Claude always documents its fullscreen toggle, set or not.
			emitClaudeAgent(&out, a, keyComments, tableComments)
			continue
		}
		if agentHasContent(a) {
			emitAgent(&out, name, a, keyComments, tableComments)
		} else {
			emitAgentDoc(&out, name, tableComments)
			out = append(out, "# ["+name+"]")
		}
	}
	// Any other configured agents (e.g. bash), sorted for determinism.
	names := make([]string, 0, len(cfg.Agents))
	for name := range cfg.Agents {
		if !emitted[name] {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	for _, name := range names {
		emitAgent(&out, name, cfg.Agents[name], keyComments, tableComments)
	}

	// Artifacts: documentation block, then the artifact tables.
	out = appendBlank(out)
	out = append(out, artifactsDocLines()...)
	if cfg.Artifacts != nil {
		// Authoritative mode (the editor sent an explicit list): cfg.Artifacts is
		// the source of truth, so edits and deletions take effect. Per-artifact
		// hand-written comments are preserved by matching on the artifact name.
		emitArtifactsAuthoritative(&out, cfg.Artifacts, artifactMeta)
	} else if len(artifactBlocks) == 0 {
		// No artifacts configured and none in the file: show a commented example.
		out = append(out, artifactsExampleLines()...)
	} else {
		// Preserve mode (no explicit list, e.g. a defaults-only save): keep the
		// existing artifact blocks verbatim.
		for i, block := range artifactBlocks {
			if i > 0 {
				out = append(out, "")
			}
			out = append(out, block...)
		}
	}

	// Previews: documentation block, then the preview tables. Mirrors artifacts.
	// A legacy type = "server" artifact has already been folded into cfg.Previews
	// by decodeConfig, so an authoritative save rewrites it here - and, because
	// artifactFieldLines no longer emits type, drops it from the artifacts section
	// above. That pair of omissions IS the migration.
	out = appendBlank(out)
	out = append(out, previewsDocLines()...)
	if cfg.Previews != nil {
		emitPreviewsAuthoritative(&out, cfg.Previews, previewMeta, artifactMeta)
	} else if len(previewBlocks) == 0 {
		out = append(out, previewsExampleLines()...)
	} else {
		for i, block := range previewBlocks {
			if i > 0 {
				out = append(out, "")
			}
			out = append(out, block...)
		}
	}

	// Services: documentation block, then the service tables. Mirrors artifacts:
	// an authoritative list (from the editor) takes effect, a nil list preserves
	// the existing [[services]] blocks verbatim, and an absence shows an example.
	out = appendBlank(out)
	out = append(out, servicesDocLines()...)
	if cfg.Services != nil {
		emitServicesAuthoritative(&out, cfg.Services, serviceMeta)
	} else if len(serviceBlocks) == 0 {
		out = append(out, servicesExampleLines()...)
	} else {
		for i, block := range serviceBlocks {
			if i > 0 {
				out = append(out, "")
			}
			out = append(out, block...)
		}
	}

	// Tests: documentation block, then the test tables. Mirrors artifacts/services.
	out = appendBlank(out)
	out = append(out, testsDocLines()...)
	if cfg.Tests != nil {
		emitTestsAuthoritative(&out, cfg.Tests, testMeta)
	} else if len(testBlocks) == 0 {
		out = append(out, testsExampleLines()...)
	} else {
		for i, block := range testBlocks {
			if i > 0 {
				out = append(out, "")
			}
			out = append(out, block...)
		}
	}

	// Review: when cfg.Review carries values (edited via the Settings Review
	// section), regenerate the [review] table from them - keeping any user
	// comments that sat above it. Otherwise preserve a hand-written table verbatim,
	// or show a documented commented example so the section self-documents. Jira
	// is not editor-managed, so it stays verbatim.
	out = appendBlank(out)
	if cfg.Review != nil && !cfg.Review.isEmpty() {
		out = append(out, prior.reviewComments...)
		out = append(out, reviewFieldLines(*cfg.Review)...)
	} else if len(prior.reviewBlock) > 0 {
		out = append(out, prior.reviewBlock...)
	} else {
		out = append(out, reviewExampleLines()...)
	}
	if len(prior.jiraBlock) > 0 {
		out = appendBlank(out)
		out = append(out, prior.jiraBlock...)
	}

	// Resources: like [review], the Settings editor sends it, so regenerate the
	// [resources] table from cfg when it carries values (keeping any user comments
	// above it). Otherwise preserve a hand-written table verbatim, or show a
	// documented commented example so the section self-documents.
	out = appendBlank(out)
	if cfg.Resources != nil && !cfg.Resources.isEmpty() {
		out = append(out, prior.resourcesComments...)
		out = append(out, resourceFieldLines(*cfg.Resources)...)
	} else if len(prior.resourcesBlock) > 0 {
		out = append(out, prior.resourcesBlock...)
	} else {
		out = append(out, resourcesExampleLines()...)
	}

	result := strings.Join(out, "\n")
	if result != "" && !strings.HasSuffix(result, "\n") {
		result += "\n"
	}
	return result
}

// reviewExampleLines returns a commented-out, self-documenting [review] example
// for a config that has none, so the forge/MR settings are discoverable.
// See docs/non-local-integration.md Personal (non-shared) values belong in
// config.local.toml; nothing secret goes in either file.
func reviewExampleLines() []string {
	return []string{
		docPrefix + " [review] configures how Hydra talks to a forge (GitHub/GitLab) and the",
		docPrefix + " defaults for the Create MR dialog. There is no mode switch - the head<->MR",
		docPrefix + " link is per-head. Personal overrides belong in .hydra/config.local.toml;",
		docPrefix + " never put a token here (host-side gh/glab creds or the 0600 secrets file).",
		"# [review]",
		`# provider = "auto"            # auto | github | gitlab (auto detects from the remote URL)`,
		`# publisher = "forge"          # forge | graphite (Graphite uses GitHub underneath)`,
		`# remote = "origin"`,
		`# auth = "cli"                 # cli (shell out to gh/glab) | token (REST)`,
		`# default_action = "merge"     # merge (local, as today) | create_mr`,
		`# push_branch_template = "{id}" # e.g. "feat/{issue}-{id}"; {id} {issue} {base}`,
		`# issue_pattern = "[A-Z]+-[0-9]+" # extracts a Linear/Jira key from the head`,
		"# draft = true                 # open MRs as draft",
		"# squash = true                # request squash-on-merge",
		"# delete_remote_branch = true  # tell the forge to delete on merge",
		"# require_local_tests = true   # gate Publish on local [[tests]] like merge is",
		"# auto_push = true             # automatically push after an MR is linked",
		`# protected_branches = ["main"] # warn before a direct LOCAL merge into these`,
	}
}

// resourceFieldLines renders the [resources] table for renderConfig, emitting
// only the fields set at this layer (a nil pointer is left out so it keeps
// inheriting the layer below / the built-in default). Mirrors reviewFieldLines.
func resourceFieldLines(r ResourceLimits) []string {
	out := []string{"[resources]"}
	addInt := func(key string, v *int) {
		if v != nil {
			out = append(out, key+" = "+strconv.Itoa(*v))
		}
	}
	addInt("cpu_weight", r.CPUWeight)
	addInt("io_weight", r.IOWeight)
	addInt("cpu_quota", r.CPUQuota)
	addInt("memory_max", r.MemoryMax)
	addInt("tasks_max", r.TasksMax)
	addInt("io_read_bandwidth_max", r.IOReadBandwidthMax)
	addInt("io_write_bandwidth_max", r.IOWriteBandwidthMax)
	addInt("machine_cpu_quota", r.MachineCPUQuota)
	addInt("machine_io_read_bandwidth_max", r.MachineIOReadBandwidthMax)
	addInt("machine_io_write_bandwidth_max", r.MachineIOWriteBandwidthMax)
	addInt("background_cpu_quota", r.BackgroundCPUQuota)
	addInt("background_io_read_bandwidth_max", r.BackgroundIOReadBandwidthMax)
	addInt("background_io_write_bandwidth_max", r.BackgroundIOWriteBandwidthMax)
	return out
}

// resourcesExampleLines returns a commented-out, self-documenting [resources]
// example for a config that has none, so the cgroup limits are discoverable.
func resourcesExampleLines() []string {
	return []string{
		docPrefix + " [resources] caps the cgroup limits applied to every scoped workload of this",
		docPrefix + " project (agent, preview, service, artifact) via its transient systemd scope, so",
		docPrefix + " one runaway workload yields to the daemon and interactive work instead of",
		docPrefix + " starving the box. Weights are soft (they only bite under contention). CPU and",
		docPrefix + " IO ceilings have safe defaults; set a ceiling to 0 to opt out.",
		docPrefix + " A hard cap is silently skipped where its cgroup controller is not delegated to",
		docPrefix + " the user systemd manager (cpu/io often are not).",
		docPrefix + "",
		docPrefix + " If a single head can still stall the whole machine, io_weight is probably",
		docPrefix + " doing nothing: weights need the bfq scheduler or blk-iocost, and a typical",
		docPrefix + " NVMe has neither, so the property is accepted and ignored. The bandwidth",
		docPrefix + " caps below are blk-throttle instead, which always bites. The daemon logs a",
		docPrefix + " warning at startup when it detects io_weight is inert.",
		"# [resources]",
		fmt.Sprintf("# cpu_weight = %d   # 1-10000, soft CPU share under contention (default %d; below the daemon's 100)", sandbox.ScopeCPUWeight, sandbox.ScopeCPUWeight),
		fmt.Sprintf("# io_weight  = %d   # 1-10000, soft block-IO share under contention (default %d)", sandbox.ScopeIOWeight, sandbox.ScopeIOWeight),
		fmt.Sprintf("# cpu_quota  = %d  # hard CPU cap, percent of one core; default scales with this machine", sandbox.DefaultWorkloadCPUQuota(runtime.NumCPU())),
		"# memory_max = 2048 # hard memory ceiling in MB (OOM-killed past it); omit = no cap",
		"# tasks_max  = 512  # hard cap on processes/threads; omit = no cap",
		fmt.Sprintf("# io_read_bandwidth_max  = %d # hard read ceiling in MB/s for this project's device", sandbox.DefaultWorkloadIOReadBandwidthMax),
		fmt.Sprintf("# io_write_bandwidth_max = %d # hard write ceiling in MB/s; set 0 for no cap", sandbox.DefaultWorkloadIOWriteBandwidthMax),
		docPrefix + " The machine_* and background_* fields are honored only in the user config.",
		fmt.Sprintf("# machine_cpu_quota = %d", sandbox.DefaultMachineCPUQuota(runtime.NumCPU())),
		fmt.Sprintf("# machine_io_read_bandwidth_max = %d", sandbox.DefaultMachineIOReadBandwidthMax),
		fmt.Sprintf("# machine_io_write_bandwidth_max = %d", sandbox.DefaultMachineIOWriteBandwidthMax),
		fmt.Sprintf("# background_cpu_quota = %d", sandbox.DefaultBackgroundCPUQuota(runtime.NumCPU())),
		fmt.Sprintf("# background_io_read_bandwidth_max = %d", sandbox.DefaultBackgroundIOReadBandwidthMax),
		fmt.Sprintf("# background_io_write_bandwidth_max = %d", sandbox.DefaultBackgroundIOWriteBandwidthMax),
	}
}

// emitSpecTable appends one defaults table to out: set values active (with any
// preserved user comment), unset values commented-out with documentation.
func emitSpecTable(out *[]string, spec []specEntry, table, header string, def AgentConfig, keyComments, tableComments map[string][]string) {
	var entries []specEntry
	for _, e := range spec {
		if e.table == table {
			entries = append(entries, e)
		}
	}
	if len(entries) == 0 {
		return
	}
	if header != "" {
		*out = appendBlank(*out)
		if tc := tableComments[table]; len(tc) > 0 {
			*out = append(*out, tc...)
		}
		*out = append(*out, header)
	}
	for _, e := range entries {
		*out = appendSettingBlank(*out)
		text, isSet := e.get(def)
		// The Hydra doc line is shown above every setting, set or not, with any
		// preserved user comment above the doc.
		if uc := keyComments[table+"\x00"+e.key]; len(uc) > 0 {
			*out = append(*out, uc...)
		}
		// A doc may span several lines (e.g. an enumerated default list); each is
		// emitted with the docPrefix so the whole block is recognised and refreshed
		// on the next save (see isManagedDoc).
		for line := range strings.SplitSeq(e.doc, "\n") {
			*out = append(*out, docPrefix+" "+line)
		}
		if isSet {
			*out = append(*out, e.key+" = "+text)
		} else {
			*out = append(*out, "# "+e.key+" = "+e.def())
		}
	}
}

// emitIcon renders the top-level icon key (a Config-level setting): the project's
// custom icon shown in the web UI's project switcher and dropdown. Mirrors
// emitResumePrompt: preserved user comment, Hydra doc line, then the value
// (commented-out example when unset).
func emitIcon(out *[]string, icon *string, keyComments map[string][]string) {
	*out = appendSettingBlank(*out)
	if uc := keyComments["\x00icon"]; len(uc) > 0 {
		*out = append(*out, uc...)
	}
	*out = append(*out, docPrefix+` custom project icon shown in the web UI's project switcher and dropdown: an emoji, a lucide-react icon name (e.g. "Rocket"), or an image path/URL ending in .png/.svg/.ico/.jpg. Empty = the default folder icon.`)
	if icon != nil {
		*out = append(*out, "icon = "+tomlStringValue(*icon))
	} else {
		*out = append(*out, `# icon = "Rocket"`)
	}
}

// emitResumePrompt renders the top-level resume_prompt key (a Config-level
// setting, so it is emitted here rather than via the per-agent spec). It mirrors
// emitSpecTable's format: preserved user comment, Hydra doc line, then the value
// (commented-out showing the default when unset).
func emitResumePrompt(out *[]string, resumePrompt *string, keyComments map[string][]string) {
	*out = appendSettingBlank(*out)
	if uc := keyComments["\x00resume_prompt"]; len(uc) > 0 {
		*out = append(*out, uc...)
	}
	*out = append(*out, docPrefix+` message typed into an agent that was working when the daemon restarted, so it resumes its task instead of idling (default "`+DefaultResumePrompt+`"; "" disables).`)
	if resumePrompt != nil {
		*out = append(*out, "resume_prompt = "+tomlStringValue(*resumePrompt))
	} else {
		*out = append(*out, "# resume_prompt = "+tomlStringValue(DefaultResumePrompt))
	}
}

// emitArtifactConcurrency renders the top-level artifact_concurrency key (a
// Config-level setting, like resume_prompt). Preserved user comment, Hydra doc
// line, then the value (commented-out showing the default when unset).
func emitArtifactConcurrency(out *[]string, concurrency *int, keyComments map[string][]string) {
	*out = appendSettingBlank(*out)
	if uc := keyComments["\x00artifact_concurrency"]; len(uc) > 0 {
		*out = append(*out, uc...)
	}
	*out = append(*out, docPrefix+fmt.Sprintf(` max visual-artifact generations run at once, across foreground (viewing a diff) and background (proactive) work; lower it for RAM-hungry generators, or 0 for unlimited (default %d).`, DefaultArtifactConcurrency))
	// nil = unset → show the commented default; a set value (including 0 =
	// unlimited) is written authoritatively, so clearing the field in the editor
	// resets to the default rather than preserving the old value.
	if concurrency != nil {
		*out = append(*out, fmt.Sprintf("artifact_concurrency = %d", *concurrency))
	} else {
		*out = append(*out, fmt.Sprintf("# artifact_concurrency = %d", DefaultArtifactConcurrency))
	}
}

// emitTestConcurrency renders the top-level test_concurrency key (a Config-level
// setting, like artifact_concurrency). Preserved user comment, Hydra doc line,
// then the value (commented-out showing the default when unset).
func emitTestConcurrency(out *[]string, concurrency *int, keyComments map[string][]string) {
	*out = appendSettingBlank(*out)
	if uc := keyComments["\x00test_concurrency"]; len(uc) > 0 {
		*out = append(*out, uc...)
	}
	*out = append(*out, docPrefix+fmt.Sprintf(` max test-runner generations run at once; lower it for heavy suites, or 0 for unlimited (default %d).`, DefaultTestConcurrency))
	if concurrency != nil {
		*out = append(*out, fmt.Sprintf("test_concurrency = %d", *concurrency))
	} else {
		*out = append(*out, fmt.Sprintf("# test_concurrency = %d", DefaultTestConcurrency))
	}
}

// emitTestPrefetch renders the top-level test_prefetch key (a Config-level
// boolean, like artifact_prefetch): preserved user comment, Hydra doc line, then
// the value (commented-out showing the default when unset).
func emitTestPrefetch(out *[]string, prefetch *bool, keyComments map[string][]string) {
	*out = appendSettingBlank(*out)
	if uc := keyComments["\x00test_prefetch"]; len(uc) > 0 {
		*out = append(*out, uc...)
	}
	*out = append(*out, docPrefix+` re-run a head's test suites in the background when its branch-tip verdict is missing or stale, so it's ready before you open the panel; set false to run only on open / at merge - foreground runs and the concurrency cap still apply (default true).`)
	if prefetch != nil {
		*out = append(*out, fmt.Sprintf("test_prefetch = %t", *prefetch))
	} else {
		*out = append(*out, "# test_prefetch = true")
	}
}

// emitPreviewPorts renders the top-level preview_ports key (a Config-level
// setting, not part of the [defaults] spec table).
func emitPreviewPorts(out *[]string, ports *string, keyComments map[string][]string) {
	*out = appendSettingBlank(*out)
	if uc := keyComments["\x00preview_ports"]; len(uc) > 0 {
		*out = append(*out, uc...)
	}
	*out = append(*out, docPrefix+fmt.Sprintf(` inclusive "min-max" TCP port range that the live server previews ([previews.<name>]) allocate their listeners from; a fixed range keeps firewall rules simple, and busy ports are skipped (default %s).`, DefaultPreviewPorts))
	if ports != nil {
		*out = append(*out, "preview_ports = "+tomlStringValue(*ports))
	} else {
		*out = append(*out, `# preview_ports = "`+DefaultPreviewPorts+`"`)
	}
}

// emitArtifactPrefetch renders the top-level artifact_prefetch key (a Config-level
// boolean, like resume_prompt): preserved user comment, Hydra doc line, then the
// value (commented-out showing the default when unset).
func emitArtifactPrefetch(out *[]string, prefetch *bool, keyComments map[string][]string) {
	*out = appendSettingBlank(*out)
	if uc := keyComments["\x00artifact_prefetch"]; len(uc) > 0 {
		*out = append(*out, uc...)
	}
	*out = append(*out, docPrefix+` pre-generate a head's artifacts in the background once it settles, so a diff is ready before you open it; set false to generate only when viewing - foreground generation and the concurrency cap still apply (default true).`)
	if prefetch != nil {
		*out = append(*out, fmt.Sprintf("artifact_prefetch = %t", *prefetch))
	} else {
		*out = append(*out, "# artifact_prefetch = true")
	}
}

// docAgents are the agent types that always get a documented mention in the
// rendered config (a commented-out [name] header when they have no overrides).
// Order matches the Settings UI tabs.
var docAgents = []string{"claude", "gemini", "copilot", "codex"}

// agentLabel returns a human-friendly capitalised name for an agent type.
func agentLabel(name string) string {
	switch name {
	case "claude":
		return "Claude"
	case "gemini":
		return "Gemini"
	case "copilot":
		return "Copilot"
	case "codex":
		return "Codex"
	default:
		if name == "" {
			return name
		}
		return strings.ToUpper(name[:1]) + name[1:]
	}
}

// agentDoc is the one-line documentation shown above an agent's table.
func agentDoc(name string) string {
	label := agentLabel(name)
	return label + "-specific overrides: any of the settings above, applied only to " + name + " agents."
}

// isManagedCommentedAgentHeader reports whether a line is a regenerated
// commented-out agent header (e.g. "# [gemini]") for one of the docAgents, so it
// is dropped on read and re-emitted rather than accumulating as a user comment.
func isManagedCommentedAgentHeader(line string) bool {
	t := strings.TrimSpace(line)
	if !strings.HasPrefix(t, "#") || isManagedDoc(t) {
		return false
	}
	t = strings.TrimSpace(strings.TrimPrefix(t, "#"))
	for _, name := range docAgents {
		if t == "["+name+"]" {
			return true
		}
	}
	return false
}

// emitAgentDoc appends a blank separator, any preserved user comment, and the
// Hydra doc line for the given agent - the shared prefix of a real or commented
// agent table.
func emitAgentDoc(out *[]string, name string, tableComments map[string][]string) {
	*out = appendBlank(*out)
	if tc := tableComments[name]; len(tc) > 0 {
		*out = append(*out, tc...)
	}
	*out = append(*out, docPrefix+" "+agentDoc(name))
}

// emitAgent appends a per-agent table, emitting only the settings that are set.
// Used for every well-known agent except Claude, which has its own emitter
// (emitClaudeAgent) so it can always document the Claude-only fullscreen toggle.
func emitAgent(out *[]string, name string, a AgentConfig, keyComments, tableComments map[string][]string) {
	if !agentHasContent(a) {
		return
	}
	emitAgentDoc(out, name, tableComments)
	*out = append(*out, "["+name+"]")
	if a.PrePrompt != nil {
		if uc := keyComments[name+"\x00pre_prompt"]; len(uc) > 0 {
			*out = append(*out, uc...)
		}
		*out = append(*out, "pre_prompt = "+tomlStringValue(*a.PrePrompt))
	}
	emitAgentSandbox(out, name, a.Sandbox, keyComments, tableComments)
	emitAgentPolicy(out, name, a.Policy, keyComments, tableComments)
}

// emitClaudeAgent renders the [claude] table. Claude is the only agent that reads
// the `fullscreen` toggle (it is accepted nowhere else; see ResolveFullscreen), so
// - unlike the other agents - this always documents that setting, even when no
// Claude overrides are configured. The table is active when any Claude override is
// set; otherwise it stays a commented-out placeholder, with the fullscreen doc and
// default commented alongside it (a key cannot live under a commented table).
func emitClaudeAgent(out *[]string, a AgentConfig, keyComments, tableComments map[string][]string) {
	const name = "claude"
	active := agentHasContent(a)
	emitAgentDoc(out, name, tableComments)
	if active {
		*out = append(*out, "["+name+"]")
	} else {
		*out = append(*out, "# ["+name+"]")
	}
	if active && a.PrePrompt != nil {
		if uc := keyComments[name+"\x00pre_prompt"]; len(uc) > 0 {
			*out = append(*out, uc...)
		}
		*out = append(*out, "pre_prompt = "+tomlStringValue(*a.PrePrompt))
	}
	*out = appendSettingBlank(*out)
	if uc := keyComments[name+"\x00fullscreen"]; len(uc) > 0 {
		*out = append(*out, uc...)
	}
	*out = append(*out, docPrefix+" enable Claude Code's fullscreen (alternate-screen) rendering - flicker-free, but it takes over the terminal and captures the mouse; off (the default) keeps this terminal's native scrollbar and select-to-copy.")
	if active && a.Fullscreen != nil {
		*out = append(*out, fmt.Sprintf("fullscreen = %t", *a.Fullscreen))
	} else {
		*out = append(*out, "# fullscreen = false")
	}
	if active {
		emitAgentSandbox(out, name, a.Sandbox, keyComments, tableComments)
		emitAgentPolicy(out, name, a.Policy, keyComments, tableComments)
	}
}

// emitAgentSandbox appends the [name.sandbox] (+ network) subtable for the
// settings that are set. No-op when the agent has no sandbox overrides.
func emitAgentSandbox(out *[]string, name string, sb *SandboxConfig, keyComments, tableComments map[string][]string) {
	if sb == nil || !sandboxHasContent(sb) {
		return
	}
	*out = appendBlank(*out)
	if tc := tableComments[name+".sandbox"]; len(tc) > 0 {
		*out = append(*out, tc...)
	}
	*out = append(*out, "["+name+".sandbox]")
	emitSetField(out, name+".sandbox", "writable_paths", tomlStringArray(sb.WritablePaths), len(sb.WritablePaths) > 0, keyComments)
	emitSetField(out, name+".sandbox", "masked_paths", tomlStringArray(sb.MaskedPaths), len(sb.MaskedPaths) > 0, keyComments)
	emitSetField(out, name+".sandbox", "restore_ro", tomlStringArray(sb.RestoreRO), len(sb.RestoreRO) > 0, keyComments)
	emitSetField(out, name+".sandbox", "cow_paths", tomlStringArray(sb.CowPaths), len(sb.CowPaths) > 0, keyComments)
	emitSetField(out, name+".sandbox", "inherit_env", tomlStringArray(sb.InheritEnv), len(sb.InheritEnv) > 0, keyComments)
	if sb.PreSpawnScript != nil && *sb.PreSpawnScript != "" {
		emitSetField(out, name+".sandbox", "pre_spawn_script", tomlStringValue(*sb.PreSpawnScript), true, keyComments)
	}
	if sb.PreExitScript != nil && *sb.PreExitScript != "" {
		emitSetField(out, name+".sandbox", "pre_exit_script", tomlStringValue(*sb.PreExitScript), true, keyComments)
	}
	if nw := sb.Network; nw != nil && networkHasContent(nw) {
		*out = appendBlank(*out)
		if tc := tableComments[name+".sandbox.network"]; len(tc) > 0 {
			*out = append(*out, tc...)
		}
		*out = append(*out, "["+name+".sandbox.network]")
		if nw.Mode != nil && *nw.Mode != "" {
			emitSetField(out, name+".sandbox.network", "mode", tomlStringValue(*nw.Mode), true, keyComments)
		}
		if nw.Enabled != nil {
			emitSetField(out, name+".sandbox.network", "enabled", fmt.Sprintf("%t", *nw.Enabled), true, keyComments)
		}
		if nw.FilterEnabled != nil {
			emitSetField(out, name+".sandbox.network", "filter_enabled", fmt.Sprintf("%t", *nw.FilterEnabled), true, keyComments)
		}
		emitSetField(out, name+".sandbox.network", "allowed_hosts", tomlStringArray(nw.AllowedHosts), len(nw.AllowedHosts) > 0, keyComments)
		emitSetField(out, name+".sandbox.network", "blocked_hosts", tomlStringArray(nw.BlockedHosts), len(nw.BlockedHosts) > 0, keyComments)
		emitSetField(out, name+".sandbox.network", "allowed_loopback_ports", tomlIntArray(nw.AllowedLoopbackPorts), len(nw.AllowedLoopbackPorts) > 0, keyComments)
	}
}

// networkHasContent reports whether a NetworkConfig has any field worth emitting.
func networkHasContent(nw *NetworkConfig) bool {
	return nw.Mode != nil || nw.Enabled != nil ||
		nw.FilterEnabled != nil || len(nw.AllowedHosts) > 0 || len(nw.BlockedHosts) > 0 ||
		len(nw.AllowedLoopbackPorts) > 0
}

// emitAgentPolicy appends the [name.policy] subtable for the settings that are
// set. No-op when the agent has no policy overrides.
func emitAgentPolicy(out *[]string, name string, p *PolicyConfig, keyComments, tableComments map[string][]string) {
	if !policyHasContent(p) {
		return
	}
	*out = appendBlank(*out)
	if tc := tableComments[name+".policy"]; len(tc) > 0 {
		*out = append(*out, tc...)
	}
	*out = append(*out, "["+name+".policy]")
	if p.GateEnabled != nil {
		emitSetField(out, name+".policy", "gate_enabled", fmt.Sprintf("%t", *p.GateEnabled), true, keyComments)
	}
	if p.GitIsolation != nil {
		emitSetField(out, name+".policy", "git_isolation", strconv.Quote(*p.GitIsolation), true, keyComments)
	}
	emitSetField(out, name+".policy", "mcp_allowed", tomlStringArray(p.MCPAllowed), len(p.MCPAllowed) > 0, keyComments)
	emitSetField(out, name+".policy", "mcp_tools_allowed", tomlStringArray(p.MCPToolsAllowed), len(p.MCPToolsAllowed) > 0, keyComments)
	emitSetField(out, name+".policy", "mcp_blocked", tomlStringArray(p.MCPBlocked), len(p.MCPBlocked) > 0, keyComments)
	emitSetField(out, name+".policy", "mcp_tools_blocked", tomlStringArray(p.MCPToolsBlocked), len(p.MCPToolsBlocked) > 0, keyComments)
	if p.MCPAutoAllowRead != nil {
		emitSetField(out, name+".policy", "mcp_auto_allow_read", fmt.Sprintf("%t", *p.MCPAutoAllowRead), true, keyComments)
	}
	if p.StrictMCP != nil {
		emitSetField(out, name+".policy", "strict_mcp", fmt.Sprintf("%t", *p.StrictMCP), true, keyComments)
	}
	if p.AgentMessaging != nil {
		emitSetField(out, name+".policy", "agent_messaging", fmt.Sprintf("%t", *p.AgentMessaging), true, keyComments)
	}
	emitSetField(out, name+".policy", "known_tools", tomlStringArray(p.KnownTools), len(p.KnownTools) > 0, keyComments)
}

// emitSetField appends "key = text" (with any preserved user comment) when set.
func emitSetField(out *[]string, table, key, text string, set bool, keyComments map[string][]string) {
	if !set {
		return
	}
	if uc := keyComments[table+"\x00"+key]; len(uc) > 0 {
		*out = append(*out, uc...)
	}
	*out = append(*out, key+" = "+text)
}

func agentHasContent(a AgentConfig) bool {
	return a.PrePrompt != nil || a.Fullscreen != nil ||
		(a.Sandbox != nil && sandboxHasContent(a.Sandbox)) || policyHasContent(a.Policy)
}

// policyHasContent reports whether a PolicyConfig has any setting worth rendering.
func policyHasContent(p *PolicyConfig) bool {
	if p == nil {
		return false
	}
	return p.GateEnabled != nil || p.GitIsolation != nil || len(p.MCPAllowed) > 0 || len(p.MCPToolsAllowed) > 0 ||
		len(p.MCPBlocked) > 0 || len(p.MCPToolsBlocked) > 0 ||
		p.MCPAutoAllowRead != nil || p.StrictMCP != nil || p.AgentMessaging != nil || len(p.KnownTools) > 0
}

func sandboxHasContent(sb *SandboxConfig) bool {
	if sb == nil {
		return false
	}
	if len(sb.WritablePaths) > 0 || len(sb.MaskedPaths) > 0 || len(sb.RestoreRO) > 0 || len(sb.CowPaths) > 0 || len(sb.InheritEnv) > 0 {
		return true
	}
	if sb.PreSpawnScript != nil && *sb.PreSpawnScript != "" {
		return true
	}
	if sb.PreExitScript != nil && *sb.PreExitScript != "" {
		return true
	}
	return sb.Network != nil && networkHasContent(sb.Network)
}

// appendBlank adds a single blank separator line if out is non-empty.
func appendBlank(out []string) []string {
	if len(out) > 0 {
		return append(out, "")
	}
	return out
}

// appendSettingBlank separates one documented setting group (user comment + doc
// line + value) from the previous one with a blank line - but not when out is
// empty, already ends in a blank, or ends with a table header (real or commented,
// e.g. "[sandbox]" / "# [claude]"), so the first setting still hugs its header.
// Blank lines are regenerated and ignored on re-parse, so this stays idempotent.
func appendSettingBlank(out []string) []string {
	if len(out) == 0 {
		return out
	}
	last := strings.TrimSpace(out[len(out)-1])
	if last == "" {
		return out
	}
	if h := strings.TrimSpace(strings.TrimPrefix(last, "#")); strings.HasPrefix(h, "[") && strings.HasSuffix(h, "]") {
		return out
	}
	return append(out, "")
}
