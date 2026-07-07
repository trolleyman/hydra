# Chat mode for Claude heads

Design doc for a per-head "chat mode": instead of attaching an xterm to the
Claude CLI's interactive TUI over a PTY, Hydra drives the CLI's structured
JSON streaming interface (`--input-format stream-json --output-format
stream-json`) and renders the conversation as a proper chat view - user
bubbles, streamed assistant markdown, collapsible tool-call cards - in the
web UI.

Scope: **Claude only** for now (the other agent CLIs have no equivalent
stable JSON protocol). Terminal mode stays the default; chat mode is an
opt-in per-head toggle, settable at spawn time and changeable afterwards
(taking effect via an automatic session restart that preserves the
conversation).

---

## 1. How a Claude head runs today (baseline)

- `sandbox.AgentArgv` (`internal/sandbox/agentcfg.go:431`) builds the argv:
  `claude --dangerously-skip-permissions [--append-system-prompt <preprompt>]
  [--model <m>] [-- <prompt>]`, or `... --continue` on resume. Always the
  full interactive TUI.
- `heads.SpawnHead` (`internal/heads/heads.go:334`) seeds the head
  (`seed.go`), builds argv, and calls `startAgentSession`
  (`internal/heads/nshost.go:208`), which asks the per-worktree namespace
  host to spawn the child **on a PTY** and hands the daemon the PTY master.
- `session.Registry` (`internal/session/registry.go`) owns the session: a
  byte-oriented scrollback ring plus lossy fan-out to attachers
  (`internal/session/session.go`). Everything downstream assumes an opaque
  terminal byte stream.
- `HandleTerminalWS` (`internal/http/terminal.go:192`) bridges that byte
  stream to the browser: binary WS frames = raw PTY bytes both ways, text
  WS frames = JSON control events (`status`, `size`, `diff_refresh`). It
  also does **lazy resume**: attaching to a head whose session is not live
  calls `heads.ResumeHead`, which re-seeds and relaunches with `--continue`.
- Status is independent of terminal bytes: seeded Claude hooks run
  `hydra trigger-hook claude` (`internal/cli/trigger_hook.go`), which writes
  `status.json`; a poller syncs it to the DB and the events WS broadcasts
  `agents_changed`. This pipeline works unchanged in chat mode because
  hooks also fire in headless (`-p`) runs.
- The web side: `AgentTerminal.tsx` owns the tab bar (agent terminal first,
  plus bash-shell tabs) and mounts inside `AgentDetail.tsx` (~line 1057).
  The metadata row in `AgentDetail` holds the chips: agent-type badge,
  status badge, test verdict, network badge, branch tag, then the base
  branch `BranchSelector` (~line 1021) - the requested home for the new
  chat toggle chip sits right after that selector.

## 2. The Claude stream-json interface

This is the same protocol the official Agent SDK speaks - the SDK is a
wrapper that spawns exactly this CLI invocation - so it is the right
low-level integration point for a Go backend. It is however only loosely
documented as a raw CLI surface, so Phase 0 below is a verification spike
that pins down every behavior we depend on.

### Invocation

```
claude --dangerously-skip-permissions \
    --append-system-prompt <preprompt> \
    [--model <model>] \
    -p --input-format stream-json --output-format stream-json --verbose \
    [--include-partial-messages] \
    [--continue]
```

Notes:

- `--verbose` is required for `stream-json` output in `-p` mode (and for
  `--include-partial-messages`).
- No positional prompt: with `--input-format stream-json` the process stays
  alive reading user messages from stdin. The head's initial task prompt is
  sent as the **first stdin message** instead of argv, so it shows up as a
  normal user turn in the chat history.
- `--include-partial-messages` turns on token-level `stream_event` deltas.
  Deferred to Phase 3 (see Phasing) - without it, output arrives one
  complete assistant message at a time, which in an agentic loop means an
  update every few seconds (each text segment between tool calls). Much
  simpler replay semantics for the MVP.
- `--continue` composes with `-p` for resume; the conversation and
  `session_id` persist in `~/.claude/projects/<cwd-slug>/<session-id>.jsonl`
  (Hydra already manages those dirs in `internal/paths`).
- `--dangerously-skip-permissions` sidesteps the whole interactive
  permission problem: no permission prompts ever need surfacing in the chat
  UI. The `PreToolUse` `hydra gate` hook still enforces policy exactly as
  today, since hooks fire in `-p` mode.

### Output events (one JSON object per line on stdout)

| type | notes |
|---|---|
| `system` / subtype `init` | start of session: `session_id`, `model`, `tools` |
| `assistant` | a complete assistant message; `message.content` is an array of blocks: `text`, `thinking`, `tool_use` |
| `user` | tool results echoed back as user-role messages (`tool_result` blocks) |
| `stream_event` | raw API deltas, only with `--include-partial-messages` |
| `result` | end of a turn: subtype `success`/`error`, `total_cost_usd`, usage, duration, `session_id` |

### Input messages (one JSON object per line on stdin)

```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}
```

Content blocks can include images (base64 source blocks) - verify in the
spike; that is the path for the existing paste-a-file/attachment flow.

### Control protocol

The SDK also exchanges `control_request` / `control_response` objects over
the same pipes - notably `{"request":{"subtype":"interrupt"}}` to cancel a
running turn without killing the process. This is the least-documented part
of the protocol; the spike must confirm it, with SIGINT to the child as the
fallback interrupt mechanism.

### Stability caveat

The raw protocol is what the Agent SDK emits/consumes, so it is de facto
stable, but it is versioned with the CLI. The decoder must be defensive:
unknown `type`s and unknown block types are passed through to the client
(rendered as a generic "unknown event" row) rather than dropped or fatal.

## 3. Design overview

```
claude -p --input/output-format stream-json      (child, pipes not PTY)
        | stdin/stdout JSONL
internal/session: chat-kind session               (same registry, ring stores JSONL)
        | replay + live fan-out (existing attacher mechanics)
internal/http: terminal WS handler, mode=chat     (JSONL lines -> text frames)
        | ws
web: AgentChat pane                               (reduce events -> message list)
```

The key insight is that the existing session plumbing is *almost* right:
the scrollback ring + attacher fan-out already give us replay-then-live
semantics for a newly attached client. In chat mode the byte stream is
JSONL instead of VT100, and the client parses lines instead of feeding
xterm. What changes is only (a) how the child is spawned (pipes, not a
PTY), (b) framing at the WS boundary, and (c) the whole frontend pane.

## 4. Backend changes

### 4.1 Per-head flag: DB + API

- **DB**: new column on `Agent` (`internal/db/model_unix.go`, mirrored in
  `model_windows.go`): `ChatMode bool` with `gorm:"default:false"`. GORM
  `AutoMigrate` in `db.Open` picks it up; no manual migration.
- **OpenAPI** (`api/openapi.yaml`): add `chat_mode` (boolean, optional) to
  `SpawnAgentRequest`, `UpdateAgentRequest`, and `AgentResponse`. Regen with
  `go generate ./internal/api/` and, from `web/`, `bun run generate-openapi`.
- **Validation**: `SpawnAgent` / `UpdateAgent` handlers reject
  `chat_mode: true` for any `agent_type` other than `claude` (400).
- **CLI parity**: `hydra spawn --chat` flag in `internal/cli/spawn.go`.
- **Threading**: `SpawnHeadOptions` (`internal/heads/heads.go:304`) gains
  `ChatMode bool`; `SpawnHead` persists it and passes it to argv building;
  `ResumeHead` reads it back off the DB row, so lazy resume naturally
  relaunches in whatever mode the head is currently set to.

### 4.2 Argv: `sandbox.AgentArgv`

`AgentArgv` grows a `chatMode bool` (or an options struct - it already has
five params, an options struct is probably overdue). For
`AgentTypeClaude && chatMode`:

- append `-p --input-format stream-json --output-format stream-json --verbose`
- never append the positional prompt (it goes over stdin)
- `--continue` on resume, exactly as today
- keep `--append-system-prompt` and `--model` handling unchanged
- skip the fullscreen-renderer env (`claudeRenderingEnv` /
  `ResolveFullscreen`) - there is no TUI to render

`chatMode` for any other agent type is an error.

### 4.3 Session layer: a non-PTY session kind

Two options considered:

- **Option A (recommended): pipe-backed process.** Extend the nshost
  `SpawnRequest` with `Pipes bool`; the supervisor wires plain
  stdin/stdout pipes instead of `openpty`. `session.Registry` already
  abstracts the process behind the `PTY` interface (`StartWithProc`), so
  introduce a narrower `Proc` interface (Read/Write/Close; Resize is a
  no-op) that both implement, and a `Kind` field on `Session`
  (`KindTerminal` / `KindChat`). stderr is captured separately into the
  daemon log (in chat mode stdout is protocol, stderr is diagnostics -
  they must not interleave).
- **Option B: keep the PTY, fix termios.** Disable echo and output
  post-processing (ONLCR) on the pty. Fewer moving parts in nshost, but
  fragile: any echo leakage or CRLF translation corrupts the JSONL parse.

Option A is more work in `nshost` but is the correct shape; JSON protocols
do not belong on a terminal device.

Ring/scrollback in chat mode:

- Same byte ring, but sized up for chat sessions (JSONL is bulkier than
  VT100 scrollback; start with ~2 MB) and replayed verbatim on attach.
- A wrapped ring can start mid-line; the contract is that the client (and
  the WS handler) discard everything before the first `\n` in the replay.
- Full history beyond the ring comes later from the on-disk transcript
  (`~/.claude/projects/<slug>/<session-id>.jsonl`) - Phase 4.

### 4.4 WebSocket: chat framing on the existing endpoint

Reuse `/ws/projects/{pid}/agents/{id}/terminal` with the handler branching
on the session kind (or an explicit `mode=chat` query param, validated
against the head's stored mode). Reuse keeps the lazy-resume logic
(`terminal.go:293-305`), heartbeats, and status events in one place.

Chat framing (all text frames, no binary):

- **server -> client**: existing control events unchanged
  (`{"type":"status"|"size"|"diff_refresh"}`); new
  `{"type":"claude_event","event":<verbatim stream-json object>}` for each
  complete line off the ring/live stream, and `{"type":"replay_done"}`
  after scrollback replay so the client can distinguish history from live.
- **client -> server**: `{"type":"user_message","content":[<blocks>]}` -
  the handler wraps it into the stdin user-message envelope and writes one
  line to the child; `{"type":"interrupt"}` - forwarded as a
  `control_request` (or SIGINT fallback, per the spike's findings).

A new small package `internal/claudestream` owns the Go types for the
envelope (`type`, `subtype`, `message`, `result` fields we care about) and
a line decoder. The daemon does not need to deeply parse every event - it
mostly relays lines - but it does watch for `system:init` (capture
`session_id`) and `result` (turn accounting, error surfacing).

### 4.5 Status and hooks: unchanged

The hook -> `status.json` -> poller -> `agents_changed` pipeline is
identical in chat mode (hooks fire in `-p`). The stream itself gives us
richer signals (e.g. `result` = turn finished) that can later *augment*
status, but the hook path stays the source of truth so terminal and chat
heads behave identically. Spike item: confirm `Notification`-driven
`needs_input` still occurs in `-p` mode (e.g. AskUserQuestion) and decide
how a chat head surfaces it.

### 4.6 Toggling a running head

`updateAgent {chat_mode}` persists the flag. Then:

1. If a session is live, the daemon stops just the child process (registry
   kill of the PID; worktree, branch, DB row untouched). This is a new
   "soft restart" primitive - **not** `RestartAgent`
   (`internal/http/handlers.go:1700`), which is kill-head-and-respawn and
   destroys the worktree.
2. The frontend swaps panes and reconnects the WS; the existing lazy-resume
   path boots the head in the new mode with `--continue`.

Because `--continue` works in both directions - the interactive TUI resumes
a conversation last driven via stream-json and vice versa (same transcript
on disk) - the toggle is lossless both ways. Spike item to confirm.

Simplest implementation: `UpdateAgent` handler notices `chat_mode` changed,
stops the live session, publishes `agents_changed`; the client reconnect
does the rest. No new endpoint needed.

## 5. Frontend changes

### 5.1 Chat pane

`AgentTerminal.tsx` keeps owning the resizable panel and the tab bar; the
first tab renders either the existing `TerminalPane` or a new
`AgentChat.tsx` based on `agent.chat_mode`. Bash-shell tabs are unaffected
(still PTY terminals).

`AgentChat` responsibilities:

- Connect to the same WS (chat framing), buffer replay until `replay_done`,
  then reduce `claude_event`s into a message list:
  - user turns -> right-aligned bubbles (text + attachment chips)
  - assistant `text` blocks -> markdown
  - `thinking` blocks -> collapsed-by-default disclosure
  - `tool_use` + its paired `tool_result` (matched by `tool_use_id`) ->
    a collapsed card: tool name + one-line input summary, expandable to
    full input/output; error results tinted
  - `result` -> subtle per-turn footer (duration, cost) and an error
    banner on subtype `error`
  - unknown events -> generic fallback row, never dropped silently
- Input box at the bottom: textarea with the same attachment/paste-upload
  affordances as `SpawnForm` (reuse `HighlightedTextarea`, `uploadFile`,
  `AttachmentChips`); Enter sends `user_message`, Esc / a stop button sends
  `interrupt` while a turn is running.
- Disable input while status is `starting`; show the existing status chip
  states in-pane like the terminal does.

Markdown: `web/src/lib/markdown.tsx` is a deliberate zero-dependency
renderer that today handles only inline styles and fenced code. Chat needs
headings, lists, and tables - extend the in-house renderer (keeping
`highlight.js` for code blocks) rather than adopting `react-markdown`,
matching the repo's existing choice. If that grows past a couple hundred
lines, revisit.

### 5.2 Toggle chip in the agent view

In `AgentDetail.tsx`'s metadata row, immediately after the base-branch
`BranchSelector` block (~line 1033, before the `created` timestamp): a
small two-state control, `Badge`-styled like its neighbors, only rendered
for `agent_type === "claude"`:

```
[ base <branch-selector> ]  [ ▸ terminal | chat ]  created 3h ago
```

Clicking the inactive side calls
`api.default.updateAgent(projectId, id, { chat_mode })`, shows a spinner on
the chip (mirroring the `savingBase` pattern), and lets the WS reconnect /
lazy resume swap the pane. If the agent's status is `running` (mid-turn),
confirm first: "Switching modes restarts the Claude process; the
conversation is preserved. Restart now?"

### 5.3 Spawn box

In `SpawnForm.tsx`, next to the `AgentModelPicker` in the footer controls,
a compact "Chat" toggle shown only when the selected agent type is
`claude`. It adds `chat_mode: true` to the `SpawnAgentRequest` and persists
the preference in `StorageKeys` (alongside `defaultAgentType` /
`defaultModel`). Keep it visually minimal - a single small pill, matching
the existing footer density; if it crowds the compact layout, put it in the
model-picker dropdown instead and only chip it in the full-page layout.

## 6. Phasing

- **Phase 0 - spike.** A throwaway harness (script or Go test) against the
  installed `claude` binary that pins down: process stays alive across
  multiple stdin turns; `--continue` composes with `-p`/stream-json and
  round-trips with the interactive TUI; hooks fire (status pipeline);
  stderr/stdout separation; image content blocks on stdin;
  `control_request` interrupt (else SIGINT); behavior on stdin EOF and on
  child crash; whether `-p` mode ever blocks on `needs_input`.
- **Phase 1 - backend.** DB column + API field + argv + pipe-backed
  session kind + chat WS framing + soft-restart-on-toggle. Verifiable with
  `websocat` before any UI exists.
- **Phase 2 - frontend MVP.** `AgentChat` pane (no token streaming),
  toggle chip, spawn-box toggle. Whole-message updates only.
- **Phase 3 - streaming polish.** `--include-partial-messages` +
  `stream_event` delta rendering (client dedupes partials against the
  final `assistant` event by message id), interrupt button, per-turn cost
  footer.
- **Phase 4 - depth.** Transcript backfill for history beyond the ring
  (read the session `.jsonl`), image attachments in chat input, richer
  tool cards (diffs for Edit/Write), maybe chat mode for other agent types
  if/when their CLIs grow an equivalent protocol.

## 7. Risks and open questions

- **Protocol stability.** Raw stream-json is versioned with the CLI.
  Mitigation: defensive decoder, unknown-event passthrough, spike script
  kept around as a compatibility canary.
- **nshost pipes mode** is the largest unknown chunk of backend work; the
  supervisor currently assumes a PTY for lifecycle (EOF/exit detection).
  Option B (PTY + termios) is the escape hatch if it drags.
- **Ring replay is lossy at the edges** (wrap mid-line, ring overflow on
  very long sessions). Acceptable for MVP; Phase 4 transcript backfill is
  the real fix.
- **`needs_input` in `-p` mode**: if headless Claude can still park waiting
  for input we cannot deliver (e.g. AskUserQuestion), chat mode needs a UI
  answer or those tools need disabling in chat heads. Spike will tell.
- **Model on resume**: today `AgentArgv` drops `--model` on resume;
  chat-mode resume inherits that behavior (fine, but worth stating).
- **Windows**: sessions are stubbed on Windows anyway; `model_windows.go`
  just needs the mirrored column.
