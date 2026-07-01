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

## Step 3 — Per-tool gating + read/write

Goal: gate individual tools within an allowed-to-run server; show read/write.

- [ ] Add `MCPToolsAllowed []string` (entries `"<server>__<tool>"`) to `gate.Policy`
      and `config.PolicyConfig` (+ `Merge`). Keep `MCPAllowed` for whole-server grants.
- [ ] `gate.Decide`: after server-level check, check `MCPToolsAllowed`; else
      `Ask{Kind:"mcp_tool", Target:"<server>__<tool>"}`. Add `mcpServerTool()` helper.
- [ ] `rememberApproval` (`internal/http/approvals.go`): `case "mcp_tool"` →
      append to `MCPToolsAllowed`.
- [ ] **Strip keep-set becomes a union:** a server with *some* tools allowed must be
      kept (spawned) and gated per-tool at runtime; only servers with zero grants are
      stripped. Update `BuildClaudeConfig`/`BuildClaudeSettings` to take the tool list.
- [ ] read/write capture: introspect each allowed server (`initialize` → `tools/list`),
      cache the catalog + `readOnlyHint` in `.hydra/cache/` keyed by server cmd+version
      (mirror the gemini-prompt-capture pattern). Needs a small Go MCP client.
- [ ] Expose `rw` (`read|write|unknown`) on `gate.Request` + `api.ApprovalRequest`
      (openapi.yaml → regen `server.gen.go` + TS client) → read/write badge on the
      approval card + the settings tool list.
- [ ] Optional policy toggle `mcp_auto_allow_read` (auto-allow read-only tools, ask on
      write/unknown) — flagged as trusting server self-reporting.

## Step 4 — Runtime MCP request flow (custom tool)

Goal: let the inner agent discover + request a server mid-task, gated by a toast.

- [ ] Ship an always-allow-listed Hydra MCP server (or reuse the gate file channel)
      exposing `hydra__list_available_mcp_servers` and `hydra__request_mcp_server(name)`.
      Restricted to servers the host has configured (never arbitrary).
- [ ] `request_mcp_server` → `gate.WriteRequest` (`kind:"mcp"`, target=name) via the
      approval dir (daemon socket is unreachable in-sandbox; the file channel works).
- [ ] On approval: host appends to `mcp_allowed`, then **restarts the agent with
      `--continue`** (kill session → re-seed with server un-stripped → `ResumeHead`).
- [ ] Resume-time message telling the agent "MCP server `<name>` is now available"
      (the requesting tool call is interrupted by the restart — design the outcome
      message, not a synchronous return).
- [ ] Persist granularity: "always allow" = append to whitelist (natural for MCP);
      note one-shot means "this session only, stripped again next cold start".

---

## Progress log

- 2026-07-01 — Plan written and committed. No implementation yet. Starting with
  Step 1 next (default allow-list is a prerequisite for any filtered default).
