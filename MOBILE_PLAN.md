# Mobile / Small-Screen Plan

How to make Hydra's web UI usable on phones and other narrow viewports.

## TL;DR

There are **two separable problems**, and they should be tackled in that order:

1. **Responsive layout** — the SPA is desktop-first (always-on sidebar, fixed-size
   terminal panel, side-by-side diff, mouse-only drag handles). This is pure
   frontend work, benefits **every** agent type, and needs no backend changes.
2. **Interaction model** — the live terminal (`xterm` over a raw PTY WebSocket) is
   genuinely hostile on a phone: tiny text, no real soft-keyboard affordances,
   fragile resize, painful copy/paste, no scroll-to-bottom. The fix is a
   **message/chat view** that renders the conversation as bubbles and sends
   prompts as discrete messages.

The good news for (2): **Hydra already records the conversation.** Hooks write
assistant messages + tool activity to `.hydra/status/<id>.json` and
`status_log.jsonl`, and the underlying CLI keeps a full session transcript on
disk. We can render a chat view from data we already have and keep sending input
through the existing stdin path — without changing how agents run. A fully
structured headless driver (`stream-json` / Agent SDK) is a later, optional
upgrade.

---

## Current architecture (what we're working with)

### Frontend (`web/`)
- **Stack**: React + TanStack Router (file-based routes) + Tailwind CSS v4 + Zustand. Vite/SWC build.
- **Layout** (`src/routes/__root.tsx`): two-column flex — fixed left sidebar
  (264px, drag-resizable 160–600px) + `flex-1` main. Header is a single 48px row.
- **Terminal** (`src/components/AgentTerminal.tsx`): `@xterm/xterm` + `FitAddon`,
  connected to `ws://…/ws/projects/{p}/agents/{a}/terminal`. Binary frames are raw
  PTY bytes; JSON frames carry `STATUS` / `DIFF_REFRESH`. Lives in a fixed-height,
  drag-resizable panel (default 450px). Bash tabs open extra WS connections.
- **Diff** (`src/DiffViewer.tsx`, ~2.4k lines): side-by-side, syntax-highlighted,
  does **not** reflow to single column on narrow screens.
- **Responsive coverage today**: a few `sm:`/`md:` `hidden` toggles only; no
  collapsible sidebar, no single-column mode, drag handles are mouse-only.
- **API client**: generated from `api/openapi.yaml` into `src/api/` (fetch-based).
  Server events pushed over `ws://…/ws/events`.

### Backend (`internal/`)
- Agents run as **interactive CLI subprocesses inside a PTY** (Claude/Gemini/
  Copilot/bash), under an OS sandbox. **No** Anthropic API/SDK or `stream-json`
  usage today (confirmed: no `--print`/`--output-format`/SDK imports).
- **PTY plumbing**: `internal/session/registry.go` (scrollback ring + multi-attacher
  fan-out + resize) ↔ `internal/http/terminal.go` (WS handler: stdin in, binary out,
  status/diff-refresh events).
- **Status**: CLI hooks run `hydra trigger-hook …` on `SessionStart`,
  `PreToolUse`, `PostToolUse`, `Stop`, `SessionEnd`, etc. → write
  `.hydra/status/<id>.json` + append `status_log.jsonl`. A 1s poller
  (`internal/heads/poller.go`) syncs to the DB; `internal/heads/activity.go` tails
  the log to derive "Editing foo.go" / "$ go test" style activity and the last
  assistant message (currently truncated ~300 chars).
- **Input**: `POST /api/projects/{p}/agents/{a}/input` writes text to the agent's
  PTY stdin — this is exactly how the web terminal submits a prompt.
- **REST surface already exists** for spawn / list / get / kill / purge / restart /
  merge / update-from-base / input / commits / diff / diff-files / artifacts.
- **Claude argv** (`internal/sandbox/agentcfg.go`): `claude
  --dangerously-skip-permissions [--append-system-prompt …] [--continue | -- <prompt>]`.
  Permissions are pre-skipped, so there is **no interactive approval prompt** to
  reproduce on mobile — a big simplification for a chat UI.

---

## Phase 1 — Responsive layout (no backend changes)

Goal: every existing screen is usable down to ~360px wide. Ships value immediately
for all agent types and is independent of the chat work.

> **Status (in progress):** a first pass is implemented, then reworked into a
> Claude-style shell. The global top bar is **gone**; the sidebar (`__root.tsx`)
> now carries all the chrome — its header holds the app icon, the project selector
> and a collapse button; the spawn box / Repository / agents list sit in the
> middle; and a footer holds the Settings link, Claude usage and the dev restart.
> The theme switcher moved out of the bar into an **Appearance** card on the
> Settings page (`SettingsComponents.tsx`), backed by a shared theme store
> (`lib/theme.ts`). The sidebar is collapsible on **every** size via the header
> button, a floating reveal button over the content, or **Ctrl/Cmd + .**; the
> collapse state persists. The overlay breakpoint moved from `md` (768px) to `lg`
> (1024px), so tablets in portrait and phones in landscape get a full-width
> content area with an off-canvas overlay sidebar rather than a cramped permanent
> two-column split. The agent-detail header/metadata rows wrap and padding tightens
> (`AgentDetail.tsx`), the diff drops its file-list sidebar for a full-width
> unified diff on mobile (`DiffViewer.tsx`), and the spawn form padding is
> responsive (`SpawnForm.tsx`). Screenshots now cover phone portrait/landscape,
> tablet portrait/landscape and the collapsed states — each tagged with its
> `viewport::` axis (`mobile`, `mobile-landscape`, `tablet`, `tablet-landscape`,
> `desktop`) in `web/scripts/screenshots/take-screenshots.ts`. Still outstanding: the
> repository browser's two-column tree+content layout, a shorter default terminal
> height on mobile, and touch support for the desktop resize handles (currently
> just hidden below `lg`).

1. **Collapsible sidebar / app shell.** ✅ *(done — Claude-style)*
   - No global top bar: the sidebar owns the chrome (selector + collapse button in
     its header, Settings + usage in its footer).
   - Collapsible on every size — header button, floating reveal button, or
     **Ctrl/Cmd + .**; state persists.
   - Below `lg` (1024px) the sidebar is an off-canvas overlay (so tablets/landscape
     phones aren't squeezed); at `lg+` it's the resizable in-flow column.
   - Persist open/closed; small-screen overlay closes on navigation; backdrop tap
     to dismiss.
2. **Agent detail single-column stacking** (`AgentDetail.tsx`).
   - On narrow screens stack the panels and switch terminal/diff/artifacts to
     **tabs** instead of a side-by-side split. (Sets up Phase 2's chat tab.)
   - Make the terminal panel height viewport-relative (`dvh`) rather than a fixed
     450px so the soft keyboard doesn't bury it.
3. **Diff viewer narrow mode** (`DiffViewer.tsx`).
   - Add a single-column / unified (inline) rendering path under a width threshold;
     keep side-by-side for wide screens. Ensure horizontal code scroll is contained,
     not page-wide.
4. **Touch support for drag handles.**
   - Add pointer/touch events to the sidebar and terminal resize handles (or just
     hide them on touch and rely on the tabbed/drawer layout).
5. **Header + dropdowns.**
   - Make the project dropdown and spawn form fit small widths (full-width sheet on
     mobile). Audit fixed-px popovers (e.g. 272px dropdown) for overflow.
   - Ensure tap targets ≥ 44px; verify the theme/settings/health controls collapse
     into a menu.
6. **Viewport plumbing.**
   - Confirm `<meta name="viewport">` is present; adopt `100dvh` units; respect safe-area
     insets. Add a small set of shared Tailwind breakpoints/utilities so this stays
     consistent.

**Deliverable**: existing UI (terminal included) is navigable and legible on a
phone, even if the terminal itself is still awkward to type into. That awkwardness
is what Phase 2 fixes.

---

## Phase 2 — Message/chat view from existing data (recommended core)

Goal: a phone-friendly **chat transcript + composer** that does not require the
xterm terminal, **without changing how agents run**. This is the "reads the
internals" approach.

### 2a. Read the transcript Hydra already produces
- `status_log.jsonl` already captures tool events and assistant messages — but the
  assistant message is truncated (~300 chars) and it's activity-oriented, not a
  full conversation. Good enough for a status feed, not for a real chat.
- The richer source is the **CLI's own session transcript**. Claude writes full
  per-session JSONL under `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`
  (user turns, assistant turns, tool_use/tool_result blocks). Because Hydra seeds a
  per-head `$HOME` into the sandbox, this transcript lives at a known path under the
  head's seeded home/worktree.
  - **Open question to resolve first**: confirm the exact on-disk location of that
    transcript inside the sandboxed `$HOME`, and that the daemon (host user) can
    read it. If reachable, parse it into a normalized message model.
- **Backend work**: a new endpoint, e.g.
  `GET /api/projects/{p}/agents/{a}/messages?since=<cursor>`, returning a normalized
  list (`role`, `content` blocks, `tool` name/summary, timestamps). Stream
  increments over the existing `/ws/events` channel or a dedicated WS so the chat
  updates live. Reuse the file-tailing pattern already in `activity.go`.

### 2b. Send messages through the path that already works
- The composer posts to the existing `POST …/input` endpoint, which writes to the
  agent's PTY stdin — i.e. it submits a prompt to the running interactive CLI,
  exactly as typing in the terminal does. No new agent run-mode required.
- Handle the submit convention carefully (newline / bracketed-paste / Enter timing)
  so multi-line messages don't fire prematurely; factor this out of the terminal
  component.

### 2c. Chat UI
- New `MessageView` component, surfaced as a tab in the Phase-1 tabbed agent detail
  (default tab on mobile; terminal available as an "advanced" tab).
- Render: user/assistant bubbles, collapsible tool-call cards ("Edited foo.go",
  "$ go test" with output behind a disclosure), markdown via the existing
  `lib/markdown.tsx`, code blocks, and a sticky composer with attachment support
  (reuse `/api/uploads` + `AttachmentChips`).
- Status chips from existing agent status (`running` / `waiting` / `finished`),
  plus a "thinking…" affordance while the agent works.

### Why this ordering
- Works **today**, Claude-first, with graceful degradation: agents without a
  parseable transcript fall back to the activity feed + terminal tab.
- Zero change to the sandbox/agent lifecycle, so no risk to the core orchestration.
- The terminal stays available for power users; chat is the default small-screen
  experience.

### Per-agent reality (the "other CLIs" caveat)
- **Claude**: full transcript JSONL → richest chat view.
- **Gemini**: writes its own session history; format differs — needs its own parser
  (defer; fall back to activity feed initially).
- **Copilot**: transcript format/location less clear and the CLI is mid
  protocol-transition (ACP); defer.
- **bash**: no chat concept — terminal tab only.
- Design the message model + parser layer to be **per-agent pluggable** so adding
  Gemini/Copilot later is additive.

---

## Phase 3 — Optional: true headless / structured driver (later)

If we want first-class, perfectly-structured messages (and eventually richer
control like inline approvals), introduce an **opt-in run-mode** that drives the
agent programmatically instead of through an interactive PTY:

- **Claude**: `claude --print --output-format stream-json --input-format stream-json
  --verbose` (NDJSON events: `system/init`, `stream_event` deltas, tool_use,
  result), with `--resume <session-id>` / `--continue` for multi-turn; or the
  **Claude Agent SDK** (TS/Python) for `canUseTool` permission callbacks, hooks, and
  session/`forkSession` management.
- **Gemini**: `--output-format stream-json` is roughly comparable.
- **Copilot**: `--acp --stdio` (NDJSON JSON-RPC) — verify current SDK status.

**Trade-offs (why this is Phase 3, not Phase 1):**
- Replaces/augments the PTY driver → significant change to `session`/`heads`, plus a
  new event pipeline. Higher risk to the orchestration core.
- Loses "native TUI fidelity" (agents currently run unmodified). Would likely be a
  **mode flag per agent**, not a wholesale replacement.
- Uneven cross-CLI support (Claude solid; Gemini decent; Copilot in flux) — so it
  can't be the baseline for "make it work on my phone."
- Enables features Phase 2 can't easily do: structured streaming deltas, inline
  permission prompts (if we ever stop `--dangerously-skip-permissions`), and clean
  programmatic control.

Phase 2 already delivers a usable mobile chat; Phase 3 is a quality/control upgrade
to pursue only if the transcript-parsing approach proves limiting.

---

## Suggested sequencing

1. **Phase 1** responsive shell (drawer sidebar, tabbed/stacked agent detail,
   diff narrow mode, touch handles, `dvh` sizing). Independent, immediate value.
2. **Spike**: confirm the Claude session-transcript path is readable by the daemon
   inside the seeded sandbox `$HOME`, and prototype the parser → normalized model.
   This gates Phase 2.
3. **Phase 2** messages endpoint + WS increments + `MessageView` + composer wired to
   existing `/input`. Claude-first, fallback to activity feed elsewhere.
4. **Phase 3** (optional) structured headless/SDK driver as an opt-in mode.

## Open questions
- Exact on-disk location & host-readability of the Claude session transcript inside
  the per-head sandbox `$HOME`; same for Gemini/Copilot.
- Submit semantics for writing a multi-line prompt to an interactive CLI's stdin
  (newline vs bracketed paste vs Enter) — needs verification per agent.
- Do we keep `--dangerously-skip-permissions` (no approval UI needed) or eventually
  want inline approvals on mobile (would push toward Phase 3 / SDK `canUseTool`)?
- Auth/session model for accessing the UI from a phone off the local machine
  (Hydra serves on localhost:8080 today) — out of scope here, but a prerequisite
  for real-world mobile use.
