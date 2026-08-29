# Hydra for macOS and focused chat windows

Status: **shared focused-session foundation and initial macOS shell built; native
validation pending.** This
document records the agreed product shape and staged implementation plan for
packaging Hydra as a desktop app and adding a focused, directory-backed chat
experience. The backend, API, and React work described in "Shared implementation
status" is deliberately platform-neutral so macOS, Windows, and Linux shells can
branch from it. A webview framework still needs a native proof of concept before
it becomes an architectural commitment.

The macOS sandbox itself is covered by [macos-support.md](macos-support.md).
Structured provider chat is covered by [chat-mode.md](chat-mode.md). This plan
builds on both and does not replace either.
The standalone Windows and Linux applications are planned separately in
[windows-desktop-chat.md](windows-desktop-chat.md) and
[linux-desktop.md](linux-desktop.md); all three plans branch from the same shared
focused-session foundation.

## Shared implementation status

The cross-platform base now includes:

- focused heads represented by `Branch == nil`, with edit/read-only and guarded
  commit permissions stored on the ordinary agent record;
- branchless spawn, list, archive, autorestart, and exact resume paths which run
  in the registered project root and never create or delete a Hydra worktree;
- a platform-neutral API for creating focused sessions and changing their
  permissions;
- read-only working-directory sandbox input shared by the Linux, Darwin, and
  Windows backends (with enforcement implemented by the non-stub backends);
- guarded focused commits which capture and revalidate both branch and HEAD,
  while rejecting every other host-mediated Git mutation;
- a focused option in the normal spawn UI and a shared chat-only agent layout
  with edit/read-only and commit controls. The layout does not mount the diff,
  tests, artifacts, previews, publish, merge, or review inspector.
- simulation fixtures for editable, read-only, actively working, and archived
  focused chats, including mutable permission controls for browser testing.

This is the intended branch point for platform agents. Native notification
bridges, signing, and OS-specific sandbox completion are not part of this shared
base.
The immediate empty draft, separate chrome-free window route, history/project
switcher, native close confirmation, and concurrent-editor warning also remain
to be built. Today a focused head is created by submitting Hydra's existing
spawn composer, then opens in the shared chat-only layout.

The macOS branch now also contains an AppKit/WKWebView development shell under
`desktop/macos`. It reuses a compatible server on the default loopback address
or launches the bundled backend once on an OS-assigned port, using an atomic
readiness record to discover the URL. Full and focused windows share WebKit
state and one backend. The focused window currently opens the ordinary project
composer with Focused/Edit selected; it does not yet provide the immediate
untitled composer or chrome-free route. See `desktop/macos/README.md` for build
and hardware validation instructions.

## Product in one sentence

Ship one `Hydra.app`, backed by one shared local Hydra service, with two window
types:

- **Full Hydra** - the existing project, head, diff, test, artifact, preview and
  review interface.
- **Focused chat** - a clean single-conversation window attached directly to a
  registered project's real directory, with no branch, worktree, diff, merge,
  test, artifact or review chrome.

Both window types see the same projects and conversations. A focused chat is a
real Hydra session, so it can be found and reopened from full Hydra as well as
from the focused window's history menu.

## Agreed decisions

### One app and one service

- Full Hydra and focused chat ship in one macOS app bundle.
- The app may open several full or focused windows.
- Every window connects to one shared local backend. Opening a second window
  must not start a second daemon, database, agent registry or network proxy.
- Closing the last window does not automatically terminate the backend. Hydra
  remains available through a menu-bar item, especially while work is running.
- Explicit Quit owns backend shutdown. If sessions are active, Quit must explain
  the consequence and offer to cancel, stop them, or leave Hydra running.
- The existing browser-served UI remains supported. The desktop app is another
  trusted client of the same backend, not a fork of it.

### A focused chat belongs to one project forever

- A focused chat runs in the real root directory of one registered Hydra
  project. It does not receive a linked worktree or a Hydra branch.
- The directory is fixed when the first message creates the session. An existing
  conversation never changes directory and is never migrated between projects.
- A new focused window initially selects the project active in the frontmost
  full-Hydra window. If there is no such window, it uses Hydra's persisted last
  project.
- The selected project and display path remain visible in the focused window.
- Before the first message, the user may select a different registered project.
- Choosing another project from an existing chat creates a new untitled chat in
  that project. It does not repurpose the current conversation.
- If the current agent is working, the switch flow offers:
  - **Stop and switch** - interrupt the active turn, then open a new chat.
  - **Keep running in background** - leave it running and open a new chat.
  - **Cancel**.
- If the agent is idle, switching directly opens a new chat while retaining the
  old one in history.

Arbitrary unregistered directories are deliberately out of the first version.
They do not have project identity, trusted configuration or an established
place in Hydra's navigation. They can be revisited after the project-backed
experience is sound.

### Conversation creation and history

- Opening a focused window produces an untitled draft immediately. There is no
  required spawn prompt or setup form before the composer appears.
- The first submitted message atomically creates the backend session and starts
  the provider.
- The provisional title comes from the first message and may be refined by the
  existing asynchronous title mechanism.
- Conversation history is owned by Hydra's chat event store. Provider transcript
  files may still be observed for ingestion, but they are not the product's
  source of truth.
- Importing or resuming arbitrary pre-existing Claude CLI conversations is not
  part of the first version. Exact provider conversation IDs should still be
  persisted so Hydra-created sessions resume normally.
- The history menu lists focused chats, grouped or filtered by project, and can
  reopen one in a new focused window.

### Provider-neutral chat

Focused chat uses the existing provider-neutral event contract. Claude and
Codex remain supported, and adding the desktop surface must not introduce a
Claude-shaped browser protocol. The first implementation may concentrate its
manual validation on Claude, but session APIs and persisted records must carry
the existing `AgentType` and provider conversation ID.

### Direct editing, read-only mode and guarded commits

A focused session has two independent permissions visible near the composer or
window header:

1. **Mode: Edit / Read-only**
2. **Allow commits: On / Off**

Edit is the default for a newly-created focused chat. Read-only is a real
sandbox boundary, not prompt guidance. In read-only mode the project root is
readable but not writable. In edit mode the selected project root is writable
in place, so edits appear immediately in the user's editor and checkout.

Changing Edit/Read-only changes the sandbox profile. It therefore uses a
controlled provider restart and exact conversation resume behind the same Hydra
conversation. The UI must show that transition and reject or queue input until
resume completes. A visible control is required; Shift+Tab may later be added as
an optional shortcut, but must not be the only indication or control.

`Allow commits` is independent of filesystem editing:

- Off: Git status, diff, log and show remain readable, but Git writes are denied.
- On: the agent may use Hydra's guarded commit operation on the currently
  checked-out branch.
- Branch changes, checkout/reset/rebase/cherry-pick/stash, pushes and arbitrary
  Git configuration writes remain unavailable in focused mode initially.
- A commit operation must verify immediately before committing that the project
  root is still on the branch and HEAD observed when the request was issued. A
  stale request fails rather than committing onto a branch the user changed in
  another application.
- A focused session never creates or owns a branch, so commit language and UI
  must not imply that Hydra will merge or archive it.

The commit toggle changes authorization, not the filesystem sandbox, and should
not require a provider restart. Turning it off must affect the next tool request
immediately.

Two edit-mode agents may write the same project concurrently. Hydra should make
that fact visible but does not attempt locking or conflict resolution in the
first version. Read-only focused sessions may safely run alongside writers,
subject to the ordinary fact that their reads can observe files changing.

## Focused window experience

The initial surface contains only:

- the current project name and display path;
- an untitled/current conversation title;
- conversation history access, likely a compact menu button;
- the provider and model selector;
- the Edit/Read-only indicator and control;
- the Allow commits toggle;
- the structured chat transcript;
- the composer and attachments;
- a compact connection/running state.

The chat retains the existing high-value structured elements:

- assistant messages and streaming reasoning;
- tool cards and results;
- plans;
- questions and approvals;
- queued messages and interruption;
- composer shell commands;
- model selection;
- attachment and generated-media display;
- sandbox and network status;
- errors and resume state.

Project settings, including the full sandbox/network policy editor, do not need
to fit into the first focused window. Initially the window may show the resolved
policy read-only and link to that project's settings in a full Hydra window.

The focused route should be its own small component tree rather than a CSS mode
that hides most of `AgentDetail`. `AgentChat` and its supporting controls should
be extracted or composed where necessary, but the focused view must not mount
`DiffViewer`, tests, artifacts, previews, review integration or the full sidebar
and merely conceal them.

### Closing a focused window

Closing an idle chat window closes only the window. The saved conversation
remains available in history.

Closing a focused window during an active turn presents:

- **Interrupt and close**;
- **Keep running in background**;
- **Cancel**.

Background work appears in the menu-bar state and can raise a native notification
when it needs input or finishes. Reopening the conversation attaches to the
existing durable event stream; it must not create a duplicate provider process.

## Native macOS shell

The native layer has a deliberately narrow job:

- own application, window and menu-bar lifecycle;
- start or discover the one shared Hydra backend;
- open full and focused webview windows at the appropriate internal routes;
- communicate the frontmost full window's project to a new focused window;
- provide native Open, New Full Window and New Chat Window commands;
- bridge native notifications and notification clicks;
- implement Quit semantics and active-session confirmation;
- package the Go backend and built web assets without manual setup;
- eventually support signing, notarization and updates.

The React application remains the owner of product UI. Native code should not
reimplement chat rendering, project settings or session state.

### Backend discovery and ownership

The app needs single-instance service coordination that also composes with an
already-running CLI Hydra server:

1. Discover a compatible local Hydra service through a user-scoped endpoint or
   lock record, not a fixed assumed TCP port.
2. If none exists, start the bundled backend and wait for a readiness handshake.
3. Authenticate webviews using a short-lived bootstrap token or an app-owned
   local transport. Do not weaken the existing localhost trust rules merely
   because the client is native.
4. Record whether the app launched the service, but do not tie service lifetime
   to one window.
5. Refuse to attach if the discovered service protocol is incompatible; offer a
   clear recovery path rather than silently starting a competing database owner.

The existing daemon socket and runtime setup are candidates for reuse. The exact
desktop transport and service ownership rules remain an implementation decision
for the native spike.

### Webview framework selection

Do not select a framework from feature lists alone. Build a small macOS spike
that tests the difficult parts with the existing production frontend:

- several independent windows sharing cookies, WebSockets and local storage;
- file uploads and media display;
- keyboard handling in the composer and terminal;
- native notification permission and click routing;
- popup/context-menu behavior;
- accessibility and text input, including IME;
- app activation, deep links and menu commands;
- bundling and launching the Go service;
- development against Vite without changing production routing.

The likely comparison is a thin Swift/WKWebView shell versus a maintained Go or
Rust webview framework. Prefer the smallest shell that exposes the native hooks
above and leaves the backend/frontend architecture intact.

## Backend model

Represent focused chat with the existing `Head` and agent record. Do not add a
general session `kind` merely to distinguish it. Instead, make this invariant
explicit and central:

```text
Branch == nil                         focused head, live or archived
Branch != nil && Worktree != nil      normal head with a live checkout
Branch != nil && Worktree == nil      normal head without a live checkout
Archived                              orthogonal lifecycle state
```

`Branch` is the head's branch identity and may be historical: an archived normal
head retains its branch name even though teardown deleted the physical branch.
`Worktree` means a checkout currently exists on disk. Its candidate path is
deterministic, but a derived path must not be placed in `Worktree` after deletion
because existing consumers treat non-nil as permission to read, diff, run in or
remove that directory.

Consequently, `Worktree == nil` never identifies a focused head by itself. It
also describes archived normal heads and live normal heads whose checkout is
missing. Classifying either as focused would dangerously redirect work into the
real project root. Use central helpers rather than scattered nullable checks:

```go
func (h Head) IsFocused() bool { return h.Branch == nil }

func (h Head) WorkingDir() string {
    if h.IsFocused() {
        return h.ProjectPath
    }
    if h.Worktree != nil {
        return *h.Worktree
    }
    return ""
}
```

This naturally distinguishes archived focused heads (`Archived && IsFocused()`)
from archived normal heads (`Archived && !IsFocused()`). Ordinary spawn must
always persist its branch name before the head becomes visible, and tests must
protect that invariant. Focused-specific permissions can be ordinary fields on
the existing agent record (`filesystem_mode`, `allow_commits`); they do not
require a discriminator or a new table.

The API exposes `focused` directly. It should grow backend-derived capabilities
(`can_diff`, `can_merge`, `can_commit`, `can_change_mode`) as new focused actions
are added rather than making each client reconstruct them from nullable fields.

Focused session launch should share the existing pieces after directory
selection:

- `session.Registry` process ownership and attachment;
- `internal/chat.Manager`, event store, normalization and projection;
- Claude and Codex structured drivers;
- config resolution and policy/gate machinery;
- approval queue and WebSocket frames;
- network proxy and sandbox implementation;
- status hooks and native notification source events.

It should bypass:

- `git.CreateWorktree` and Hydra branch creation;
- diff/head polling;
- merge, publish, review and adoption watchers;
- tests/artifact/preview scheduling unless explicitly enabled later;
- git-operation tools other than the guarded focused commit.

## Sandbox model

For a focused session, `projectRoot`, `workingDirectory` and the writable target
may all name the same real directory. This differs from a normal head, where the
trusted project root and writable worktree are distinct. The sandbox launch API
must make this distinction explicit rather than overloading `WorktreePath` and
hoping callers infer the mode.

Required invariants:

- Read-only mode grants no write path into the selected project, including its
  Git common directory.
- Edit mode grants writes to working files but keeps `.git` protected from the
  provider process.
- Guarded commits execute through a narrowly validated Hydra operation outside
  the provider's filesystem permissions.
- Project `.hydra/config.toml` remains configuration input; an edit-mode agent
  must not be able to change its own effective policy during the running session.
- Existing masked paths, restore rules, CoW paths, MCP controls, GUI hardening,
  private temporary storage and network policy still apply.
- Symlinks inside the project must not expand the writable boundary outside it.
- Mode restart/resume must not briefly launch the replacement process with the
  old or an uninitialized policy.

On macOS these guarantees depend on completing the security-critical config
seeding and temporary/network work in [macos-support.md](macos-support.md).
Desktop packaging must not be presented as secure direct-edit mode while the
Darwin backend silently ignores those options.

## Native notifications

The backend should emit semantic notification events; the native shell decides
how to display them. Initial notifications are:

- an approval or question needs the user;
- an active turn completed;
- an active turn failed;
- a background session was interrupted or exited unexpectedly.

Clicking a notification opens or focuses the corresponding focused chat window,
or the same conversation in full Hydra if that is where it is already visible.
Notifications should be suppressed when the relevant conversation window is
frontmost. The menu-bar icon should indicate whether work is running or waiting
for input without becoming a second session-management UI.

## Implementation sequence

### Phase 0: prove the native shell

- Build the minimal webview comparison described above on the development Mac.
- Open the existing full Hydra route in two windows against one backend.
- Prove backend discovery, readiness, authentication, WebSockets, native
  notifications and clean Quit behavior.
- Record the framework decision and rejected alternative here.
- Add a developer-only unsigned `.app` build; defer signing/notarization until
  the runtime shape is stable.

Status: the thin Swift/AppKit shell, shared multi-window WebKit configuration,
existing-server probe, bundled-backend launch, OS-assigned port handshake,
development `.app` builder, background-after-last-window behavior, and guarded
Quit path are implemented. App-launched backends now publish a one-minute,
single-use auth bootstrap credential in their private atomic readiness record;
the first WKWebView redeems it for the shared HttpOnly cookie without exposing
the persistent auth key. App-launched backends require this authentication for
all TCP clients even when deploy configuration has no key; an ephemeral secret
is generated in memory for that backend lifetime. Both new and reused servers must now advertise the
same desktop protocol in their live status response; an absent or mismatched
value is rejected before any window opens. The bundled CLI now performs daemon
reuse and startup through the shared control socket, reads the versioned,
PID-bound endpoint record, and returns a fresh bootstrap credential to AppKit;
the fixed-port probe is gone. Older development bundles retain the private
ready-file launch as a compatibility fallback. The build is ad-hoc signed rather than unsigned so the
bundle is internally consistent. WebSocket, text-input, accessibility,
notification, and lifecycle acceptance still require the development Mac.

This phase makes no focused-session backend changes. It prevents a large product
refactor from depending on an untested desktop wrapper.

### Phase 1: make macOS sandboxing honest

- Complete Phase 1 of `macos-support.md`: provider config delivery, gate/hooks,
  MCP wiring and explicit errors for unsupported sandbox options.
- Add per-session private temporary storage and the required direct-edit
  Seatbelt profiles.
- Validate read-only and edit roots on real hardware.
- Complete hard network filtering before exposing configurable network policy as
  a security claim in the desktop UI.

### Phase 2: introduce focused sessions

- Add `Head.IsFocused`, `Head.WorkingDir`, focused permission fields and the
  branchless-head invariants. No stored session-kind field is needed.
- Add API capabilities and create/list/get/interrupt/resume endpoints.
- Split head spawning so common provider/sandbox/session startup can launch from
  either a worktree spec or a focused-directory spec.
- Create a focused draft only on first submit; preserve the immediate composer
  experience in the frontend.
- Ensure all worktree-only background watchers skip focused sessions.
- Reuse the existing chat event store and WebSocket protocol unchanged wherever
  possible.

Status: the stored model, branchless lifecycle, shared spawn API, watcher skips,
and existing chat protocol reuse are built. First-submit draft creation and
backend-derived capability fields remain.

### Phase 3: enforce permissions and guarded commits

- Implement distinct read-only and edit sandbox profiles for focused sessions.
- Add controlled restart/resume for a mode change, including failure recovery.
- Add runtime authorization for the independent commit toggle.
- Implement the focused commit operation with project/branch/HEAD validation and
  no other Git mutation tools.
- Surface concurrent editors and stale commit failures clearly.

Status: the shared permission contract, controlled stop/resume on a filesystem
mode change, immediate commit authorization, and branch/HEAD guarded commit are
built. OS-specific sandbox validation and the concurrent-editor warning remain.

### Phase 4: build the focused web route

- Add the focused window route and small layout.
- Extract/reuse structured chat without mounting the full agent inspector.
- Add project/path display, pre-first-message project selection, history,
  provider/model controls, mode control and commit toggle.
- Add project-switch behavior with Stop and switch / Keep running / Cancel.
- Add close-window active-turn confirmation through the native bridge, with a
  browser-safe fallback dialog for development.
- Make every focused conversation discoverable and openable from full Hydra.

Status: the reusable chat-only layout and its permission controls are built. A
dedicated `/focused/<project>` route now opens the empty focused composer and
creates the branchless session only when its first prompt is submitted; the
resulting agent route retains the chrome-free desktop presentation across
reloads. The compact window now has project and live focused-history selectors,
New Chat/Full Hydra actions, and a transport-neutral bridge used by AppKit and
WebView2 with browser fallbacks. Stop-and-switch behavior remains. Linux now
consumes the shared new-window and close operations too. Live and loaded
archived focused history share the selector.
AppKit and WebView2 now offer Stop and close,
Close and keep running, and Cancel for an active focused turn; stopping happens
through the authenticated page before native code permits the close.

### Phase 5: desktop lifecycle and notifications

- Add New Full Window and New Chat Window app/menu-bar actions.
- Track the frontmost full window's project and persisted fallback project.
- Route native notifications to the correct conversation.
- Implement last-window, background-work and explicit-Quit behavior.
- Add recovery UI for backend launch failure, incompatible versions and a stale
  ownership record.

Status: New Full Window/New Focused Chat commands, shared-daemon ownership,
last-window persistence, incompatible-version refusal, backend-exit reporting,
and active-session Quit confirmation are implemented in the initial shell.
Frontmost-project tracking, menu-bar state, native notifications, and richer
stale-ownership recovery remain.

### Phase 6: distribution

- Produce universal or separate arm64/amd64 builds as appropriate.
- [x] Put the shared agent/history database under
  `~/Library/Application Support/Hydra/db.sqlite3`, with transactional import
  from retained project-local databases for desktop and CLI users.
- Define the remaining application support, cache, and log locations using
  macOS conventions without breaking existing CLI users.
- Sign and notarize the app and bundled executable.
- Add an update mechanism only after service ownership and active-session
  behavior are proven; reuse the existing verified atomic update design where
  it fits.
- Document migration between CLI Hydra and `Hydra.app` installations.

## Validation

Backend tests must cover:

- a focused session never creates a branch or worktree;
- focused sessions survive backend restart and exact provider resume;
- read-only denies writes to ordinary files, `.hydra` and `.git`;
- edit permits in-project writes but denies writes through escaping symlinks;
- commit Off rejects the operation immediately;
- commit On commits only on the validated current branch/HEAD;
- concurrent branch or HEAD changes make a pending commit fail safely;
- every worktree-only watcher skips focused sessions;
- changing mode interrupts, replaces and resumes exactly one provider process;
- two clients attach to one session without duplicate event ingestion;
- closing a window has no implicit process effect at the HTTP layer.

Frontend and desktop end-to-end validation must cover:

- launch to an immediately usable composer;
- first message creates and titles the session;
- several full/focused windows share one backend;
- project selection is fixed after session creation;
- project switch choices behave correctly for idle and active turns;
- focused history reopens the original project-bound conversation;
- Edit/Read-only restart state is understandable and input-safe;
- commit permission changes without restart;
- approval/question notifications focus the right window;
- closing an active window offers all three agreed choices;
- Quit warns accurately and does not orphan a provider unexpectedly;
- browser-only full Hydra continues to work.

Run the normal project checks (`mage build`, frontend lint/typecheck and Go
tests), then validate Seatbelt and the signed app on real macOS hardware. Native
window, notification, text-input and lifecycle behavior cannot be accepted from
cross-compilation alone.

## Deliberately deferred

- Moving an existing conversation to another directory.
- Arbitrary unregistered folders.
- Importing arbitrary Claude CLI history.
- A native Swift rewrite of the React chat UI.
- Branch creation, merge, publish, review, tests, artifacts or previews inside
  the focused window.
- Automatic locking or reconciliation between two edit-mode focused sessions in
  the same project.
- Treating prompt instructions as a substitute for read-only enforcement.

## Open implementation questions

These do not change the agreed product shape, but must be resolved during the
spikes:

- Which webview shell best meets the multi-window, accessibility, notification
  and service-bundling requirements?
- Should the shared backend be the existing daemon process, an app-owned child
  promoted to a daemon, or the same binary with a desktop-specific lifecycle
  command?
- How should app and CLI builds negotiate ownership and protocol versions when
  both are installed?
- Does a focused session need a stable snapshot of resolved project policy for
  its whole lifetime, or only per provider launch? Mode restart argues for an
  explicit persisted policy revision.
- Should background completion notifications be opt-in per conversation or a
  single application preference?
