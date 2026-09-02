# Security audit — Hydra agent-head sandboxing

Scope: how Hydra launches and confines agent "heads" (Claude / Gemini / Copilot /
Codex), the `--dangerously-skip-permissions` posture, the role of tool hooks, and
MCP governance. Compared throughout against the reference `claude-sbx` wrapper
(`~/.dotfiles/bin/os/linux/claude-sbx`), which takes the opposite design stance.

Date: 2026-06-28 · Branch: `hydra/about-the-security-of-this-agent-head`

---

## TL;DR

Hydra's OS sandbox is solid and thoughtfully built (bwrap + seccomp + GUI
hardening + masked credentials + network toggle). The weakness is **everything
above the OS boundary**: every agent runs with its permission gate fully
disabled (`--dangerously-skip-permissions` / `--approval-mode=yolo` / `--yolo` /
`--dangerously-bypass-approvals-and-sandbox`), the hooks Hydra wires in are
**observe-only** (they report status and never deny), there is **no MCP
governance**, and **network egress is unrestricted and on by default** while the
**provider credentials the agent needs are necessarily readable**. So the OS
sandbox is the *single* line of defense, and within it a prompt-injected or
malicious-branch agent has free, silent rein — including exfiltrating the user's
Claude/Gemini/GitHub tokens.

`claude-sbx` makes the opposite tradeoff: it keeps Claude's permission gate **on**
and uses a PreToolUse hook to force every command through a sandbox, declaring
network / writable / credential needs per-command. Hydra should adopt that
defense-in-depth idea — and the hook plumbing to do it **already exists**; it
just needs to make decisions instead of only observing.

The three things that **should** change: (1) make hooks able to *gate*, not just
watch; (2) add an MCP allow-list the user controls; (3) get real egress control
(default-off network or a host allow-list). Details and priorities below.

---

## What Hydra does today (the model)

- **Boundary:** `internal/sandbox/linux.go` `BuildSpec` — read-only `/`, fresh
  `/dev` `/proc` `/tmp`, `--unshare-pid/ipc/uts`, `--die-with-parent`, a curated
  set of writable binds, masked credential paths, optional `--unshare-net`, and a
  seccomp blob. `HardenGUI` and `Seccomp` are **on** for every agent launch
  (`internal/heads/heads.go:471,768`). This part is good.
- **Permission posture:** `sandbox.AgentArgv` (`internal/sandbox/agentcfg.go:185`)
  hardcodes the bypass flag for every agent, on spawn **and** resume:
  - Claude `--dangerously-skip-permissions` + `skipDangerousModePermissionPrompt:
    true` in seeded settings (`agentcfg.go:74`)
  - Gemini `--approval-mode=yolo`
  - Copilot `--yolo`
  - Codex `--dangerously-bypass-approvals-and-sandbox`
- **Hooks:** `BuildClaudeSettings`/`BuildGeminiSettings`/`BuildCopilotHooks`
  register Hydra on essentially every lifecycle event, all pointing at
  `hydra trigger-hook <agent>`. But `runTriggerHook`
  (`internal/cli/trigger_hook.go`) only **writes status files** and explicitly
  "writes nothing to stdout, so the permission flow proceeds unchanged"
  (line 278). It always exits 0. **No hook can currently deny, ask, or rewrite a
  tool call.**
- **Credentials:** masked = ssh, aws, azure, gnupg, docker, kube, pass, netrc,
  git-credentials, npmrc, pypirc, shell history, `~/.config`
  (`internal/sandbox/defaults.go`). But the **agent provider dirs are writable**
  (`~/.claude`, `~/.claude.json`, `~/.gemini`, `~/.copilot`, `~/.codex`) because
  the agent authenticates from them, and `~/.config/gh` is **restored read-only**
  (GitHub OAuth token).
- **Network:** defaults to **enabled** (`ResolveSandboxOptions`,
  `config.go:587`). `AllowedHosts` was parsed from config but **never enforced** at
  audit time — `sandbox.go:36` called it "reserved for a future proxy-based host
  allow-list," and neither `linux.go` nor `darwin.go` read it, so network was
  all-or-nothing. *(Now fixed: `internal/egress` enforces `AllowedHosts` via a
  per-head filtering proxy — hard netns boundary where pasta+nft are available,
  advisory proxy otherwise. See the implementation-status callout under
  "Recommendations.")*
- **MCP:** not handled anywhere. No code references MCP. Whatever the seeded
  `~/.claude.json` or a branch's `.mcp.json` declares is loaded, and under
  skip-permissions it is auto-trusted.

---

## `claude-sbx` — the contrast

`claude-sbx` launches an **ordinary** Claude session (gate ON) and layers in,
session-scoped via `--settings`:

- A `PreToolUse` **gate hook** (`sbx-gate-hook`) that **denies** any raw Bash that
  isn't routed through the `sbx` sandbox, returning `permissionDecision: "deny"`
  with a message telling the model to re-issue it wrapped. Only a tiny
  navigation/identity allow-list runs raw.
- A guidance system-prompt that teaches the model to declare intent
  per-command: `sbx-default` (read-only FS, no net, masked creds) by default, and
  to **escalate explicitly** with `--with-net` / `--with-rw <path>` /
  `--with-ro <cred>` — each of which **prompts the user**.

The philosophy difference that matters for this audit:

| | `claude-sbx` | Hydra head |
|---|---|---|
| Agent permission gate | **on** (defense-in-depth) | **off** (bypass flag) |
| Hook role | **decides** (deny/rewrite) | **observes** only |
| Grant model | **per-command**, least-privilege, prompts | **per-session**, broad, static |
| Network | **off by default**, opt-in per command | **on by default**, unrestricted |
| Policy location | inline `--settings` arg (model can't edit) | writable `~/.claude/settings.json` |

Hydra deliberately chose a heavier OS jail so it *can* run unattended — that's a
legitimate reason to skip per-command prompts. But it threw out the
defense-in-depth with it, and the OS jail leaves the provider tokens + open
network in reach.

---

## Findings

### F1 — The OS sandbox is the *only* boundary (High)
With the gate bypassed and hooks observe-only, nothing between "the model decided
to do X" and "X runs" can say no. Any prompt injection (malicious repo content, a
poisoned dependency, a crafted issue/PR the agent reads) executes immediately and
silently inside the worktree, the dev caches, and the git common dir — all
writable. There is no audit-time veto and no per-action user visibility.
**This is the root issue; F2–F4 are what it exposes.**

### F2 — Provider tokens are exfiltratable; network is open by default (High)
The sandbox carefully masks ssh/aws/gnupg/etc., but the credentials the agent
*uses* can't be masked — `~/.claude.json`, `~/.gemini`, `~/.codex`,
`~/.copilot` are readable, and `~/.config/gh` (GitHub OAuth) is RO-restored, so
`gh auth token` works. Network defaults on with **no egress filter**
(`AllowedHosts` is a no-op). Net result: a compromised agent can read the user's
LLM-provider and GitHub tokens and POST them anywhere — no prompt, no log the
user reads. The masking gives a false sense of safety because the *most
abusable* tokens in the box are the unmaskable ones. `claude-sbx` mitigates this
by defaulting network **off** and scrubbing secret-looking env vars unless asked.

### F3 — No MCP governance (High, and the user's explicit concern)
Nothing constrains MCP. A branch's `.mcp.json` sits in the writable worktree, and
`~/.claude.json` is writable too; under `--dangerously-skip-permissions` Claude
does not prompt to trust MCP servers. An MCP server is arbitrary code + network
inside the sandbox, auto-loaded from attacker-controllable files. There is no
allow-list, no user approval step, and no UI surfacing of "this head wants to use
MCP server X." Contrast the **artifacts** subsystem (`internal/artifacts`), which
already gets this trust model right: a branch "cannot grant *itself* host access"
— `unsafe_host` is honored only when the *trusted live config* authorizes that
exact command. MCP needs the same "trusted config decides, branch can't
self-authorize" gate.

### F4 — Security-relevant policy lives in a writable file (Medium)
The seeded `~/.claude/settings.json` is bound **writable** (`seed.go:105`, no
`ReadOnly`). Today that only lets an agent disable its own status reporting. But
it means any policy you enforce *through that file* is not tamper-proof — the
agent (or a malicious branch's session) can rewrite it. `claude-sbx` avoids this
by passing policy as an **inline `--settings` string**, which the model can't
edit. Any future gate hook must live somewhere the agent can't reach (inline arg,
or a read-only bind), not in writable `$HOME`.

### F5 — Grants are broad and static, intent is lost (Medium)
Hydra grants one fixed, fairly wide policy for the whole session (all dev caches
writable, network all-or-nothing). `claude-sbx` makes each command declare the
narrowest thing it needs. Hydra can't get fully per-command without prompts (it
runs unattended), but it can get **narrower defaults** and **per-head** scoping,
and it can *record* intent (every `PreToolUse` is already logged to
`status_log.jsonl` — that data is captured but not surfaced or acted on).

### Positives (keep these)
- bwrap config is careful and well-commented; seccomp + GUI hardening +
  die-with-parent + namespace isolation on by default.
- Credential masking list is broad and sensible.
- Codex's own sandbox is bypassed **deliberately** (it's already inside Hydra's).
- The artifacts trust model (branch can't self-grant host access) is a good
  template to copy for MCP.
- Every hook event is already captured to `status_log.jsonl` — the raw material
  for a UI activity feed and for gating decisions already flows.

---

## Is `--dangerously-skip-permissions` an issue?

Yes, but not on its own — it's an issue *because of what's left reachable behind
it*. The flag is defensible for unattended runs **iff** the box behind it is
genuinely safe to hand to an untrusted prompt. Right now it isn't: open network
+ readable provider/GitHub tokens + auto-loaded MCP means "bypass the gate"
currently equals "bypass the gate *and* hand over an exfiltration channel and the
keys." Fix F2/F3 (or add a gate per F1) and the bypass becomes a reasonable
unattended posture. Don't just flip the flag off — that breaks the unattended
model Hydra is built around; instead make the sandbox behind it actually
contained, and/or add a *non-interactive* hook gate that can deny without a human
in the loop.

---

## Recommendations

> **Implementation status (2026-06-28).** All three "Should change" items below
> are now implemented for Claude (the gate hook is Claude-first; non-Claude agents
> still get config-level MCP stripping only). Specifically:
> - **Rec 1 (gate):** `internal/gate` + `hydra gate` — a decision-capable
>   PreToolUse hook driven by a read-only, trusted `policy.json` that can deny
>   (policy-file writes, credential reads, non-allow-listed MCP, global installs)
>   or park-for-approval (unknown MCP/WebFetch host, `git push`). The hooks live
>   in **managed settings** (`/etc/claude-code/managed-settings.json`) — the only
>   scope whose hooks survive a `disableAllHooks` write, so the gate is
>   tamper-proof, not merely read-only (F4). (`--settings` was considered and
>   rejected: it is defeatable by a writable project settings.json.) That path is
>   fixed and lives under the read-only `/` bind, so it is exposed via a **read-only
>   overlay over `/etc`** (a `--tmpfs` mountpoint can't be created there — EROFS);
>   this needs an overlay-capable bwrap, and degrades (managed hooks absent, logged)
>   if one isn't available, same as the Rec 3 fallback.
> - **Rec 2 (MCP):** pre-launch stripping of non-allow-listed `mcpServers` from the
>   seeded `~/.claude.json` + `enabledMcpjsonServers`/`enableAllProjectMcpServers`,
>   runtime gate backstop, and a web approval card (allow / always-allow / deny)
>   that persists "always" to the trusted config.
> - **Rec 3 (egress):** `internal/egress` — a per-head HTTP/HTTPS filtering proxy
>   enforcing `allowed_hosts`. When `pasta` (with `--map-host-loopback`) + `nft`
>   are present and a runtime smoke test passes, the head runs in a pasta network
>   namespace whose nft ruleset drops all egress except to the proxy — an
>   **inescapable** boundary (agent runs caps-dropped). Otherwise it degrades to
>   **advisory** mode (proxy via `HTTP(S)_PROXY` — filters every well-behaved
>   client but a determined process can bypass it), surfaced as a UI warning.
>   `network.enabled=false` stays the hard off-switch.
>
> Policy lives in per-agent `[<agent>.policy]` / `[<agent>.sandbox.network]` config,
> resolved from the trusted project root. The original audit follows unchanged.

### Should change (do these)

1. **Make hooks decision-capable — the key lever (F1).**
   `trigger-hook` already runs on `PreToolUse`/`PermissionRequest` with the full
   payload. Add a policy mode where it can emit
   `{"hookSpecificOutput":{"permissionDecision":"deny"|"ask", ...}}` on stdout
   instead of staying silent. That single change turns the existing observe-only
   plumbing into an enforcement point — no new agent flags, works for Claude and
   Copilot (Gemini/Codex need their own mechanism). Policy must be driven by the
   **trusted live config**, not the branch (mirror the artifacts gate).

2. **MCP allow-list the user controls (F3).**
   - Default-deny MCP servers not on a user-approved list. Detect MCP tool calls
     in the hook (`tool_name` like `mcp__<server>__<tool>`) and deny unknown
     servers; and/or strip unrecognized servers out of the seeded `~/.claude.json`
     and refuse to auto-trust a branch's `.mcp.json`.
   - **Surface pending MCP servers in the web UI** for explicit approval (the user
     asked for exactly this). The head view can show "head X wants MCP server Y —
     allow / deny," persisted to the trusted config so the branch can't
     self-approve.

3. **Real egress control (F2).**
   Pick one, ideally both: (a) default agent network to **off**, opt-in per head
   in config (matches `claude-sbx`); and/or (b) actually implement `AllowedHosts`
   via a filtering proxy so "network on" isn't "exfiltrate anywhere." Until one
   exists, at minimum document loudly that network-on = full exfil channel with
   provider + GitHub tokens in reach.

### Could change (hardening)

4. **Bind security-relevant settings read-only / inline (F4).** Move policy hooks
   out of writable `$HOME` — inline `--settings` (like `claude-sbx`) or a
   `ReadOnly: true` bind — so the agent can't neuter its own gate. (Leave the
   status-reporting hooks writable if you like; just don't put *enforcement*
   there.)

5. **Scope the provider token (F2, harder).** Where feasible, inject a
   short-lived / proxied credential instead of binding the raw OAuth token, so a
   read of `~/.claude.json` doesn't yield a reusable secret. High effort, high
   payoff; track as a stretch goal.

6. **Surface tool activity in the UI (F1/F5).** Every `PreToolUse` is already in
   `status_log.jsonl`. Render a per-head activity feed (commands run, files
   touched, network/MCP attempts) so the user has visibility into an unattended
   head without reading logs. Cheap, high trust value.

7. **Tighten default writable scope (F5).** Review whether every entry in
   `Defaults().WritablePaths` needs to be writable by every agent type, and
   prefer per-head COW (already supported via `cow_paths`) over shared writable
   caches where a poisoned cache could affect later runs.

### Suggested priority order
F1 hook-gate → F3 MCP allow-list + UI → F2 egress → F4 read-only policy →
F6 activity UI → F5/F7 scope tightening → F2 token scoping (stretch).

---

## Recommendation 1 in detail — the gate policy

What the decision-capable hook should actually **deny / allow / ask**. Design
principle first, because a gate that adjudicates *everything* either stalls every
unattended run or gives false confidence.

### Principle

- **Default = allow** for unrecognized tools/commands. Fail-*open*: the OS sandbox
  confines the blast radius, and a fail-closed gate would block every new tool an
  agent learns.
- **Fail-closed (default deny) only for MCP**, where an allow-list is the point.
- **Reserve "ask"** for rare, high-impact, plausibly-legitimate actions — "ask"
  parks the head in `waiting` until a human responds in the UI, which is expensive
  for unattended runs.
- **Cache every decision** in trusted config keyed by (project, agent,
  server/host) so a head never asks twice for the same thing.
- **Decisions come from the trusted live config, never the branch** — the same
  rule `internal/artifacts` already enforces for `unsafe_host`.

### Policy table

The reliable decisions are on **structured tool calls** (MCP, WebFetch,
policy-file writes) where the payload gives a clean signal.

| Tool / signal | Decision | Why |
|---|---|---|
| Read/Write/Edit **inside worktree + dev caches** | allow | sandbox already confines it |
| Write/Edit to **policy files** (`~/.claude/settings.json`, `.claude/settings.json`, `.mcp.json`, `.github/hooks/*`) | deny | stops the agent neutering its own gate (F4) |
| Read of **reachable creds** (`~/.claude.json`, `~/.config/gh`, provider dirs) | deny | agent rarely needs to read its own tokens; a read is the exfil setup step |
| `mcp__<server>__<tool>`, server **on allow-list** | allow | user pre-approved it |
| `mcp__<server>__<tool>`, server **unknown** | ask → remember | "let the user decide"; approval persists to trusted config |
| `mcp__<server>__<tool>`, server **denied** | deny | |
| `WebFetch` to **allow-listed host** | allow | |
| `WebFetch` to **new host** | ask → remember | structured URL = clean signal; main exfil channel for the tool |
| `WebSearch`, `Task`, `TodoWrite`, normal local Bash | allow | low risk / bread-and-butter |
| `git push` / force-push / remote-affecting | ask | plausibly legit but leaves the box; cheap to confirm once |
| Global/system installs (`apt`, `npm -g`, …) | deny | already forbidden by pre-prompt — enforce it |
| Unrecognized tool | allow | fail-open; sandbox is the boundary |

### MCP needs two controls, not one

A stdio MCP server is **code that executes the moment the session starts**, so
gating tool-*calls* is too late on its own:

1. **Pre-launch (the important half):** strip any MCP server not on the
   allow-list out of the seeded `~/.claude.json`, and refuse to auto-trust a
   branch's `.mcp.json`. The server never spawns.
2. **Runtime hook (the second half):** deny tool calls to servers not on the list
   — catches HTTP servers and anything added dynamically.

### Honest caveat on Bash

A string-matching Bash gate is a **tripwire, not a boundary** — anything denied by
pattern is trivially re-encoded (base64, env indirection, a compound line, a
written script). `claude-sbx` only gets away with a Bash gate because it denies
raw Bash *wholesale* and forces every command through a confining wrapper. For
Hydra, don't try to make the Bash hook airtight: put the network boundary at the
**OS layer** (F3 — default-off network or an enforced `AllowedHosts` proxy, where
it can't be base64'd around) and let the Bash hook be a logged tripwire only. The
hook earns its keep on MCP, WebFetch, push, and policy-file writes.

---

## Implementation plan for Recommendation 1

### Step 0 — Load-bearing facts (verified against Claude Code docs)

- ✅ **PreToolUse hooks fire before the permission-mode check, and a hook
  `permissionDecision: "deny"` blocks the tool even under
  `--dangerously-skip-permissions`.** Hook denials are independent of the bypass
  flag — so the gate works on Hydra's current launch mode unchanged.
- ⚠️ **`permissionDecision: "ask"` is a silent no-op under bypass** — it defers to
  the interactive prompt, which the flag suppresses, so the action *proceeds*.
  Hydra's web terminal has no interactive approve UI anyway. **Therefore "ask" is
  implemented by the hook process BLOCKING** until a decision arrives from the UI,
  then emitting `allow`/`deny`. Never emit `"ask"`.
- ✅ Command-hook timeout is **10 min** (configurable per-hook via `"timeout"`),
  with no interrupt of a long-running decision loop — a blocking ask is supported.
  Set a deliberate ask timeout (e.g. 5 min) that **defaults to deny** on expiry.
- ⚠️ **Project `.mcp.json` servers still require interactive approval even under
  bypass** → a malicious branch's `.mcp.json` is *already inert* headless. The
  live MCP vector is the **seeded `~/.claude.json` (user scope), which Hydra
  controls** — so pre-launch stripping there is the high-value fix.
- ✅ MCP tool calls are `mcp__<server>__<tool>` (plugins:
  `mcp__plugin_<plugin>_<server>__<tool>`); hook matchers can target `mcp__.*`.

### Step 1 — Trusted policy config (`internal/config/config.go`)

Add a per-agent policy table (sibling to `Sandbox` on `AgentConfig`), e.g.
`[<agent>.policy]`:

```toml
[claude.policy]
mcp_allowed          = ["github"]      # allow-listed MCP server names
webfetch_allow_hosts = ["docs.anthropic.com"]
gate_enabled         = true            # default true
```

- New `PolicyConfig` struct + field on `AgentConfig`; extend `Merge` and add
  `ResolvePolicy(agentType)` (mirrors `ResolveSandboxOptions`).
- **Trust boundary:** the gate reads policy from the **project-root**
  `config.toml` (what `config.Load(projectRoot)` returns — the same "trusted live
  config" `internal/http/artifacts.go` already relies on), **never** the worktree
  copy a branch can edit. Cleanest delivery: the daemon resolves the policy on the
  host at launch and seeds it as a **read-only** `policy.json` bind (same
  mechanism as the settings bind in `seed.go`), so the in-sandbox hook just reads
  a file and never parses the branch's TOML.
- "Remembered" approvals are written back here by the **daemon** (host side) via
  `config.Save`, then re-seeded next launch.

### Step 2 — The gate command (`internal/cli/gate.go`, new)

A dedicated `hydra gate <agent>` command wired as a **second** PreToolUse hook
(leave `trigger-hook` registered for status — Claude runs both, and any deny
wins). Keeping them separate preserves trigger-hook's exit-0/silent contract for
every other event.

- Read the hook JSON from stdin; pull `tool_name` + `tool_input`.
- A **pure decision function** `decide(policy, tool, input) -> {allow|deny|ask, reason}`
  implementing the policy table. Pure + table-driven = trivially unit-testable.
- Output: `deny` → emit the deny JSON on stdout, exit 0. `allow` → just exit 0
  (silent = proceed). `ask` → run the Step 4 round-trip, then emit allow/deny.
- Deny rules needing **no** round-trip (ship first):
  - `Write`/`Edit` whose `file_path` is a policy file
    (`~/.claude/settings.json`, `.claude/settings.json`, `.mcp.json`,
    `.github/hooks/*`) → deny (anti-self-neuter, F4).
  - `Read` of reachable creds (`~/.claude.json`, `~/.config/gh`, provider dirs)
    → deny.
  - `mcp__<server>__*` where `<server>` ∉ `mcp_allowed` → deny.
  - Bash matching global-install patterns (`apt`, `npm i -g`, …) → deny.

### Step 3 — Pre-launch MCP stripping (`internal/sandbox/agentcfg.go`, `seed.go`)

- Extend `BuildClaudeConfig` to take the allow-list and **drop any `mcpServers`
  entry not on it** from the seeded `~/.claude.json` (so non-allow-listed
  user-scope servers never spawn).
- In `BuildClaudeSettings`, set `enabledMcpjsonServers` to the allow-list (and
  `enableAllProjectMcpServers: false`) so allow-listed project servers are usable
  without the interactive prompt Hydra can't answer, and everything else stays
  inert.
- Net: branch `.mcp.json` is inert by default (Step 0); the seeded user-scope
  config is filtered to the allow-list; runtime hook (Step 2) is the backstop.
- ⚠️ **The filtered config is a bind mount over a file the host still owns, and
  that bind is not permanent**: anything host-side that replaces `~/.claude.json`
  by `rename()` (which is how Claude Code saves its own config) drops the mount
  from every running head's sandbox, and the path falls through to the host's
  real, unfiltered config. So filtering is best-effort and the runtime gate is
  what actually holds. It also cost the agent its hydra tools until the control
  server moved into argv (`--mcp-config`, `sandbox.claudeMCPConfigArgs`).
- ✅ **Strict mode (`policy.strict_mcp`, on by default) replaces filtering with
  substitution** and is the form that holds: `sandbox.BuildStrictMCPConfig`
  renders the allow-listed servers + the control server into a per-head file,
  seeded read-only under the head's own `/tmp` (a path no host process shares),
  and the head launches with `--mcp-config <file> --strict-mcp-config`. The
  host's `~/.claude.json` and the branch's `.mcp.json` are then not consulted at
  all, so there is nothing to detach. Servers are copied verbatim, so http/sse
  transports survive - `MCPServerSpecs` (stdio-only, for tool-annotation
  introspection) is deliberately not reused here.
  **Cost:** claude.ai account connectors (Gmail/Calendar/Drive) are part of "all
  other MCP configurations" and go away with it. They cannot be re-declared:
  they use an account-authenticated internal transport, and declaring their proxy
  URL as a plain http server fails OAuth discovery (`HTTP 404: Invalid OAuth
  error response`, spike-verified). An agent that needs them sets
  `strict_mcp = false` and falls back to the filtered-config posture above.

### Step 4 — The "ask" round-trip (reuse the file-polling channel)

The daemon socket is **not** reachable in-sandbox (`HardenGUI` tmpfs's
`XDG_RUNTIME_DIR`), so reuse the proven "hook writes a host-writable file / daemon
polls / web via the events Hub" pattern already used for `status.json`:

- **Hook side (in sandbox):** on `ask`, write a request record
  `{reqid, tool, server/host, summary, ts}` to a per-head writable file
  (`HYDRA_APPROVAL_REQ_PATH`, seeded + made writable exactly like
  `HYDRA_STATUS_PATH` in `seed.go`); set `status.json` to `waiting` with a new
  `notificationType: "policy_approval"` so the existing poller flags it as
  immediate-unread. Then poll `HYDRA_APPROVAL_DECISION_DIR/<reqid>.json` until
  present or timeout; emit allow/deny; **timeout → deny**.
- **Daemon/API side (host):** the 1 s `RunJSONStatusPoller` (`heads/poller.go`)
  already runs — extend it (or add a sibling watcher) to detect pending request
  files and push an event over the `events.Hub`. New endpoint
  `POST /api/heads/{id}/approvals/{reqid}` `{decision, remember}` writes the
  decision file the hook is polling; if `remember`, append the server/host to the
  trusted config via `config.Save`.

### Step 5 — Web UI (`web/src/components/AgentDetail.tsx`)

- When a head is `waiting` with `notificationType: "policy_approval"`, render an
  approval card: *"Head X wants to use MCP server Y / fetch Z / git push"* with
  **Allow / Deny / Always allow** → calls the new endpoint.
- Spec-first: add the endpoint + payload to `api/openapi.yaml`, then
  `mage generate:go` (server stub) and regen the TS client (per CLAUDE.md /
  memory regen flow).

### Step 6 — Make the gate tamper-proof (F4)

Bind the seeded `settings.json` **read-only** (`ReadOnly: true` in the `seed.go`
bind), or pass the gate hooks inline via `--settings` in `AgentArgv` (the
`claude-sbx` approach), so an agent can't edit `settings.json` to remove its own
gate. Verify Claude reads a read-only `settings.json` cleanly.

### Step 7 — Tests

- Table-driven unit tests for `decide(...)` (the bulk of the value, pure fn).
- `BuildClaudeConfig`/`BuildClaudeSettings` MCP-stripping tests.
- Config merge/resolve tests for `PolicyConfig`.
- Round-trip integration test: write request → write decision → assert hook
  output; and the timeout-defaults-to-deny path.

### Step 8 - Scope & sequencing

- **Claude and Codex.** Both providers now receive the runtime gate through
  `PreToolUse`, and both have their user-level MCP configuration filtered before
  launch. Gemini (`BeforeTool`) and Copilot (`preToolUse`) hooks exist, but their
  deny semantics still need their own verification. Until then, those providers
  do not receive the runtime gate.
- **Milestones:**
  - **M1 (no UI, highest value):** Steps 1–3 + 6. Pre-launch MCP stripping +
    deny-only gate (policy-file writes, cred reads, non-allow-listed MCP, global
    installs) + read-only settings. "ask" cases temporarily **deny** with a clear
    message. Closes the exfil + self-neuter surface immediately.
  - **M2:** Step 4–5. Turn deny-only asks into ask→remember with the UI.
  - **M3:** WebFetch host gating + `git push` gating + the F6 activity feed
    (the `status_log.jsonl` data is already captured).
  - **M4:** extend the runtime gate to Gemini/Copilot. Egress control (F3) is a
    separate, parallel track.

---

*Note: the original audit was a recommendation document only. The three "Should
change" recommendations (gate, MCP allow-list + approval UI, filtering egress
proxy) have since been implemented for Claude, with the gate and MCP filtering
also implemented for Codex - see the implementation-status callout under
"Recommendations" above and the commit history.*
