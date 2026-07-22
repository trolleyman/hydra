# Codex chat support

## Recommendation

Run `codex app-server` over its default JSONL-over-stdio transport for Codex
chat-mode heads. Do not build chat mode on `codex exec --json`.

App-server is the protocol intended for rich clients. It owns a persistent
conversation, accepts multiple turns, supports resume and interrupt, and emits
incremental item notifications. In contrast, `codex exec --json` is a
non-interactive, one-turn runner. Using it would make Hydra supervise a new
process for every message and reconstruct continuity with `exec resume`, while
still missing the bidirectional controls a chat client needs.

The official protocol documentation is at:

- <https://developers.openai.com/codex/app-server/>
- <https://developers.openai.com/codex/noninteractive/>

The app-server protocol is JSON-RPC-like JSONL (the `jsonrpc` member is omitted).
A client initializes the connection, starts or resumes a thread, starts turns,
and consumes notifications such as `turn/started`, `item/started`,
`item/agentMessage/delta`, `item/completed`, and `turn/completed`.

## Why the Claude path cannot just be enabled for Codex

`chat_mode` currently means "Claude stream-json" throughout the stack, despite
the database field and session kind having generic names:

- `sandbox.AgentArgv` rejects every non-Claude agent and builds Claude's
  `-p --input-format stream-json --output-format stream-json` command.
- `SpawnHead` writes a Claude `user` envelope to stdin. App-server instead needs
  an `initialize` handshake, `thread/start`, then `turn/start`.
- `session.Registry` installs a `claudestream.RingFilter` for every chat session.
  It detects Claude `result`, assistant, plan, model, thinking, and API-error
  records; none are Codex notification shapes.
- `chat_ws.go` backfills `~/.claude/projects/...` transcripts and wraps every
  line as `claude_event`.
- `AgentChat.tsx` reduces Anthropic message/content blocks and Claude-specific
  control requests, usage, sub-agent, compaction, and task-notification shapes.
- switching modes assumes Claude's transcript lookup and `--resume <session>`.

Relaxing the two API validation checks would therefore start an incompatible
process and feed each side messages it cannot understand.

## Proposed shape

Keep the browser's existing Hydra chat WebSocket contract for commands where it
is already provider-neutral (`user_message`, `interrupt`, `dequeue`, and queue
snapshots). Introduce a provider adapter between that contract and each CLI.

```text
AgentChat
  <-> Hydra chat frames
      <-> ChatDriver (Claude or Codex)
          <-> CLI protocol (stream-json or app-server JSONL)
```

The daemon should emit normalized Hydra events rather than teach the React
component a second raw protocol. A small initial vocabulary is enough:

- `conversation_started`: provider conversation/thread id and active model
- `turn_started`, `turn_completed`, `turn_failed`
- `user_message`
- `assistant_delta`, `assistant_message`
- `reasoning_started`, `reasoning_delta`, `reasoning_completed`
- `tool_started`, `tool_updated`, `tool_completed`
- `plan_updated`
- `error`

Keep a `raw` field (or log the original notification) while the mapping settles,
but do not make provider JSON part of the browser API. Claude can initially keep
its existing `claude_event` path; migration to normalized events can happen
after Codex works, avoiding a risky big-bang rewrite.

### Codex driver lifecycle

For a fresh chat head:

1. Launch `codex app-server --listen stdio://` with pipes inside the existing
   Hydra sandbox. The outer sandbox remains the enforcement boundary.
2. Send `initialize` with a stable Hydra client identity, then `initialized`.
3. Send `thread/start` with the worktree as `cwd`, the selected model when set,
   and app-server sandbox/approval values consistent with the already-external
   Hydra sandbox.
4. Persist the returned thread id on the agent row. Do not infer "latest": two
   heads can share a project and Codex home, so `--last` is ambiguous.
5. Send the spawn prompt using `turn/start` and retain its returned turn id.
6. Map notifications to normalized events and the existing status/queue hooks.

For resume, repeat initialization, call `thread/resume` with the persisted thread
id, and only issue `turn/start` when Hydra deliberately sends a continuation
nudge. For a user message while idle, issue `turn/start`; while a turn is active,
preserve Hydra's current queue semantics initially. `turn/steer` can later power
an explicit "steer now" action instead of silently changing queue behavior.

For Ctrl+C, call `turn/interrupt` with the active thread and turn ids. This
replaces Claude's stdin `control_request` interrupt. Treat the resulting
`turn/completed` cancellation status as a turn boundary so queue draining and
Hydra status updates behave as they do today.

### Persistence and replay

Add a provider conversation id to the agent record (for example,
`conversation_id`; avoid a Claude- or Codex-named column). A thread id is part of
head identity and must survive daemon and mode restarts.

For the first version, persist normalized events in a Hydra-owned append-only
JSONL file under the head's existing status directory. This gives both providers
the same reconnect and history-paging behavior without decoding Codex's private
session files or depending on undocumented paths. Append only durable/completed
events; live deltas go to attachers but not the scrollback file. On attach:

1. replay the durable normalized log,
2. replay/dedupe the in-memory ring,
3. send `replay_done`, the plan, and the queue snapshot,
4. continue with live events.

App-server also exposes thread reading/listing APIs, but a Hydra-owned event log
keeps rendering stable across installed Codex versions and provides history for
events that are UI state rather than conversation items. A later recovery path
can rebuild the log from `thread/read` when it is missing.

### Checkpointed projections

The visible history window must not be the source of truth for current state.
Plans, active sub-agents, the active turn, pending interaction, model, and token
usage are projections over the event stream: folding all relevant events from
the beginning produces their current values. The daemon should own and persist
those projections even when no browser is attached.

Store a versioned checkpoint containing the latest materialized state plus the
sequence number through which it was calculated. Conceptually:

```json
{
  "version": 1,
  "through": 1842,
  "plan": [{ "id": "2", "status": "in_progress", "content": "Run tests" }],
  "subagents": {
    "agent-7": { "status": "running", "parent_item_id": "tool-4" }
  },
  "turn": { "id": "turn-9", "status": "running" },
  "interaction": null,
  "model": "gpt-5.4"
}
```

Every normalized durable event gets a monotonically increasing per-head
sequence number. When appending an event, the daemon applies it to its in-memory
projection and periodically (and at important boundaries) atomically replaces
the checkpoint. On restart it loads the checkpoint and replays only events with
`seq > through`. This is a normal event-sourced snapshot: the event log remains
the audit/history record while the checkpoint makes restoration bounded.

Checkpoint at least on plan changes, sub-agent lifecycle changes, interactive
requests, turn completion/failure, and clean process shutdown; also checkpoint
after a small event/time threshold during long-running turns. Delta tokens do
not need to trigger a checkpoint. Use a temporary file plus rename, or a single
database transaction, so a crash cannot expose half a checkpoint. Reducers must
be idempotent because a crash between event append and checkpoint replacement
can legitimately replay the final event twice.

On WebSocket attach, take one consistent snapshot and watermark under the same
projection lock:

1. send `state_snapshot` with the projection and its `through` sequence,
2. send only the recent page of displayable chat events requested by the UI,
3. send durable/live events with a sequence greater than the watermark.

This removes the attach race where a plan or sub-agent changes between sending
the snapshot and subscribing to live output. Loading older chat pages never
mutates current projections: those events are historical display data and are
at or below the snapshot watermark. The frontend can therefore load ten
messages or the entire transcript and show the same current plan.

The same mechanism handles partial resume. After a daemon restart, a Codex
thread resume, or a terminal-to-chat switch, Hydra restores the checkpoint,
replays its own short event tail, reconciles it with the provider's current
thread/turn state, then starts forwarding new events. It does not need to replay
the whole provider transcript before showing an accurate plan or active-agent
panel.

Not every value belongs in this projection. Persist current operational state:

- plan/to-do entries and their ordering/status,
- sub-agent identity, parent relationship, description, status, and latest
  meaningful activity (not its complete nested transcript),
- active turn and incomplete streamed item identifiers,
- outstanding approval/question/elicitation,
- selected/current model and most recent usage totals,
- queued messages (already daemon-owned today).

Keep complete messages, tool outputs, reasoning, and sub-agent transcripts in
the paged event history. A snapshot may reference their item ids, but should not
grow with conversation length.

Claude already implements part of this idea for plans: `PlanTracker` folds live
events into `Agent.Plan`, and `sendPlan` sends that durable state independently
of transcript backfill. Generalize that behavior into the provider-neutral
projection store rather than keeping the mirrored Go and TypeScript plan
reducers. Current sub-agent state should move to the same model; today it is
partly reconstructed from a bounded transcript tail plus special completion
prelude records, which is more fragile than a persisted lifecycle projection.

### Status, plans, tools, and approvals

Drive status directly from Codex notifications rather than waiting for hooks:

- `turn/started` -> `running`
- completed turn -> `finished` (or `waiting` after a user interrupt)
- failed turn / top-level error -> `errored`
- server request requiring user input -> `needs_input`

Map Codex plan-update items into the existing persisted plan model. Map command,
file-change, MCP, web-search, and other item variants to generic tool cards; keep
unknown item types as a compact fallback card so protocol additions do not break
the chat.

Hydra currently launches Codex with bypassed approvals because the process is
already inside Hydra's sandbox. Configure app-server turns equivalently. Still
implement server-request handling defensively: reply automatically only to the
same classes Hydra already auto-allows, and surface genuinely interactive
elicitation as a normalized request card. Never leave app-server blocked waiting
for a response merely because no browser is attached.

### Git commits as causally ordered events

Commit chips must be durable normalized events, not a second frontend data set
merged into chat by timestamps. The current client fetches the commits endpoint
after a `head_moved` hint and interleaves the result using Git author time. That
cannot guarantee that a commit appears after the command/tool card which created
it: provider output, filesystem polling, HTTP fetches, and author timestamps are
independent clocks.

The chat driver should maintain an observed Git HEAD for the worktree. At a
completed command or other potentially mutating tool boundary:

1. append/finalize the provider's `tool_completed` event,
2. resolve HEAD synchronously,
3. if it changed, enumerate commits reachable from the new HEAD but not the
   previously observed HEAD, oldest first,
4. append one `commit_created` event per newly observed commit,
5. advance the observed HEAD and emit the ordinary diff-refresh notification.

Because `tool_completed` and `commit_created` use the same per-head event
sequence, the UI always renders the commit after the Bash/tool output without a
timestamp heuristic. The event should carry at least SHA, short SHA, subject,
parents, author/committer time, and the causal tool item id when known. Deduplicate
by SHA so reconciliation cannot create a second chip.

Do not rely only on Bash. Commits can be made by an MCP tool, a hook, a background
process, a user shell, or another supported provider item. Check after every
provider item that can mutate the worktree and again at turn boundaries. Keep the
existing lightweight HEAD watcher as a fallback for changes outside those
boundaries, but make it call the same reconciliation function. An externally
detected commit has no causal tool id and is sequenced wherever it is observed.

Handle non-fast-forward movement explicitly. A fast-forward yields
`commit_created` events. A reset/rebase/checkout yields a `head_changed` event
with old/new HEAD and makes the projection reconcile its visible commit set;
pretending every changed SHA was newly committed would leave stale or duplicate
chips. The commits endpoint remains useful for the diff selector and full branch
inventory, but it stops being the source of chat chronology.

For old conversations without stored commit events, exact causal placement
cannot be recovered reliably. Backfill their commit chips as legacy state (or
approximately by committer time) and guarantee exact ordering only from the
first backend-sequenced event onward.

## Implementation sequence

### 1. Protocol spike and fixtures

- Run the installed target Codex version's
  `codex app-server generate-json-schema --out <temp-dir>`.
- Capture fixtures for initialize, thread start/resume/read, a text-only turn, a
  command, a file edit, a plan update, a failed turn, and interrupt.
- Confirm exact external-sandbox approval/sandbox parameters and whether thread
  ids remain resumable after switching back to the TUI.

Generated schemas are version-specific. Use them to generate or validate the
driver types, but keep tolerant decoding for notifications and unknown items.

### 2. Backend driver boundary

- Add `internal/chat` with a provider-neutral driver interface and normalized
  event types.
- Move Claude line construction/filter callbacks behind a Claude driver without
  changing behavior.
- Add `internal/codexstream` (or `internal/chat/codex`) for request ids,
  handshake state, thread/turn ids, notification parsing, and event mapping.
- Make `session.Session` hold a generic chat filter/observer rather than a
  concrete `*claudestream.RingFilter`.
- Have `SpawnHead` and `ResumeHead` select the driver by `AgentType` and let it
  perform its post-start handshake/initial-turn work.

Unit-test fragmented JSONL, responses arriving among notifications, unknown
methods/items, duplicate completion events, failed initialization, interrupt,
and process exit mid-turn.

### 3. Persistence, queues, and WebSocket

- Persist the provider conversation id and normalized event log.
- Add monotonic event sequence numbers and a versioned, atomically-written
  projection checkpoint; restore by replaying only the post-checkpoint tail.
- Include plan, active sub-agent graph, active turn, pending interaction, model,
  usage summary, and queue state in the attach snapshot.
- Split Claude transcript backfill/sub-agent tailing out of generic
  `pumpChatOutput`; Codex uses the Hydra event log.
- Route `user_message` and `interrupt` through the selected driver.
- Generalize queue turn-boundary callbacks from Claude `result` to normalized
  `turn_completed`/`turn_failed`.
- Name new outbound frames `chat_event`; continue accepting `claude_event`
  during the frontend migration.
- Make history paging display-only: older pages must not update current plan or
  sub-agent state in the frontend.
- Reconcile Git HEAD after mutating item completions and turn boundaries, emit
  sequenced `commit_created`/`head_changed` events, and use the existing HEAD
  watcher only as an out-of-band fallback.

### 4. UI and API enablement

- Add a normalized-event reducer alongside the current Claude reducer, then
  share the existing message/tool/plan card renderers.
- Hide provider-only controls: Claude's slash commands and `set_model` control
  request do not directly map to Codex. Model selection can be a per-turn
  app-server override once its UX is defined.
- Change spawn and agent-detail checks from `agent_type === 'claude'` to a
  central `supportsChat(agentType)` capability containing Claude and Codex.
- Update OpenAPI descriptions and validation to say Claude and Codex.
- Update the mode-switch confirmation to name the actual provider process.

### 5. Verification and rollout

- Backend tests for fresh spawn, initial prompt, resume by exact thread id,
  queued follow-up, interrupt, daemon reconnect, and terminal/chat switching.
- Reducer tests for every normalized event and unknown-event fallback.
- Simulation fixtures for a Codex chat head, including command/file/plan items.
- Playwright coverage for spawn, streaming response, queueing, interrupt,
  reconnect replay, and mode switching, with console and page errors captured.
- Gate Codex chat behind a config feature flag for one release if supported
  Codex CLI versions in the field are heterogeneous. At startup, report a clear
  error when `app-server` or required protocol methods are unavailable.

## Important design decisions

- **Use one app-server process per chat head.** This matches Hydra's current
  process/session ownership and isolates lifecycle, cwd, environment, sandbox,
  and crashes. A shared daemon would complicate ownership and make one process a
  blast radius for unrelated heads.
- **Persist exact thread ids.** `resume --last` is unsafe in a multi-head
  orchestrator.
- **Normalize at the daemon boundary.** Rendering two raw provider protocols in
  one large React reducer would couple the UI to both CLI release trains.
- **Keep queue-first semantics.** Do not map an ordinary follow-up to
  `turn/steer`; steering changes the active turn and should be an explicit UX.
- **Do not parse private Codex transcript files for v1.** Prefer documented
  app-server methods plus a Hydra-owned replay log.

## Main risks to resolve in the spike

1. The minimum Codex CLI version that contains the stable methods Hydra needs.
2. Exact approval and sandbox fields needed to express "externally sandboxed".
3. Whether app-server emits user input during thread replay or Hydra must log it.
4. How interactive requests are represented and which require a response.
5. TUI/app-server compatibility when switching modes on the same thread.
6. Event ordering and identifiers needed to deduplicate deltas, completed items,
   ring replay, and `thread/read` recovery.

These are protocol-fixture questions, not reasons to choose `exec --json`. The
app-server lifecycle remains the appropriate foundation even if the first
release supports only text, reasoning, commands, file changes, plans, queueing,
and interrupt.
