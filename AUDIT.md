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
  `config.go:587`). `AllowedHosts` is parsed from config but **never enforced** —
  `sandbox.go:36` calls it "reserved for a future proxy-based host allow-list,"
  and neither `linux.go` nor `darwin.go` reads it. So network is all-or-nothing.
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

*Note: this is an audit/recommendation document only — no behavior was changed.*
