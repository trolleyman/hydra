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

#### Implemented state (July 2026)

Hydra persists a provider-neutral sequenced event log and versioned projection
for Claude and Codex. The projection owns plan, sub-agent, turn, interaction,
model, usage, queue, and Git-head state; the browser loads that snapshot with a
bounded recent page and requests older pages by `seq`. Provider object ids stay
inside payloads; `seq` is the event's sole wire/cursor identity.

The session registry ingests provider output even with no browser attached.
WebSocket pumps must not ingest the same stream again: token deltas have no
stable provider id, so double observation duplicates live text and destabilizes
bottom-follow rendering.

Codex model selection is held by the app-server controller and included in the
next `turn/start`; an active turn is not mutated. Claude retains its stream-json
`set_model` control request behind the same registry operation. Claude recovery
stores a crash-safe transcript byte watermark and deduplicates by provider
source id. Codex resume calls documented `thread/read`, translates returned
items through the live normalizer, and only then drains a queued resumed turn.

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

Commit events participate in the same history pagination as messages and tool
events. `load_before` should use an opaque event cursor (internally the per-head
sequence number), not a provider UUID, and return the preceding displayable
events in sequence order. A page may therefore naturally contain:

```text
assistant_message
tool_started
tool_completed
commit_created
assistant_message
```

The frontend prepends that page as one ordered batch. It must not fetch or merge
commit chips separately, and it deduplicates every event by its durable event id
so the boundary between the initial window, an older page, and live delivery is
safe. `done` means the durable event log's beginning was reached, not merely the
beginning of provider-message history.

Paging old events remains display-only. A historical `plan_updated`,
`subagent_started`, or `head_changed` event in an older page renders its
historical card when appropriate but never rewinds the current-state projection
received in `state_snapshot`. This is the separation that lets a user scroll to
the beginning while a live turn continues without the current plan or active
sub-agent panel jumping backward.

The normalized log is also the presentation source of truth. A history page
must not discard normalized semantics by converting it through a provider-only
backfill reducer. In particular, a completed tool event can carry richer input
than its earlier started event, and a sidechain report can be separated from
its spawn by a page boundary. The browser retains completed tool metadata by
item id, enriches the matching start card, and routes paged sub-agent lifecycle
and sidechain events through the same projection used for live delivery. A
remount or scroll-back therefore renders the same search query, plan activity,
and sub-agent report as the original live session.

Tool cards keep the provider's distinct started and completed envelopes for
Raw inspection while presenting their merged semantic state normally. An
interactive shell launcher such as `bash -lc bash` may receive its real command
through stdin; when app-server exposes that command only as the first PTY echo,
the UI promotes the echo to the command panel and renders the remaining cleaned
terminal transcript as output. CRLF is a newline, while only a bare carriage
return has terminal overwrite semantics.

Queued messages follow the same state/history boundary. While a message is
queued, it exists only in the checkpointed queue projection and is included in
`state_snapshot` with its stable client-generated id, enqueue sequence/time, and
content. It must not also appear in history: the provider has not received a
user turn yet. Dequeue removes it from the projection and emits no conversation
event.

When the queue drains, persist one atomic logical transition:

1. append a durable `user_message` event carrying the same client message id,
2. remove that id from the queue projection,
3. advance the projection watermark,
4. deliver the provider turn (with retry/idempotency bookkeeping if the process
   write can fail).

The frontend reconciles the pending bubble into the historical/live user
message by client id instead of rendering a second bubble. Afterward the message
pages normally with the rest of the ordered event log. On reconnect, a message
is consequently observed either in the queue snapshot or as a durable event
(and during recoverable delivery, as a marked sending entry), never as neither
or both. Loading an older page cannot disturb the current queued-message tray.

The production implementation needs a small delivery state (`queued`,
`sending`, `accepted`) rather than treating the stdin write as an infallible
atomic operation. Recovery may safely retry only when the provider protocol has
an idempotency/client id it honors; otherwise surface an uncertain delivery
state instead of silently sending a possibly duplicated user turn.

If history retention later compacts old events, write a history checkpoint at
the compaction boundary and make the cursor response explicit about the retained
start. Never silently synthesize current commits into an arbitrary older page;
that would lose causal ordering again.

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
- Replace provider-UUID history paging with an opaque normalized-event cursor;
  page messages, tools, commits, and other display events from one ordered log,
  with durable event-id deduplication across page/live boundaries.
- Give queued messages stable client ids and persisted delivery states; reconcile
  a drained queue item into its durable `user_message` by that id, without a
  duplicate across snapshot, replay, pagination, or live delivery.
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
- Simulation fixtures include `/agent/agent-chat` for Claude's legacy provider
  frames and `/agent/agent-chat-codex` for the normalized Codex contract. The
  Codex fixture covers shell-wrapper display, multi-file edits, a real child
  report, status-only spawn completion, and close-agent controls so replay and
  live rendering can be checked against the same deterministic input.
- Playwright coverage for spawn, streaming response, queueing, interrupt,
  reconnect replay, and mode switching, with console and page errors captured.
- Gate Codex chat behind a config feature flag for one release if supported
  Codex CLI versions in the field are heterogeneous. At startup, report a clear
  error when `app-server` or required protocol methods are unavailable.

### Rich item presentation

The normalized item layer keeps provider payloads available to the Raw view,
but normal cards display only semantic fields. Codex `fileChange` items are
classified as Write, Edit, Move, or Delete cards and render each affected path
as a syntax-highlighted unified diff. Web search intentionally begins with an
unknown query because app-server supplies it on `item/completed`; the existing
card is patched in place when that metadata arrives instead of exposing the
temporary item id or protocol JSON.

Codex Agent items use their spawning tool id as a temporary sub-agent identity.
When app-server reports the child thread id, the reducer merges that placeholder
into the durable sub-agent projection. Thus live display, reconnect replay, and
completion notices all refer to one rich card rather than a raw Agent card plus
a second standalone result.

App-server's `spawnAgent` completion does not always contain the new child
thread id. The ordered ingestion worker therefore remembers pending spawn items
and links the next previously unseen sidechain thread to the oldest pending
spawn before persisting it. The resulting `subagent_started`, sidechain display
events, and `subagent_completed` events all carry the same `parent_item_id`.
This correlation is rebuilt while processing `thread/read`, so daemon restart
and transcript recovery use the same event contract as a live run.

The shared presentation reducer also keeps Claude partial content on one active
stream until its completed message arrives. Claude's machine-readable
sub-agent continuation and usage trailer is removed from the visible report,
and a sidechain transcript is folded into its originating agent tool card
instead of creating a second standalone card.

Captured app-server event logs are also used as regression inputs for the
display boundary. In particular, command strings are decoded as shell-quoted
arguments (including concatenated quote segments and nested `bash -lc`), while
the untouched in-progress or completed app-server item remains available under
Raw. A completed normalized message replaces its streamed preview in the same
render batch so the preview cannot briefly disappear before the final Markdown
is committed.

Claude token deltas require a slightly different retention rule from completed
events. `stream_event` lines remain excluded from the legacy scrollback ring,
but the normalized adapter observes them before that filter. Live clients thus
receive `assistant_delta`/`reasoning_delta`, while reconnect rendering settles
on the completed semantic message. Provider content-boundary notifications are
state hints rather than a second set of presentation events: the first delta
opens the live block and the completed message closes and replaces it atomically.

`plan_updated` is both a durable projection checkpoint and a plan-panel input.
Codex `{step,status}` entries are normalized to the shared `PlanEntry` shape.
Claude's tracker emits checkpoints after TaskCreate and TaskUpdate, but those
checkpoints do not render synthetic Update Plan cards because the original Task
cards already provide the timeline. Codex plan notifications retain a visible
Update Plan card because app-server does not emit a separate plan tool item.

Tool output already renders common ANSI SGR colours. Full terminal emulation
(cursor motion and reconstructing every interactive-shell stdin write) remains
out of scope: when Codex reports only an interactive shell transcript, Hydra
labels the first echoed command as inferred terminal input and keeps the
complete provider envelopes under Raw.

Head lifecycle follows both `turn/started` and `item/started`. The latter is a
bounded fallback for resumed or version-skewed app-server streams where item
activity becomes visible before the corresponding turn notification; it keeps
the durable head status running (and Stop available) while work is demonstrably
still arriving.

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
