# MCP auth + network sandboxing plan

Living plan for tightening Hydra's MCP tool authorization and network egress
boundary. Steps are ordered by dependency; check items off and append to the
Progress log as we go.

## Background / current state

- **MCP auth is per-server, not per-tool.** `gate.Decide` (`internal/gate/decide.go`)
  extracts only the server from `mcp__<server>__<tool>` and checks it against
  `Policy.MCPAllowed`. An allowed server → all its tools are usable.
- **Disallowed servers are stripped pre-launch** from the seeded `~/.claude.json`
  (`internal/sandbox/agentcfg.go` `BuildClaudeConfig`/`BuildClaudeSettings`), so
  they never spawn. Deny-by-default already: empty `mcp_allowed` strips everything.
- **Consequence:** the gate's `Ask`/toast path for `kind:"mcp"` is currently *dead
  code* — a stripped server is never reachable, so the toast never fires. Only
  WebFetch and `git push` approvals actually trigger today.
- **MCP config is launch-time.** You cannot add a server to a live Claude session;
  granting one requires a relaunch. `ResumeHead` (`internal/heads/heads.go:751`)
  **re-runs `seedHead` from current config**, so allow-list changes reach *resumed*
  agents on their next resume, and a "resume-to-grant" flow is viable.
- **Egress already has two enforcement modes** (`internal/heads/egress.go`):
  - `filtered-hard` — pasta netns + nft drop-all-except-proxy; nft loads while
    holding `CAP_NET_ADMIN`, then bwrap drops caps → **inescapable**. Auto-selected
    when a smoke test passes (`internal/egress/hardmode.go`).
  - `filtered-advisory` — shared host netns, `HTTP(S)_PROXY` only → escapable; used
    when pasta/nft unavailable.
  These are *derived* from `network.enabled` + `network.filter_enabled` + host
  capability, not chosen by the user.
- **Ports:** isolated in `off` and `hard` modes (own netns); **shared with host in
  advisory mode** (bwrap doesn't `--unshare-net`, no pasta) — this is why the
  pre-prompt warns about ports.

## Key design decisions

- **Two independent boundaries, kept separate:**
  1. *"May this server run?"* → the pre-launch strip + server allow-list. Stays the
     process-execution boundary. The agent can only ever request servers the host
     operator has configured in `~/.claude.json` / `.mcp.json` — never arbitrary ones.
  2. *"May the agent call this tool of an allowed-to-run server?"* → per-tool runtime
     gating. This is where read/write and one-at-a-time approval belong.
- **read/write hints are advisory.** `annotations.readOnlyHint` is self-reported by
  the server → use for UX badges + optional default policy, **never** as a security
  guarantee.
- **Filtering-on-by-default needs a default allow-list.** The `claude` process runs
  *inside* the sandbox behind `HTTP(S)_PROXY`, so its own traffic to
  `api.anthropic.com` is filtered too. Deny-by-default with an empty list bricks the
  agent. Ship a sane default allow-list (Anthropic API + common package/registry/git
  hosts).
- **Block-list overrides everything.** Final rule:
  `reachable(host) = (host ∈ user_allow ∪ default_allow) AND host ∉ block_list`.
  The block-list lets a user subtract a host from the defaults (or from their own
  allow-list) without editing the defaults. UI surfaces this with a tooltip.
- **Hard-default must degrade visibly, not silently.** macOS has no pasta; many Linux
  hosts lack it. Default `mode = "hard"` but fall back to advisory with a **loud UI
  warning**; a separate `strict` flag makes it fail-closed for users who want the
  guarantee.

---

## Step 1 — Network sandboxing as an explicit mode (+ default allow/block lists) ✅

Goal: make egress posture a first-class, visible, secure-by-default mode.

- [x] Add `mode = "hard" | "advisory" | "unrestricted" | "off"` to
      `[<agent>.sandbox.network]` (`sandbox.NetworkMode`, `config.NetworkConfig.Mode`);
      `resolveNetworkPolicy` derives `NetworkPolicy{Enabled,FilterHosts,Mode,...}` from
      it, with legacy `enabled`/`filter_enabled` honoured only when `mode` is unset.
- [x] Default `mode = "hard"` (breaking: no config now = deny-by-default filtering).
      On pasta/nft unavailability it degrades to advisory (logged); `strict` fails
      closed (forces `Enabled=false`) instead. See `heads.startEgress`.
- [x] `sandbox.DefaultAllowedHosts()` — Anthropic/AI APIs + package registries + git
      hosts. Unioned with user `allowed_hosts` in `startEgress`.
- [x] `blocked_hosts` overrides allow ∪ default-allow — enforced in the egress proxy
      `allow()` (`gate.HostAllowed(blocked)` wins). (Gate-side WebFetch block deferred.)
- [x] Surfaced in the settings UI: a mode dropdown + strict toggle + allowed/blocked
      host editors, with a tooltip explaining hard vs advisory + allow/block
      precedence (`web/.../ConfigForm.tsx`). `EgressMode` already flows to
      `AgentResponse` (handlers.go). API: `NetworkConfig.{mode,strict,blocked_hosts}`.
- [x] Updated the stale `internal/egress/proxy.go` package doc.
- [x] Tests: block-list precedence (`proxy_test.go`), mode derivation +
      strict/blocked carry (`network_filter_test.go`), egress mode branches.

Remaining polish (optional, not blocking Step 2):
- [ ] Make "advisory" read as *downgraded* in the running-head UI (currently the
      EgressMode badge shows the active mode but doesn't emphasise the downgrade).

## Step 2 — MCP server allow-list UI (ahead-of-time path) ✅

Goal: make the server whitelist manageable and reach new + resumed agents.

- [x] `sandbox.ListMCPServers(claudeJSON, mcpJSON)` enumerates candidate servers
      (host `~/.claude.json` top-level + `projects[*].mcpServers`, and project
      `.mcp.json`), de-duplicated, name-sorted, source-tagged (user/project). Tests
      in `agentcfg_test.go`. Surfaced read-only on `ConfigResponse.mcp_servers` (the
      GetConfig handler reads the host/project files best-effort).
- [x] Exposed `policy` on the API `AgentConfig` (gate_enabled, mcp_allowed,
      webfetch_allow_hosts), mapped both directions in handlers.go.
- [x] Settings-page picker in `ConfigForm.tsx`: an "MCP Servers" card with a checkbox
      per discovered server (+ source badge), any allow-listed-but-not-found names
      shown checked, and a free-text "allow by name" input — all writing
      `policy.mcp_allowed`.
- [x] Apply-on-resume messaged in the card tooltip (MCP config is launch-time →
      applies on next launch/resume; `ResumeHead` re-seeds from config).
- [x] Simulation seeds `mcp_servers` + a claude `mcp_allowed` + `network.mode=hard`
      so the settings screenshots exercise the new picker and mode UI.

## Step 3 — Per-tool gating + read/write ✅

Goal: gate individual tools within an allowed-to-run server; show read/write.

- [x] `MCPToolsAllowed []string` (entries `"<server>__<tool>"`) on `gate.Policy` and
      `config.PolicyConfig` (+ `Merge`, spec entry, emit). `MCPAllowed` still = whole-
      server grants.
- [x] `gate.Decide`: whole-server → per-tool → optional auto-allow-read → park. A
      partially-allowed server parks per-tool (`Kind:"mcp_tool"`, Target
      `"<server>__<tool>"`); an otherwise-unknown server still parks whole-server
      (`Kind:"mcp"`). `mcpServerTool()` + `serverReferenced()` helpers.
- [x] `rememberApproval`: `case "mcp_tool"` → append to `MCPToolsAllowed`.
- [x] **Strip keep-set is a union** (`heads.mcpKeepSet`): `MCPAllowed` ∪ the server
      segment of every `MCPToolsAllowed` entry, passed to `BuildClaudeSettings` /
      `BuildClaudeConfig`, so a partially-allowed server is kept and gated per-tool.
- [x] read/write: `gate.ClassifyMCPTool` — a **best-effort leading-verb heuristic**
      (get/list/search… = read; create/delete/update… = write). `rw` flows through
      `gate.Result` → `gate.Request` → `api.ApprovalRequest.rw` → the approval toast
      summary ("… (write)"). Tests for the classifier + per-tool Decide.
      - [ ] DEFERRED: true `readOnlyHint` capture via a Go MCP client (spawn server →
            `tools/list`), cached in `.hydra/cache/`. Heuristic is the interim signal;
            noted as not-a-guarantee in the UI.
- [x] `mcp_auto_allow_read` policy toggle (off by default) — auto-allows read-classified
      tools, parks writes/unknown. Flagged as heuristic in the UI tooltip.
- [x] UI: ConfigForm MCP card gains a per-tool (`server__tool`) list editor + the
      auto-allow-read toggle. Simulation seeds per-tool grant + an `mcp_tool` approval
      with a write badge.

## Step 4 — Runtime MCP request flow (custom tool) ✅

Goal: let the inner agent discover + request a server mid-task, gated by a toast.

- [x] `internal/mcpserver` — a minimal MCP stdio server (newline-delimited JSON-RPC:
      initialize/ping/tools/list/tools/call) exposing `list_available_mcp_servers` and
      `request_mcp_server(name)`. Fully unit-tested at the JSON-RPC level.
- [x] `hydra mcp <agentType>` CLI (`internal/cli/mcp.go`) wires it: the catalog comes
      from a seeded read-only file (host `~/.claude.json` + project `.mcp.json` via
      `sandbox.ListMCPServers`, minus already-allowed), and a request is restricted to
      servers in that catalog — never arbitrary.
- [x] `request_mcp_server` → `gate.WriteRequest` (`kind:"mcp"`, target=name) via the
      approval dir, re-stamping the approval status while it polls the decision file —
      so it surfaces as the normal approval toast and reuses the whole gate channel.
- [x] Seeded as the always-present `hydra` MCP server (`BuildClaudeConfig` injects it
      after stripping; `gate.Decide` auto-allows server `hydra`); catalog bound
      read-only + `HYDRA_MCP_CATALOG_PATH`. Pre-prompt tells the agent about the tools.
- [x] On approval the user's "always allow" appends to `mcp_allowed` (existing
      `rememberApproval`); the tool tells the agent the server is available after a
      resume (MCP config is launch-time; `ResumeHead` re-seeds).

Deferred (documented, non-blocking):
- [ ] AUTO-restart-with-`--continue` on approval (seamless reload). Currently the grant
      persists and applies on the next resume, which the tool result explains; wiring
      the daemon to kill+resume the head the moment the approval lands (so the agent
      doesn't have to be manually resumed) is a follow-up. Needs care: the requesting
      tool call is mid-poll when the restart fires.
- [ ] End-to-end verification with a real Claude client (protocol version/handshake) —
      the server is unit-tested but not exercised against Claude in this environment
      (no bwrap/userns here).

---

## Progress log

- 2026-07-01 — Plan written and committed. No implementation yet. Starting with
  Step 1 next (default allow-list is a prerequisite for any filtered default).
