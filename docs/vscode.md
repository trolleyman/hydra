# VS Code extension

Status: initial implementation complete.

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
- a Markdown composer with model selection, queued/immediate sends, and files;
- browser-compatible thought disclosures and grouped, expandable tool steps;
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

The standalone host now launches both structured providers through that path.
Claude uses stream-json and Codex uses app-server plus the shared Codex
controller. User messages are durably appended at the host boundary and then
sent through the provider-neutral session driver; provider output, recovered
Codex history, streaming deltas, interrupts, interaction responses, and model
changes feed the same normalized event manager. The provider-native session ID
is atomically recorded in `provider.json` for exact resume.

Provider processes inherit an allow-listed environment shared with Hydra heads,
including credentials only for the selected provider. Their private temp/cache
state lives beneath the conversation. Missing provider state paths are staged
there instead of being created in the user's home. Existing state for only the
selected provider is mounted. Claude receives an immutable empty user settings
file plus a strict filtered MCP file; Codex receives an immutable filtered
config with ungoverned hooks disabled and a profile-prompt `AGENTS.md`. Neither
standalone config injects Hydra's daemon/head control MCP server.

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
Settings UI and `onDidChangeConfiguration` reloads it. Each profile has a stable
settings key and an optional user-facing `name`; the bundled `plan` and `edit`
profiles render as Plan and Edit. The editor can save to user settings, which
are eligible for Settings Sync, or workspace settings.

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

Both providers load an immutable, gate-only hook configuration generated by the
standalone host. The packaged helper is mounted read-only into the sandbox and
its hook entry point evaluates the shared Hydra gate policy before a tool runs.
Profile decisions apply to Read, Search, Edit, Bash, and Fetch aliases from both
providers. An explicit allow still passes through invariant credential,
settings-tamper, unsafe process-kill, network, and Git checks. Ask decisions use
the same scoped approval cards as egress; a chat-or-longer grant updates the
live immutable policy source so later calls do not prompt again.

Provider tool names remain an implementation detail in the editor. For example,
Claude's `LS` tool is a structured directory listing and maps to Search. A
literal `ls` inside a shell script maps to Bash and remains limited by filesystem
readability.

MCP configuration and invocation are two separate checks. A denied or entirely
ungranted local server is removed before the provider starts, so its executable
never runs. An allowed server, or one with at least one allowed tool, is retained
in the provider config; the hook then enforces whole-server and per-tool
allow/ask/deny decisions on every invocation. This is why enabling a previously
unstarted server requires a sandbox rebuild, while approving another tool on an
already-running partially enabled server can take effect within the chat.

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

Unknown destinations now travel over `approval_request` / `approval_response`
frames while the proxy parks the connection. A one-shot allow admits only the
connection attempts coalesced on that prompt; chat, workspace, and profile
allows enter the live proxy allow-list. Chat grants remain in the native host
across a profile-driven sandbox rebuild. Workspace grants are held in VS Code
`workspaceState`; profile grants update the user-level `hydra.profiles` value.
Both persistent scopes are merged into later effective policies by the
extension. Denies and timeouts never become grants.

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

The extension validates authored profile value kinds and decisions before path
resolution. The native host then verifies provider/network/Git enums, tool and
MCP decisions, the real host home, absolute paths, and symlink-canonical path
prefixes. An applied profile stops the old provider, rebuilds every immutable
seed and sandbox mount from the new effective policy, resumes the selected
provider's own saved session, and records a notice in the event log. Session IDs
are retained independently for Claude and Codex when a chat switches between
them. “After this turn” is held by the extension until a normalized terminal
turn event; it is never sent to a host that would apply it early.

## Git

The sandbox exposes the complete resolved Git common directory read-only. Native
read commands (`status`, `diff`, `log`, and `show`) therefore work in Bash while
all `.git` mutation is stopped by the OS boundary.

Mutations use guarded host-side operations shared with Hydra. The initial UI
ships checkout, commit, add, reset, revert, cherry-pick, merge, rebase, and stash operations only when the
corresponding profile capability is enabled. Every operation revalidates the
workspace, current branch, expected head, target branch, dirty state, and
protected-branch rules immediately before execution. The agent never receives a
generic unsandboxed shell as a Git capability.

The standalone `hydra-agent-host mcp` process is intentionally not the full
Hydra control server. It advertises only the profile-enabled `git_*` tools and
passes requests over a private file queue to the parent host. An omitted or
`deny` operation is not advertised, `ask` enters the standard once/chat/workspace/
profile approval flow, and `allow` runs directly. The parent rejects a request if
the checkout moved since it was submitted or the current branch matches a
protected-branch glob. The provider continues to see `.git` read-only.

## VS Code UI

The extension contributes one Activity Bar container and one sidebar Webview.
React is an implementation detail inside the Webview; the extension host remains
authoritative for processes, persistence, configuration, and approvals. The two
sides communicate through typed `postMessage` messages.

The view title toolbar contains New chat, History, Profiles, and Move View. The
Webview itself contains:

- the current profile switcher;
- the live or historical conversation;
- collapsed reasoning and tool steps, expandable in place;
- sub-agents nested under their spawning tool and loaded on expansion;
- provider question and sandbox approval cards;
- a Markdown multiline composer with streaming-safe draft preservation;
- a historical-chat list; and
- a Profiles/Permissions editor with core tools first and expandable local MCP,
  remote MCP, filesystem, network, and Git sections.

VS Code extension manifests can contribute an Activity Bar or Panel container,
but not an initial Secondary Side Bar container. `Hydra: Move View...` opens VS
Code's built-in destination picker with the Hydra view selected; choosing
Secondary Side Bar moves it there, and VS Code persists that placement.

Provider deltas are batched from the extension host to the Webview at most once
per animation frame rather than one message per token. The Go event store remains
authoritative, so hiding or recreating the Webview cannot stop or lose a stream.

The Webview uses React components and a package-local Tailwind build. Its visual
language follows Hydra's browser chat where that fits a narrow editor surface:
restrained user bubbles, unboxed assistant prose, compact expandable activity
cards, a bordered composer, and layered settings cards. Colours remain mapped to
VS Code theme tokens, so the view belongs in the active editor theme instead of
shipping a second light/dark palette.

The extension owns a small set of browser-compatible chat primitives rather
than importing the web application's complete `AgentChat` component. That
component also owns Hydra routes, stores, project/head state, responsive app
shell, and server API bindings. Thought disclosures, working indicators, step
groups, tool rows, question cards, commit and attachment chips, and composer
controls intentionally use the same interaction contracts so they can move to
a shared presentation package without pulling the full browser shell into the
extension.

The composer queues Enter submissions while a turn is running and exposes a
separate immediate-send action for steering the active turn. Queued messages
remain visible beneath the live response and are sent in order at normalized
turn boundaries. The model picker uses the selected profile's provider models.
The attachment picker stores readable file paths in the provider-neutral user
message and renders them as chips; provider access to a selected path still
passes through the active profile's filesystem sandbox.

The Webview bundles the same Inter, Merriweather, and Fira Code typefaces as the
browser chat for interface, prose, and code respectively. The
`hydra.appearance.*FontFamily` and `hydra.appearance.*FontSize` settings can
override all three roles without changing profile data.

Markdown parsing and sanitization are shared conceptually, with Webview-safe
link routing. Small reusable Webview primitives centralize buttons, fields, page
headings, and theme treatments; chat, history, and profiles are separate React
components rather than one sidebar-sized component.

Question tools use one provider-neutral card. Claude's `AskUserQuestion` control
request and Codex's `item/tool/requestUserInput` request normalize into the same
multi-question representation. Cards support single-select and multi-select
options, option descriptions, free-text answers, and optional notes. Single
choice and free text are mutually exclusive; every question needs an answer
before submission. The response is sent through `control_response`, a failed
provider write makes the card retryable, and terminal or resolved historical
questions render read-only rather than pretending they can still be answered.

Profiles can be created, edited, and removed from the Profiles page. Saving can
target user or workspace settings; removing a definition at one scope reveals
the next VS Code configuration layer, including the bundled Plan/Edit defaults.
Advisory and unrestricted network profiles display a persistent warning in the
chat rather than relying on a transient notification.

Profile sections keep policy explanations behind compact information controls.
The Core tools explanation distinguishes availability from sandbox authority:
Allow suppresses a tool-level prompt, but Read/Search still require readable
paths, Edit still requires writable paths, and Bash/Fetch still obey filesystem
and network policy. Decision selectors render user-facing labels in title case
while preserving lowercase schema values.

### Bash progress

The Bash presentation uses normalized tool start, output, and completion events
plus the tool description and working directory. Simple `&&` chains are shown
as individual command stages inside the expandable step. It does not inject
`echo` headings into user commands. This provides useful progress for common
generated commands without claiming shell-level instrumentation.

Bash can expose the currently executing simple command through a `DEBUG` trap or
through `set -x` with a dedicated `BASH_XTRACEFD` and machine-readable `PS4`.
That is feasible for a wrapper-owned Bash process, but it is not a reliable
general progress protocol: scripts can replace traps, invoke another shell,
disable tracing, emit secrets after expansion, or depend on exact tracing
behavior. Hydra therefore keeps shell tracing off by default. A later opt-in
implementation should emit structured command-boundary frames from a dedicated
file descriptor, redact expanded arguments, and describe itself as best-effort;
provider tool events remain the authoritative lifecycle.

### Native VS Code Chat

The custom Webview remains the primary surface because it owns profile
switching, historical conversations, provider question forms, and Hydra's four
approval scopes. VS Code's [Chat Participant API](https://code.visualstudio.com/api/extension-guides/ai/chat)
can later provide an optional `@hydra` adapter that forwards a prompt to the same
agent host and mirrors Markdown/progress into the native Chat view. It does not
replace the helper or policy boundary.

Hydra does not register Claude or Codex as a Language Model Chat Provider in the
initial release. Their CLIs already own an agent loop, tools, resume state, and
authentication, while that API models provider responses consumed by VS Code's
own chat orchestration. Brokered integrations can instead be exposed later as
[Language Model Tools](https://code.visualstudio.com/api/extension-guides/ai/tools),
and portable integrations can remain MCP servers. These are adapters around the
same policy model, not a second execution path.

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
The package commits `package-lock.json`; Aube is the primary package manager and
consumes that lock directly, so development and release jobs use the exact same
dependency graph without an Aube-specific lockfile.

The package generates one TypeScript type graph from `api/agent-host.yaml` with
`openapi-typescript`, typechecks both extension and Webview code, bundles the two
JavaScript entry points independently with esbuild, and compiles the Webview's
Tailwind stylesheet with the local Tailwind CLI. The contributed Activity Bar
container, sidebar Webview, commands, registered `hydra.*` settings, profile
resolution, native-host controller, and React shell are in `vscode/`.

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

From `vscode/`, `aube install` consumes `package-lock.json` without creating a
second lockfile. `aube run check` regenerates protocol types, typechecks, and
tests the conversation/question projection before bundling the extension and
Webview. `aube run build:host` builds the helper for
the current platform. `aube run package -- --target <platform-arch>` cross-builds the
matching helper with CGO disabled and asks `vsce` for a target-specific VSIX.
Supported target spellings are `linux-x64`, `linux-arm64`, `darwin-x64`,
`darwin-arm64`, `win32-x64`, and `win32-arm64`.

`aube run test:extension` runs an activation/manifest/command smoke test in a
real Extension Development Host. It downloads stable VS Code on first use; set
`HYDRA_VSCODE_EXECUTABLE` to an existing executable to avoid the download. The
test requires a graphical host session on Linux. Install a packaged build for a
manual provider test with:

```bash
code --install-extension hydra-linux-x64-0.1.0.vsix --force
```

## Delivery plan

Each checkbox is completed in a logical commit, with this document updated in
that commit.

- [x] Document the product boundary, shared contracts, security model, and
  delivery sequence.
- [x] Expose shared chat, policy, and agent-host schemas with Go/TypeScript
  generation and conformance tests.
- [x] Add a directory-based chat store API without changing Hydra's existing
  head storage behavior.
- [x] Add the standalone `hydra-agent-host` stdio command and protocol handshake.
- [x] Run Codex through the host with streaming, send, interrupt, model changes,
  history, and resume.
- [x] Run Claude through the same host contract with streaming, controls,
  history, and resume.
- [x] Resolve and validate profiles, launch the whole provider inside Hydra's
  filesystem sandbox, and rebuild safely on grants/profile changes.
- [x] Connect hard/advisory egress filtering and interactive network approvals.
- [x] Connect local MCP governance, core-tool policy, and approval scopes.
- [x] Connect read-only Git metadata and guarded mutation tools.
- [x] Scaffold and package the VS Code extension and native helper.
- [x] Implement the React sidebar, streaming chat, Markdown composer, hidden
  steps, expandable sub-agents, and interruption.
- [x] Implement history and profile/permissions editors, configuration reload,
  Shift+Tab switching, and scoped approvals.
- [x] Add focused Go/TypeScript tests, real Extension Development Host coverage,
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
