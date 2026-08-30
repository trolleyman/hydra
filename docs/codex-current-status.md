# Codex current status

The detail line under a Codex head in the agent list shows the newest meaningful
thing in its ordered app-server stream. It is not a separate phase estimate and
does not rotate through placeholder words once Codex has reported useful work.

## Precedence

Each newer meaningful item replaces the line before it:

1. A tool's `item/started` notification supplies a short activity description.
2. That description remains visible after the tool completes.
3. A completed assistant message replaces the preceding tool description.
4. When the turn settles, the same latest item remains visible.
5. A structured user-input request replaces the line with its first question.

Reasoning items and the start of an assistant-message item do not clear the
previous detail. They are lifecycle edges, but they do not yet contain a newer
user-facing thing. Before the first meaningful item in a turn, the web UI may
show its stable running placeholder.

The app-server controller writes tool details into both `activity` and
`last_message` in `status.json`. The running agent list reads `activity`; the
settled list reads `last_message`. Writing both is what carries a latest tool
across a turn that finishes without a later assistant message. The status poller
persists these fields on the agent row and emits the ordinary
`agent_status_changed` event, so refresh and reconnect use the same value.
Tool descriptions and questions are explicitly marked as status detail, not as
suggested next messages, so the web UI does not add its `>` suggestion caret.

## Tool wording

Descriptions prefer useful structured input and stay short enough for the
single-line sidebar surface:

- A Bash command whose script starts with `# description` displays that line
  verbatim as `# description`. This matches the description on its chat tool
  card and avoids guessing at a grammatical rewrite.
- Other Bash commands display `$ command`, truncated when necessary.
- File changes display `Editing file.go`, `Writing file.go`, or
  `Deleting file.go`; a multi-file item displays its count.
- Web searches include the query, and image views include the file name.
- MCP tools and unknown item types use `Using <friendly tool name>`.
  Provider syntax is removed, so `mcp__hydra__get_head_status` becomes
  `Using Get head status`.

If an item has no usable structured fields, the description falls back to a
generic action such as `Running a command`, `Editing files`, or `Using tool`.

## Questions and final messages

A Codex `requestUserInput` request exposes its actual questions. The detail line
shows the first non-empty question rather than repeating a generic waiting
label; the `needs input` status chip already communicates that the head is
blocked on the user.

Assistant messages are stored as written. The sidebar's existing single-line
renderer collapses the content and truncates it to the available width, so the
visible result is the start of the latest/final message without maintaining a
second generated summary.
