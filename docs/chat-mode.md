# Chat mode

A chat-mode head talks to its provider through a structured protocol instead of
a PTY, and Hydra renders the conversation itself. Two providers support it:
Claude (`claude -p --input-format stream-json --output-format stream-json`) and
Codex (`codex app-server --listen stdio://`). `sandbox.AgentArgv` rejects chat
mode for any other agent type.

Both providers converge on one contract. The daemon normalizes every provider
line into Hydra's own sequenced event log (`internal/chat`), and that log is the
only thing a chat socket carries. Nothing provider-shaped reaches the browser as
transport: a provider's own payload rides *inside* a Hydra event, where the
Raw panel can show it, but it never determines the wire format or the reducer.

## Every socket is declared in the schema

Hydra serves five WebSockets, and all of them follow one rule: their frames are
declared in `api/openapi.yaml` and generated for both the daemon
(`internal/api`) and the browser (`web/src/api/models`), so a frame the server
writes and one the client narrows on cannot drift.

| Socket | Union | Carries |
| --- | --- | --- |
| `/ws/.../terminal` (terminal head) | `TerminalEvent` | PTY output, size, status, diff refresh |
| `/ws/.../terminal` (chat head) | `ChatFrame` | the conversation - see below |
| `/ws/.../artifacts` | `ArtifactsFrame` | generation progress, live log, finished tiles |
| `/ws/.../tests` | `TestsFrame` | runner verdicts, live log, running counts |
| `/ws/projects/{id}/events` | `ProjectEventFrame` | change signals, so the UI refetches on demand |
| `/ws/server/update` | `ServerUpdateFrame` | self-update progress (docs/deployment.md) |

Each member declares its own single value for `type`, and the parent is a
`oneOf`, so the generated TypeScript is a real discriminated union: `switch
(frame.type)` narrows to that member with no casts, and Go gets a constant per
frame. `writeFrame` in `internal/http/terminal.go` is the one place a frame
becomes bytes.

Two traps worth knowing before adding a sixth:

- **Enum names are global.** oapi-codegen gives an enum short constant names
  only while they are unique across the whole spec, and answers a clash by
  prefixing every value of BOTH enums - silently renaming a neighbour that has
  nothing to do with your socket. Pin yours with `x-enum-varnames` when the
  values are generic (`left`, `building`, `log`).
- **A discriminator cannot map several values onto one member.**
  `ProjectEventFrame` has four bare refetch nudges sharing a schema;
  openapi-typescript-codegen collapses that enum to whichever mapping it saw
  last. Dropping the `discriminator` and keeping the plain `oneOf` narrows
  correctly.

## The chat socket

A chat head shares `/ws/.../terminal` with terminal heads, but every frame is
text.

`internal/chat` type-aliases the generated `ChatEvent` and `ChatProjection`
rather than declaring its own, so the durable log and the wire are the same
shape by construction.

Each event type has its own payload schema, and a provider-derived one also
carries `ChatProviderContext` - who produced it and where it belongs. The two
are separate schemas so each language composes them its own way: Go embeds
both (`encoding/json` promotes embedded fields, so the wire stays flat) and
TypeScript intersects them. What stays open is only what the PROVIDER owns -
its recorded entry (the Raw panel's source), a tool's `input` and result, an
interaction, usage accounting, an error - because those differ per agent type
and per tool.

The daemon builds these as typed structs (`internal/chat/events.go`), each
declaring its own type through an `EventType()` method that `Append` derives
from, so an event's type and its payload cannot disagree. `go vet` guards the
one hazard embedding introduces: a payload field whose json tag collides with
the context's would make `encoding/json` silently drop both, so a test asserts
none do.

Which payload each type carries is stated once, in the schema:
`ChatEventUnion` is a `oneOf` over one member per event type, so the browser
narrows on a generated union rather than a hand-written mapping.

`ChatEvent` describes the same wire bytes with `payload` left open, and that is
what the frames carry - the event store reads `seq`/`type` off every event and
appends it to a log, which needs a concrete struct, and a generated `oneOf` is
an opaque wrapper it cannot field-access. `asChatEvent` is the single
point where one becomes the other.

Because the daemon builds its own typed events rather than consuming the union,
`internal/chat/schema_test.go` checks the two agree: every Go event must resolve
through the generated union to the member its type maps to, every mapped type
must have a Go event, and no Go payload may carry a field its schema member does
not declare. Adding an event type means adding it in both places, and the test
is what says so.

Server to client:

| Frame | Meaning |
| --- | --- |
| `state_snapshot` | the projection (current state) and its `through` watermark |
| `chat_history` | one page of durable events, oldest-first, with `next_cursor` and `done` |
| `chat_event` | one live event |
| `subagent_events` | one sub-agent's full step history |
| `replay_done` | the initial window has been delivered |
| `queue` | the head's still-queued messages |
| `pending_questions` | which question cards the provider is still blocked on |
| `question_expired` | an answer was refused; its request had already been retired |
| `shell_output` | a live chunk of a running composer `!command` |
| `task_output` | the contents of a background task's output file |
| `chat_error` | this head's event log could not be opened |
| `status`, `diff_refresh` | the shared control events terminal heads also get |

Client to server: `user_message`, `interrupt`, `set_model`, `control_response`,
`shell_command`, `shell_stop`, `dequeue`, `load_events_before`, `load_subagent`,
`task_output`. Binary frames and resize messages are ignored - there is no PTY.

`chat_error` exists because the socket has no fallback. If `Flush`/`Watch` fails
(an unknown head, a store that will not open) the connection renders nothing,
and an empty transcript is indistinguishable from a head that never spoke - so
the daemon logs at ERROR and the pane shows a banner instead.

## The event log and the projection

`internal/chat` owns both halves of the durable state.

**The log** is an append-only JSONL file under the head's state directory, one
event per line: `seq`, `source_id`, `type`, `timestamp`, `payload`. `seq` is
per-head, monotonic, and the sole wire and cursor identity - provider object ids
stay inside payloads. `AppendSource` deduplicates by `source_id`, so re-reading
a transcript window or re-observing a line appends nothing new; that idempotence
is what makes reconnect, recovery and multi-attach safe.

**The projection** is bounded current state, versioned and checkpointed with the
`seq` it was folded through:

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

It holds plan entries, the sub-agent graph, the active turn, any outstanding
interaction, model, authentication source, usage totals, queued messages and
the observed Git head. The authentication source keeps Claude API-key cost
footers accurate when the original `system:init` event is older than the newest
history page.
Complete messages, tool output, reasoning and sub-agent transcripts stay in the
paged log: a snapshot may reference their item ids but does not grow with the
conversation. The checkpoint is replaced atomically (temp file plus rename) at
plan changes, sub-agent lifecycle changes, interactive requests, turn
completion/failure and clean shutdown, plus a small event/time threshold during
long turns; token deltas do not trigger one. Restart loads the checkpoint and
replays only `seq > through`. Reducers are idempotent, because a crash between
appending an event and replacing the checkpoint legitimately replays the last
event twice.

The visible history window is never the source of truth for current state.

## Ingestion

The session registry ingests provider output whether or not a browser is
attached: `Registry.SetOnChatLine` hands each complete line to
`Manager.ObserveProviderLine`, which queues it to a per-head worker that
normalizes and persists in arrival order. A WebSocket pump must not ingest the
same stream again - token deltas have no stable provider id, so double
observation duplicates live text and destabilizes bottom-follow rendering.

Two sources sit outside stdout, and the chat pump polls them because current
CLIs put neither on the main stream:

- `subagents/*.jsonl` growth - a sub-agent's inner steps
  (`ObserveClaudeSidechain`);
- the main transcript's `<task-notification>` records - a background sub-agent's
  completion, the only live signal that settles its card.

Both go to the manager, not the socket, and come back out as ordinary chat
events.

## The Claude driver

`internal/chat/claude.go` maps stream-json to chat events: `system:init`
to `conversation_started`, assistant content blocks to `assistant_message` /
`reasoning_completed` / `tool_started`, `tool_result` blocks to
`tool_completed`, `result` to `turn_completed`/`turn_failed`, `control_request`
to `interaction_requested`, partial `stream_event` lines to
`assistant_delta`/`reasoning_delta` and `usage_updated`.

Claude's final `result` line carries `total_cost_usd`, a client-side estimate
for the whole user turn. Hydra shows it in the turn footer when `system:init`
reports API-key authentication. Subscription auth reports `apiKeySource` as
`none`; the same estimate is not an amount billed for that turn, so Hydra hides
it. Both values are normalized and persisted in the projection so reconnecting
does not depend on the initial event remaining in the latest history window.

Some lines produce nothing on purpose. The CLI's internal placeholders - the
resume nudge and its synthetic reply, the note it logs when it downscales an
image - are dropped by `claudestream.IsHiddenChatMessage` before normalization,
in the one place both live and imported lines pass through. A live plain-text
`user` line is also dropped: Hydra records a submitted message at the input
boundary, so the provider's echo of it would be a duplicate.

Hydra persists a submitted user message before handing it to the provider, and
Claude can repeat it through `--replay-user-messages` with a different UUID.
Ingestion pairs that echo with the pending Hydra event and persists a
`user_message_echoed` reconciliation marker rather than a second visible
message; the marker keeps repeated identical messages unambiguous after a
restart.

`Manager.Flush` performs a one-shot import before a client's first attach: the
thinking-duration sidecar, then the newest transcript from
`~/.claude/projects/<worktree-slug>/`, then each sub-agent sidecar for that
session. It records a crash-safe byte watermark and deduplicates by source id,
so a head that ran unwatched - or predates the event log - still backfills.

Claude keeps its stream-json `set_model` control request, issued through the
same registry operation Codex's model selection uses.

The agent and model picker's **Thinking effort** choice is shared by Claude and Codex
and remembered separately for each provider. `Default` omits the API field so
the selected provider and model keep their own default. A fresh Claude session
receives `--effort`; a fresh terminal-mode Codex session receives
`model_reasoning_effort` through its config override. Resume does not reapply
either launch override, so the saved conversation remains authoritative.

## The Codex driver

For a fresh head the controller launches `codex app-server --listen stdio://`
with pipes inside the existing Hydra sandbox (the outer sandbox remains the
enforcement boundary), sends `initialize` with a stable Hydra client identity
then `initialized`, and calls `thread/start` with the worktree as `cwd`. The
returned thread id is persisted on the agent row: two heads can share a project
and Codex home, so `--last` is ambiguous and exact ids are part of head identity.
The spawn prompt goes out as `turn/start`.

Before starting or resuming a thread the controller calls `model/list` and
resolves the account-specific `isDefault` entry to its canonical `model` id,
which avoids inheriting a stale config alias the current account rejects. Older
app-server versions without `model/list` fall back to the requested or
configured behaviour rather than failing initialization. When no model was
explicitly selected the selector reads `Default`: an omitted app-server model
deliberately uses the user's own Codex configuration, and the thread lifecycle
never echoes a concrete replacement id. A model change is held by the controller
and applied to the next `turn/start`; an active turn is not mutated.
An explicitly selected thinking effort is also applied to every new
`turn/start`. Codex owns it as a subsequent-turn override, so it remains in
effect after the initial spawn turn without being resent on `thread/resume`.

Resume repeats initialization, calls `thread/resume` with the persisted thread
id, reads back through `thread/read`, translates the returned items with the
live normalizer, and only then drains a queued resumed turn.

If the daemon stopped while Codex was inside a tool, the persisted final turn
can contain an `inProgress` tool item without its matching output. Hydra removes
that one incomplete turn from Codex's model history before continuing, while
leaving its filesystem effects and Hydra's visible tool cards intact. The
replacement turn receives the interrupted turn's user input together with the
queued resume message, so it continues from the current worktree without stale
unified-exec process ids. Paginated threads use `thread/revert`; legacy threads
use the compatible `thread/rollback` operation.

Interrupt calls `turn/interrupt` with the active thread and turn ids. Cancelled,
canceled and interrupted statuses - including failed turns whose error
identifies a cancellation - all normalize to a durable `turn_interrupted` event,
which is also a turn boundary for queue draining and status. If app-server ends
a delta-only assistant item without `item/completed`, the backend first settles
the accumulated text as a partial `assistant_message`, so replay retains both
what the user saw before Ctrl+C and the explicit interruption boundary.

An ordinary follow-up sent during a turn first enters Hydra's durable queue.
At the next completed Codex item, the queue drains through `turn/steer`, so the
message joins the active turn at a provider-defined step boundary. If the turn
ends before that drain runs, the controller falls back to `turn/start` and the
message becomes the next turn instead.

## Attach and history paging

On attach the daemon takes one consistent snapshot and watermark under the
projection lock, then:

1. sends `state_snapshot` with the projection and its `through`,
2. sends the newest page of displayable events (`chat_history`),
3. sends `replay_done`, then the queue snapshot,
4. streams live events with `seq` above the watermark.

Taking both under one lock removes the attach race where a plan or sub-agent
changes between snapshotting and subscribing.

`load_events_before` pages backwards with an opaque cursor (the sequence
number), returning the preceding displayable events in order. One page mixes
event kinds freely:

```text
assistant_message
tool_started
tool_completed
commit_created
assistant_message
```

The browser prepends a page as one ordered batch and deduplicates every event by
`seq`, so the boundaries between the initial window, an older page and live
delivery are safe. `done` means the log's beginning was reached.

**Paging is display-only.** A historical `plan_updated`, `subagent_started` or
`head_changed` in an older page renders its card where appropriate but never
rewinds the current-state projection from `state_snapshot`. That separation is
what lets a user scroll to the beginning of a long conversation while a live
turn continues, without the plan or active sub-agent panel jumping backwards.

A sub-agent's steps can sit entirely outside the loaded window, so opening its
tab sends `load_subagent` and gets that sub-agent's full history back
(`Store.SubagentEvents`) rather than requiring the main conversation to be paged
back to where it ran.

## Status, plans, tools and approvals

Head status is driven from turn events, not hooks: `turn_started` to `running`,
a completed turn to `finished` (or `waiting` after a user interrupt), a failed
turn or top-level error to `errored`, and an outstanding server request to
`needs_input`. The daemon persists the transition at the turn boundary; a
connected chat also consumes the live events so the sidebar and Stop control
settle immediately instead of waiting for the next project-status refresh.
Replayed history cannot change current head status. Structured provider failures
stay in the payload - the browser unwraps app-server's nested JSON errors and
renders the provider type, HTTP status and human-readable message.

Head lifecycle follows both `turn/started` and `item/started`; the latter is a
bounded fallback for resumed or version-skewed streams where item activity
becomes visible before the turn notification, keeping status running (and Stop
available) while work is demonstrably still arriving.

`plan_updated` is both a projection checkpoint and a plan-panel input. Codex
`{step,status}` entries normalize to the shared `PlanEntry` shape. Claude's
tracker emits a checkpoint after TaskCreate and TaskUpdate but renders no
synthetic Update Plan card, because the original Task cards already carry the
timeline; Codex keeps a visible Update Plan card because app-server emits no
separate plan tool item.

Command, file-change, MCP, web-search and other item variants map to generic
tool cards, and an unknown item type keeps a compact fallback card so protocol
additions do not break the chat.

A host-run card keeps the agent's `why` explanation in its expanded body as a
durable part of the transcript, including after the request is allowed, denied,
or withdrawn. While that agent page is open, the matching global host-run
approval toast is hidden because the transcript card already carries the full
request and decision controls. The toast remains live and appears if the user
navigates away before answering. Approvals without an exact transcript surface,
such as a proxy egress hold, remain visible as global cards.

Codex runs with bypassed approvals because the process is already inside Hydra's
sandbox, and app-server turns are configured equivalently. Server-request
handling is still defensive: Hydra replies automatically only to the classes it
already auto-allows and surfaces genuinely interactive elicitation as a
request card. App-server is never left blocked merely because no
browser is attached.

## Git commits as sequenced events

Commit chips are durable events in the log, not a second data set merged into
the transcript by timestamp - provider output, filesystem polling, HTTP fetches
and author timestamps are independent clocks, so timestamps cannot guarantee a
commit renders after the tool card that created it.

The driver holds an observed Git HEAD for the chat's working directory. A
managed worktree/review context carries its checkout explicitly; a
project-directory context has no worktree and resolves its working directory to
the project root. At a completed command
or other potentially mutating tool boundary it finalizes the `tool_completed`
event, resolves HEAD, and if it moved enumerates the commits reachable from the
new HEAD but not the old one, oldest first, appending one `commit_created` per
commit before advancing the observed HEAD and emitting the diff refresh. Because
both events share the per-head sequence, the commit always renders after the
output that produced it. Each event carries SHA, short SHA, subject, author and
committer time, and the causal tool item id when known; deduplication is by SHA.

This is not tied to Bash. Commits can come from an MCP tool, a hook, a
background process or a user shell, so the check runs after every item that can
mutate the worktree and again at turn boundaries. The lightweight HEAD watcher
remains as a fallback for changes outside those boundaries and calls the same
reconciliation function; an externally detected commit has no causal tool id and
is sequenced where it is observed.

Non-fast-forward movement is handled explicitly. A direct `git commit --amend`
is identified from the HEAD reflog and yields a `commit_created` event for the
replacement SHA, so it appears as a normal commit chip after the command that
created it. A reset/rebase/checkout instead yields `head_changed` with old and
new HEAD and makes the projection reconcile its visible commit set. Pretending
every changed SHA was newly committed would leave stale or duplicate chips. The
commits endpoint remains the source for the diff selector and the current branch
inventory, so an amended commit appears there as its replacement SHA; obsolete
pre-amend SHAs are transcript history, not selectable branch history.

When a worktree fast-forwards onto its base, the incoming commits collapse into
one expandable `Merged <base> - N commits` row. Its expanded list connects to
the summary as one surface: the list's top border runs along the exposed
shoulders and opens beneath the summary. It draws the commits on a continuous
vertical graph that reaches the list edges, and uses the shared commit card for
each row's hover details. Commit subjects wrap inside ordinary pills, merge
summaries, and expanded merge rows, while their SHA and change totals remain
visible. Ordinary commit pills use the same edge-to-edge graph line around their
single commit dot. Hydra also
observes every chat that owns a merge destination before merging another head
into it, then labels the resulting fast-forward or merge commit with the
incoming branch. This works for both managed worktree branches and a
project-directory chat whose checkout is on the destination branch. Ordinary
project-directory commits have no incoming-branch hint and remain ordinary
one-commit rows.

## Project-directory Changes inspector

A Head with `workspace_kind = project_directory` has the same Changes inspector
as a `worktree` Head. It opens with the inspector hidden; **Show diff** reveals
it when needed. When the Head is created, Hydra resolves the checkout's current `HEAD` and
persists it as `workspace_base_ref`. The default selector range is **Chat start**
to **Project directory**: the starting commit is the left side, and the shared
project root - committed, staged, unstaged and untracked state together - is the
right side. Selecting Latest commit or an individual commit pins the right side
to that committed ref instead.

This is deliberately a project-state comparison, not an ownership claim. The
directory is shared, so edits made by another Head, a user shell or an editor are
visible too. A checkout that was already dirty when the chat started also shows
those edits: the durable baseline is the starting commit, not a hidden snapshot
of the initial dirty tree. Switching the shared checkout to another branch does
not rewrite the baseline; the inspector continues to show the literal tree
difference from the chat's starting commit.

Tests and previews resolve the selected right side. Diff artifacts resolve both
selected sides, so their before/after matches the code comparison. The project-directory
Head remains branchless throughout: commit inventory walks from
`workspace_base_ref` to the shared checkout's `HEAD`, and uncommitted reads use
the project root rather than synthesizing a Hydra worktree.

## Queued messages

A queued message lives only in the checkpointed queue projection and rides in
`state_snapshot` with its stable client-generated id, enqueue sequence and
content. It is deliberately absent from history - the provider has not received
a turn yet. Dequeuing removes it from the projection and emits no conversation
event. Messages not typed in the composer also retain their `origin`, `reason`,
and `source_agent_id` provenance fields in the queue snapshot.

Draining the queue is one logical transition: append a durable `user_message`
carrying the same client id, remove that id from the queue projection, advance
the watermark, then deliver the provider turn. The browser reconciles its
pending bubble into the settled message by client id rather than rendering a
second one, and the message then pages normally with the rest of the log. On
reconnect a message is therefore observed either in the queue snapshot or as a
durable event (or, mid-delivery, as a marked sending entry) - never as neither
and never as both. Loading an older page cannot disturb the queued-message tray.

Delivery carries a small state (`queued`, `sending`, `accepted`) rather than
treating the stdin write as infallible. Recovery retries only when the provider
protocol honours an idempotency or client id; otherwise Hydra surfaces an
uncertain delivery state instead of silently sending a possibly duplicated turn.

While a turn runs, the composer keeps Queue as its primary action and Enter's
default: a queued message is durable and can be recalled until it drains. Its
separate Send now action writes a message to the provider immediately, asking it
to steer at its next input boundary. It does not interrupt or replace the
current turn, and cannot be recalled after it is handed to the provider.

## Presentation

`AgentChat.tsx` consumes the event log and converts each event into the
presentation shapes its card renderers already understand
(`toProviderEvents`). Normal cards show semantic fields; the
provider's own payload stays available under Raw, and blocks Hydra reconstructed
rather than received are marked synthetic so Raw does not present them as
protocol payloads the provider never sent.

**Session breaks.** A `session_resumed` event renders as a divider at its
durable position in the conversation. The divider includes a self-updating
relative time, with the exact local date and time on hover, so multiple process
replacements remain distinguishable. Older events without a usable timestamp
keep the plain `Resumed` label.

**Streaming.** The first delta opens the live block and the completed message
closes and replaces it in the same render batch, so a preview cannot briefly
disappear before the final Markdown is committed. Provider content-boundary
notifications are state hints, not a second set of presentation events. A
sub-agent's deltas are not routed into the main bubble - its completed blocks
arrive through its own card.

**Sub-agents.** `subagent_completed` is the single presentation event for a
completion chip; Claude's task-notification normalizer emits it instead of also
emitting a notice, and the browser deduplicates by `seq` across history and live
catch-up. Codex Agent items use their spawning tool id as a temporary sub-agent
identity, merged into the durable projection once app-server reports the child
thread id, so live display, replay and completion notices all refer to one rich
card. Because `spawnAgent` completion does not always carry the child thread id,
the ingestion worker remembers pending spawn items and links the next unseen
sidechain thread to the oldest pending spawn; the same correlation is rebuilt
while processing `thread/read`. A sidechain transcript folds into its
originating agent tool card instead of creating a second standalone card, and
Claude's machine-readable continuation/usage trailer is stripped from the
visible report.

**Reasoning.** Reasoning text and reasoning duration are separate events. Some
Claude models expose an empty reasoning block but still report a measured
duration; replay pairs the two in either order and renders the duration-only
block as `Thought for Xs`, so hidden reasoning stays visible without inventing
thought content.

**Rich items.** Codex `fileChange` items are classified as Write, Edit, Move or
Delete cards and render each affected path as a syntax-highlighted unified diff.
Web search starts with an unknown query because app-server supplies it on
`item/completed`; the card is patched in place when that metadata arrives rather
than exposing the temporary item id. A completed tool event can carry richer
input than its earlier started event, and a sidechain report can be separated
from its spawn by a page boundary, so the browser retains completed tool
metadata by item id and enriches the matching start card - a remount or
scroll-back renders the same search query, plan activity and sub-agent report as
the original live session.

**Shell output.** Command strings are decoded as shell-quoted arguments,
including concatenated quote segments, nested `bash -lc`, and Bash or Zsh
launchers under `/bin`, `/usr/bin`, and `/usr/local/bin`. An empty `--format=`
on `git show` is treated as a patch with its commit header suppressed, so its
diff keeps source-aware highlighting. An interactive launcher such as `bash -lc
bash` may receive its real command through stdin;
where app-server exposes that only as the first PTY echo, the UI promotes the
echo to the command panel, labels it inferred terminal input, and renders the
cleaned remaining transcript as output. CRLF is a newline; only a bare carriage
return has overwrite semantics. Common ANSI SGR colours render; full terminal
emulation is out of scope.

## Simulation fixtures

`/agent/agent-chat` and `/agent/agent-chat-codex` serve canned conversations
over the same contract (`internal/http/simulation_chat.go`). The fixtures are
written directly as chat events, and each one names the rendering
behaviour it guards, so the simulation is a fair test of the reducer rather than
a happy path. The simulated socket also answers `load_events_before` and
`load_subagent`, so pagination is exercised the way a real client uses it.

`internal/http/simulation_chat_test.go` asserts the invariants that make the
fixtures worth having: paging the canned log with the returned cursor visits
every event exactly once in order, the initial window is the newest events, each
sub-agent has steps to show when its tab opens, and the derived snapshot settles
every sub-agent the log completed.

## Design decisions

- **One app-server process per chat head.** This matches Hydra's process and
  session ownership and isolates lifecycle, cwd, environment, sandbox and
  crashes. A shared daemon would complicate ownership and make one process a
  blast radius for unrelated heads.
- **Exact thread ids, persisted.** `resume --last` is unsafe in a multi-head
  orchestrator.
- **Normalize at the daemon boundary.** Rendering two raw provider protocols in
  one React reducer would couple the UI to both CLI release trains.
- **Queue-first semantics.** An ordinary follow-up is queued, not steered.
- **A Hydra-owned event log rather than private provider transcripts.**
  App-server exposes thread reading and listing APIs, but owning the log keeps
  rendering stable across installed Codex versions and gives a home to events
  that are UI state rather than conversation items.
