# VS Code extension

Status: in development.

Hydra's VS Code extension provides a deliberately smaller local-agent product
than the Hydra web application. It runs Claude Code and Codex in Hydra's existing
OS sandbox, renders their provider-neutral structured chat in a VS Code sidebar,
and lets the user switch data-driven permission profiles without requiring a
Hydra daemon, managed worktree, test runner, preview, or artifact pipeline.

This document is the implementation plan and records the boundary between the
shared Hydra runtime and the VS Code-specific product. Each implementation
commit updates the status and decisions here as the corresponding slice lands.

## Product boundary

The initial extension includes:

- Claude Code and Codex conversations with streaming text, reasoning, and tool
  output;
- durable local chat history and resumable provider conversations;
- profiles selected per chat and cycled with Shift+Tab;
- inline profile prompts;
- filesystem, tool, MCP, network, and Git policy;
- one-shot, chat, workspace, and user/profile approval scopes;
- a Markdown composer;
- collapsed tool/reasoning steps with expandable details;
- inline expandable sub-agent activity;
- read-only Git metadata plus guarded Git mutation tools; and
- a profile editor and historical-chat list in the sidebar.

It deliberately excludes Hydra projects and heads, managed worktrees, tests,
previews, artifacts, publishing, collaboration between Hydra heads, and the
Hydra HTTP/web server. The opened VS Code workspace is the agent workspace. A
user who wants isolation through a separate Git worktree opens that worktree in
a separate VS Code window.

Gemini and external integrations such as GitHub, Graphite, Grafana, kubectl, and
BigQuery are extension points after the initial Claude/Codex release. The policy
schema represents them from the start, but the initial UI does not imply that an
unimplemented integration is available.

## Architecture

The extension has two shipped components:

```text
VS Code workspace extension
  - extension host controller
  - React Webview sidebar
  - settings and approval storage
  - one child process per running chat

hydra-agent-host (Go child process)
  - Claude/Codex provider controller
  - normalized chat store and projection
  - filesystem/process sandbox
  - filtering egress proxy
  - policy gate and approval bridge
  - guarded Git operations
```

There is no background daemon in the initial architecture. The extension starts
one `hydra-agent-host` process for each running conversation and communicates
over newline-delimited JSON on stdin/stdout. Stderr is diagnostic logging only.
Inactive historical conversations have no process. Restarting VS Code launches
a new host process only when a conversation is resumed.

The extension declares itself as a workspace extension. In Remote SSH, WSL, or
Codespaces, its TypeScript and Go helper therefore run on the workspace side,
beside the files and provider installations they operate on.

## Shared schemas

Schemas remain the source of truth and generate both Go and TypeScript types:

```text
api/chat.yaml          normalized conversation events and stream frames
api/policy.yaml        authored profiles and resolved sandbox policy
api/agent-host.yaml    extension-to-host commands and host-to-extension frames
api/openapi.yaml       Hydra server API, referencing the shared schemas
```

Extraction is incremental. `api/chat.yaml` is the focused generation entry point
and currently references the canonical definitions in `api/openapi.yaml`; the
agent-host protocol already imports it as a separate Go package boundary. The
event definition bodies move behind that entry point once the VS Code client is
generating its TypeScript contract, with conformance tests preventing drift.

### Chat representation

The existing normalized chat contract is reused unchanged wherever possible.
Every durable event has:

```json
{
  "seq": 42,
  "source_id": "provider-specific-deduplication-key",
  "type": "assistant_message",
  "timestamp": "2026-09-06T12:00:00Z",
  "payload": {}
}
```

The append-only JSONL event log is the conversation history. Its monotonic `seq`
is the replay cursor. Provider identifiers remain in payloads and never define
transport identity. The bounded projection holds only current state such as the
active turn, streamed partial block, plan, sub-agent graph, pending interaction,
model, queue, and usage. A visible history window is never the source of truth
for current state.

The existing event vocabulary already covers messages, streaming deltas,
reasoning, tools, plans, sub-agents, interactions, turn boundaries, errors,
usage, model changes, queued messages, and Git observations. The extension adds
`profile_changed` only if recording a profile transition cannot be represented
cleanly as existing context and notice events.

### Host transport

The stdio transport reuses the semantic halves of Hydra's chat WebSocket:

Host to extension:

- `hello`, including the exact protocol and host versions;
- `state_snapshot`;
- `chat_history` and `replay_done`;
- `chat_event`;
- `subagent_events`;
- `queue` and `pending_questions`;
- `approval_request` and `approval_expired`;
- `operation_result`; and
- `chat_error`.

Extension to host:

- `initialize`, including the workspace, conversation directory, provider, and
  fully resolved effective policy;
- `user_message`;
- `interrupt`;
- `set_model`;
- `control_response` and `approval_response`;
- `load_events_before` and `load_subagent`;
- `update_policy`; and
- `shutdown`.

Every request that needs a direct result carries a client-generated request ID.
Conversation events continue to use `seq`; request IDs never become history
cursors. The extension and helper ship together and require an exact protocol
version rather than carrying compatibility aliases.

## Shared Go runtime

The repository stays one Go module initially. A dedicated
`cmd/hydra-agent-host` imports shared `internal` packages, so no package needs to
be public merely to support a second command in the same repository. Go's linker
omits the unreferenced Hydra HTTP server and frontend.

The extension host must not import `internal/heads`, which owns Hydra-specific
project, worktree, database, lifecycle, test, preview, and artifact behavior.
Reusable behavior is moved behind focused packages and interfaces:

```go
type Provider interface {
	Start(context.Context, StartOptions) error
	Send(context.Context, json.RawMessage) error
	Interrupt(context.Context) error
	Respond(context.Context, json.RawMessage) error
	SetModel(context.Context, string) error
	Close() error
}

type Approver interface {
	Request(context.Context, ApprovalRequest) (ApprovalDecision, error)
}
```

Hydra and `hydra-agent-host` provide separate lifecycle and approval adapters.
The provider normalizers, chat store/projection, sandbox, egress boundary, gate,
and guarded Git operations remain shared implementations.

The shared session registry can launch structured providers directly with
protocol-safe stdin/stdout pipes when `sandbox.Options.StdioPipes` is set. This
path is independent of Hydra's namespace-host/head controller, keeps stderr out
of the JSON stream, and is the process primitive used by the standalone host.

The chat store and normalizing manager accept an explicit conversation directory
instead of deriving one exclusively from a Hydra project/head. Hydra preserves
its existing head state layout; the extension passes a directory beneath VS Code
extension storage and receives the same normalization, projection, paging, and
live-watch behavior.

## Profiles and policy

`api/policy.yaml` defines and generates Go models for two related shapes:

- `Profile` is user-authored and may contain portable paths such as `src`, `~`,
  `${workspaceFolder}`, `${workspaceFolder:name}`, and `${userHome}`.
- `EffectivePolicy` contains canonical absolute paths, resolved tools and MCP
  permissions, concrete network mode and hosts, and resolved Git restrictions.
  This is the only form passed to the Go host.

Generated types provide structural correctness. The Go host independently
validates the effective policy and canonicalizes filesystem targets before using
them; generated types are not a security boundary.

Profiles are registered under `hydra.profiles`, with
`hydra.defaultProfile` and `hydra.profileChangeBehavior` as adjacent settings.
The inline `prompt` is the normal path; prompt files are not required. The custom
Profiles view edits the same registered JSON configuration used by VS Code's
Settings UI and `onDidChangeConfiguration` reloads it.

The initial profile policy contains:

- core tool decisions (`allow`, `ask`, or `deny`);
- readable, writable, copy-on-write, and masked paths;
- network mode, allowed hosts, and blocked hosts;
- Git isolation and protected branch patterns;
- MCP server and individual-tool decisions; and
- provider/model/prompt configuration.

Relative paths resolve against the chat's selected workspace folder. Arbitrary
environment-variable substitution is not supported initially. The UI shows the
canonical target before saving a grant. Writable paths are readable. Masks and
explicit blocks win over grants.

### Security domains

The permissions UI distinguishes three execution domains:

1. Sandboxed workspace tools: Read, Search, Edit, Bash, and Fetch. The whole
   provider process and its descendants are inside the filesystem and network
   sandbox; the tool policy is defense in depth and user intent.
2. Local tool servers: stdio MCP servers and other locally spawned integrations.
   They run inside the same sandbox and are stripped before launch unless the
   effective policy permits them.
3. External integrations: remote MCP and brokered services such as GitHub or
   Grafana. They receive no implicit filesystem access and use their own
   account, tool, and mutation approvals.

Each tool row states where it runs, which filesystem/network policy applies, and
whether it can cause external side effects.

### Filesystem defaults

The workspace is readable and writable by default, except that the resolved Git
common directory is recursively read-only. The rest of the user's home is absent
unless required for the selected provider or explicitly granted. Only the
selected provider's state is mounted. Known credential locations are masked
after all read/write grants. Mutable tool state and caches use per-conversation
private directories unless configured otherwise.

Read access to a missing path produces an approval that shows the requested and
canonical paths. Applying an access grant rebuilds the sandbox before the agent
continues. A profile change never silently loosens a running sandbox.

### Network defaults

Core processes use Hydra's filtering egress boundary. Provider API endpoints and
the minimal infrastructure required to authenticate are built-in allowances.
Other hosts are denied until approved. `Fetch` is allowed as a tool by default,
but its destination still passes through the same network policy as Bash,
package managers, Git, and every other sandboxed process.

The UI distinguishes hard enforcement (network namespace permits traffic only
through the filtering proxy) from advisory enforcement (proxy environment
variables that a determined process could bypass). Blocked hosts override built-
in and user allowances.

### Approval scopes

The approval choices are:

- once: only the current operation or connection;
- chat: held in the active conversation's state;
- workspace: stored in VS Code `workspaceState`, keyed by profile and canonical
  resource, and never written implicitly to repository-controlled
  `.vscode/settings.json`;
- profile: written to the user-level profile and eligible for Settings Sync.

Profile declarations, chat grants, workspace grants, and one-shot grants form
the effective allow set. Masks and blocks form the final deny set. A separate
explicit action can promote a workspace grant into the user profile.

Network "once" means the current connection to the displayed origin, not one
HTTP request inside a reusable TLS tunnel. Approval wording reflects what the
egress boundary can enforce.

### Switching profiles

The active profile is conversation state, not a global setting. Shift+Tab cycles
profiles when the composer has focus. An idle conversation switches immediately.
During a running turn, `hydra.profileChangeBehavior` supports:

- `ask` (default): choose Interrupt and switch, Switch after this turn, or
  Cancel;
- `interrupt`: interrupt, settle the turn, rebuild the sandbox, and switch; or
- `nextTurn`: retain the current policy until the next turn.

Changes from `onDidChangeConfiguration` use the same behavior. The event log
records the transition and which turn first used the new effective policy.

## Git

The sandbox exposes the complete resolved Git common directory read-only. Native
read commands (`status`, `diff`, `log`, and `show`) therefore work in Bash while
all `.git` mutation is stopped by the OS boundary.

Mutations use guarded host-side operations shared with Hydra. The initial UI
ships commit, checkout, reset, revert, merge, and rebase operations only when the
corresponding profile capability is enabled. Every operation revalidates the
workspace, current branch, expected head, target branch, dirty state, and
protected-branch rules immediately before execution. The agent never receives a
generic unsandboxed shell as a Git capability.

## VS Code UI

The extension contributes one Activity Bar container and one sidebar Webview.
React is an implementation detail inside the Webview; the extension host remains
authoritative for processes, persistence, configuration, and approvals. The two
sides communicate through typed `postMessage` messages.

The sidebar contains:

- a compact toolbar with New chat, History, current profile, and Settings;
- the live or historical conversation;
- collapsed reasoning and tool steps, expandable in place;
- sub-agents nested under their spawning tool and loaded on expansion;
- queued-message and approval cards;
- a Markdown multiline composer with streaming-safe draft preservation;
- a historical-chat list; and
- a Profiles/Permissions editor with core tools first and expandable local MCP,
  remote MCP, filesystem, network, and Git sections.

Provider deltas are batched from the extension host to the Webview at most once
per animation frame rather than one message per token. The Go event store remains
authoritative, so hiding or recreating the Webview cannot stop or lose a stream.

The first implementation follows VS Code theme tokens and accessibility APIs.
It does not copy Hydra's entire Tailwind/component system. Markdown parsing and
sanitization are shared conceptually, with Webview-safe link and command routing.

## History

Conversation data is local machine state beneath the extension's global storage
root and is not Settings Sync data. Each conversation owns:

```text
conversations/<id>/
  metadata.json
  events.jsonl
  projection.json
  provider.json
  private/
```

Metadata contains title, workspace identity, provider, model, active profile,
creation/update timestamps, and resumability. The history list can begin with an
atomically rewritten index and move to SQLite only when scale demonstrates a
need. Deleting a chat is explicit and reports whether provider-side history can
also be removed; the initial implementation deletes only Hydra-owned extension
state.

## Packaging

`vscode/` is an independent TypeScript package. Its release build produces an
extension-host bundle, a React Webview bundle, styles/assets, and one platform-
specific `hydra-agent-host` executable. Marketplace releases are targeted per
platform and architecture rather than putting every native binary in one VSIX.

The package generates one TypeScript type graph from `api/agent-host.yaml` with
`openapi-typescript`, typechecks both extension and Webview code, and bundles
them independently with esbuild. The initial contributed Activity Bar container,
sidebar Webview, commands, registered `hydra.*` settings, profile resolution,
native-host controller, and React shell are in `vscode/`.

The initial support matrix is:

| Environment | Initial status |
| --- | --- |
| Linux x64 | supported, hard sandbox when required helpers are available |
| Linux arm64 | supported after CI packaging coverage |
| macOS arm64/x64 | supported after the existing Seatbelt backend passes host tests |
| Windows | deferred; WSL uses the Linux workspace extension |

Claude Code and Codex are detected from the workspace extension host's `PATH` or
explicit `hydra.providers.*.path` settings. They are not bundled. The helper and
extension perform an exact protocol-version handshake and fail clearly when the
packaged pair is inconsistent.

## Delivery plan

Each checkbox is completed in a logical commit, with this document updated in
that commit.

- [x] Document the product boundary, shared contracts, security model, and
  delivery sequence.
- [ ] Extract shared chat, policy, and agent-host schemas with Go/TypeScript
  generation and conformance tests.
- [x] Add a directory-based chat store API without changing Hydra's existing
  head storage behavior.
- [x] Add the standalone `hydra-agent-host` stdio command and protocol handshake.
- [ ] Run Codex through the host with streaming, send, interrupt, model changes,
  history, and resume.
- [ ] Run Claude through the same host contract with streaming, controls,
  history, and resume.
- [ ] Resolve and validate profiles, launch the whole provider inside Hydra's
  filesystem sandbox, and rebuild safely on grants/profile changes.
- [ ] Connect hard/advisory egress filtering and interactive network approvals.
- [ ] Connect local MCP governance, core-tool policy, and approval scopes.
- [ ] Connect read-only Git metadata and guarded mutation tools.
- [ ] Scaffold and package the VS Code extension and native helper.
- [ ] Implement the React sidebar, streaming chat, Markdown composer, hidden
  steps, expandable sub-agents, and interruption.
- [ ] Implement history and profile/permissions editors, configuration reload,
  Shift+Tab switching, and scoped approvals.
- [ ] Add focused Go/TypeScript tests, real Extension Development Host coverage,
  platform packaging checks, documentation, and release instructions.

## Acceptance criteria

The initial release is complete when a user can install a platform-specific
VSIX, open a trusted workspace, start or resume either a Claude or Codex chat,
watch streamed output, inspect expandable tool/sub-agent activity, switch
profiles, answer provider and sandbox approvals, and reopen the conversation
from History without running the Hydra server. Bash and all provider descendants
remain within the selected filesystem/network boundary, Git metadata is
read-only except through guarded tools, and the extension gives an explicit
warning whenever only advisory network enforcement is available.
