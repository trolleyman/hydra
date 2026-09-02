# Hydra for macOS and project-directory chats

Status: **shared project-directory-session foundation and initial macOS shell built; native
validation pending.** This
document records the agreed product shape and staged implementation plan for
packaging Hydra as a desktop app and adding a project-directory, directory-backed chat
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
project-directory-session foundation.

## Shared implementation status

The cross-platform base now includes:

- project-directory heads represented by `Branch == nil`, with edit/read-only and guarded
  commit permissions stored on the ordinary agent record;
- branchless spawn, list, archive, autorestart, and exact resume paths which run
  in the registered project root and never create or delete a Hydra worktree;
- a platform-neutral API for creating project-directory sessions and changing their
  permissions;
- read-only working-directory sandbox input shared by the Linux, Darwin, and
  Windows backends (with enforcement implemented by the non-stub backends);
- guarded project-directory commits which capture and revalidate both branch and HEAD,
  while rejecting every other host-mediated Git mutation;
- a project-directory option in the normal spawn UI and a shared chat-only agent
  layout. Its identity row places Edit/Read-only and Allow commits beside the
  project-directory workspace chip. The configuration strip retains test,
  network, Git, checked-out branch, and Terminal/Chat controls. The layout does
  not mount the diff, artifacts, previews, publish, merge, or review inspector;
- a project-directory branch selector which performs a normal non-forced checkout
  in the shared root and preserves Git's dirty-tree protection;
- simulation fixtures for editable, read-only, actively working, and archived
  project-directory chats, including mutable permission controls for browser testing.
- one responsive application shell for browser tabs, full native windows, and
  chat windows. Existing conversations use their canonical agent URL; a new
  project-directory chat uses `/project-directory/$projectId` only for its initial draft.

This is the intended branch point for platform agents. Native notification
bridges, signing, and OS-specific sandbox completion are not part of this shared
base.
First-message draft creation, a concurrent-editor warning, and complete native
validation remain to be built. Today a project-directory head is created by
submitting the existing composer, then opens in the shared chat layout.

The macOS implementation also contains an AppKit/WKWebView development shell under
`desktop/macos`. It reuses a compatible server on the default loopback address
or launches the bundled backend once on an OS-assigned port, using an atomic
readiness record to discover the URL. All windows share WebKit state, one
backend, and the same responsive React shell. A new chat window opens the
ordinary composer with Project directory/Edit selected. See
`desktop/macos/README.md` for build and hardware validation instructions.

## Product in one sentence

Ship one `Hydra.app`, backed by one shared local Hydra service and one responsive
application UI. Any canonical project or agent route can be displayed in the
main window, another native window, or an ordinary browser tab. Opening a chat
window is a presentation choice, not a separate chat product.

A project-directory chat is instead a workspace choice: it runs directly in a
registered project's directory and has no owned branch, worktree, merge, or
review inspector. It remains a normal Hydra session in the normal agent list and
agent route.

## Agreed decisions

### One app and one service

- Hydra and project-directory chat ship in one macOS app bundle.
- The app may open several windows at arbitrary Hydra routes.
- Every window connects to one shared local backend. Opening a second window
  must not start a second daemon, database, agent registry or network proxy.
- Closing the last window does not automatically terminate the backend. Hydra
  remains available through a menu-bar item, especially while work is running.
- Explicit Quit owns backend shutdown. If sessions are active, Quit must explain
  the consequence and offer to cancel, stop them, or leave Hydra running.
- The existing browser-served UI remains supported. The desktop app is another
  trusted client of the same backend, not a fork of it.

### A project-directory chat belongs to one project forever

- A project-directory chat runs in the real root directory of one registered Hydra
  project. It does not receive a linked worktree or a Hydra branch.
- The directory is fixed when the first message creates the session. An existing
  conversation never changes directory and is never migrated between projects.
- A new project-chat window initially selects the project active in the
  frontmost Hydra window. If there is no such window, it uses Hydra's persisted
  last project.
- The selected project and display path remain visible in the shared shell.
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

- Opening a new project-chat window produces an untitled draft immediately. There is no
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
- Project-directory chats appear in the normal project agent list and can be
  reopened at their canonical route in the current window, a new window, or a
  browser tab.

### Provider-neutral chat

Project-directory chat uses the existing provider-neutral event contract. Claude and
Codex remain supported, and adding the desktop surface must not introduce a
Claude-shaped browser protocol. The first implementation may concentrate its
manual validation on Claude, but session APIs and persisted records must carry
the existing `AgentType` and provider conversation ID.

### Direct editing, read-only mode and guarded commits

A project-directory session has two independent permissions visible near the composer or
window header:

1. **Mode: Edit / Read-only**
2. **Allow commits: On / Off**

Edit is the default for a newly-created project-directory chat. Read-only is a real
sandbox boundary, not prompt guidance. In read-only mode the project root is
readable but not writable. In edit mode the selected project root is writable
in place, so edits appear immediately in the user's editor and checkout.

Changing Edit/Read-only changes the sandbox profile. It therefore uses a
controlled restart of the namespace host and exact conversation resume behind
the same Hydra conversation. The project-root mount belongs to that outer
sandbox, so restarting only the provider child would retain the previous
permission. The UI must show that transition and reject or queue input until
resume completes. A visible control is required; Shift+Tab may later be added as
an optional shortcut, but must not be the only indication or control.

`Allow commits` is independent of filesystem editing:

- Off: Git status, diff, log and show remain readable, but Git writes are denied.
- On: the agent may use Hydra's guarded commit operation on the currently
  checked-out branch.
- Branch changes, checkout/reset/rebase/cherry-pick/stash, pushes and arbitrary
  Git configuration writes remain unavailable in project-directory mode initially.
- A commit operation must verify immediately before committing that the project
  root is still on the branch and HEAD observed when the request was issued. A
  stale request fails rather than committing onto a branch the user changed in
  another application.
- A project-directory session never creates or owns a branch, so commit language and UI
  must not imply that Hydra will merge or archive it. File links from its chat
  resolve relative to the project root and browse the checkout's current HEAD.

The commit toggle changes authorization, not the filesystem sandbox, and should
not require a provider restart. Turning it off must affect the next tool request
immediately.

Two edit-mode agents may write the same project concurrently. Hydra should make
that fact visible but does not attempt locking or conflict resolution in the
first version. Read-only project-directory sessions may safely run alongside writers,
subject to the ordinary fact that their reads can observe files changing.

## Chat window experience

Every window renders Hydra's normal responsive shell. A wide chat window keeps
the global top bar and agent list; a phone-sized window naturally collapses to
the chat with the normal sidebar and inspector navigation controls. There is no
second project/history toolbar and no `desktop=compact` presentation mode.

An existing chat window loads the canonical agent route. A new project-directory
chat window loads the project draft, then navigates to that same canonical route
after spawn. In a browser, the open-window action requests popup-style chrome,
but browser policy decides whether it becomes a popup or tab.

Workspace state is visible in both the agent metadata and agent list:

- a branch chip means an isolated worktree;
- a folder chip means the shared project directory;
- Edit/Read-only and Allow commits sit immediately after the project-directory
  chip;
- test, network, Git access, checked-out branch, and Terminal/Chat follow in the
  configuration strip.

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

Project settings, including the full sandbox/network policy editor, remain in
the normal shared navigation rather than being duplicated in the chat view.

The project-directory agent view composes the normal `AgentDetail` metadata and
chat surfaces but does not mount the worktree inspector. The application shell
itself is shared and responds to the available window width.

### Closing a chat window

Closing an idle chat window closes only the window. The saved conversation
remains available in history.

Closing a chat window during an active turn presents:

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
- open full and project-directory webview windows at the appropriate internal routes;
- communicate the frontmost window's project to a new project-chat window;
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
- app activation, the shared [`hydra://` grammar](desktop-deep-links.md), and
  menu commands;
- bundling and launching the Go service;
- development against Vite without changing production routing.

The likely comparison is a thin Swift/WKWebView shell versus a maintained Go or
Rust webview framework. Prefer the smallest shell that exposes the native hooks
above and leaves the backend/frontend architecture intact.

## Backend model

Represent project-directory chat with the existing `Head` and agent record. The
public `workspace_kind` describes the topology, but it is derived from the
existing branch invariant rather than stored as a second discriminator:

```text
Branch == nil                         project-directory head, live or archived
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

Consequently, `Worktree == nil` never identifies a project-directory head by itself. It
also describes archived normal heads and live normal heads whose checkout is
missing. Classifying either as project-directory would dangerously redirect work into the
real project root. Use central helpers rather than scattered nullable checks:

```go
func (h Head) WorkspaceKind() api.WorkspaceKind {
    if h.Branch == nil {
        return api.WorkspaceKindProjectDirectory
    }
    return api.WorkspaceKindWorktree
}

func (h Head) UsesProjectDirectory() bool {
    return h.WorkspaceKind() == api.WorkspaceKindProjectDirectory
}

func (h Head) WorkingDir() string {
    if h.UsesProjectDirectory() {
        return h.ProjectPath
    }
    if h.Worktree != nil {
        return *h.Worktree
    }
    return ""
}
```

This naturally distinguishes archived project-directory heads (`Archived && UsesProjectDirectory()`)
from archived normal heads (`Archived && !UsesProjectDirectory()`). Ordinary spawn must
always persist its branch name before the head becomes visible, and tests must
protect that invariant. Project-directory-specific permissions can be ordinary fields on
the existing agent record (`filesystem_mode`, `allow_commits`); they do not
require a discriminator or a new table.

The API exposes `workspace_kind` directly. It should grow backend-derived capabilities
(`can_diff`, `can_merge`, `can_commit`, `can_change_mode`) as new project-directory actions
are added rather than making each client reconstruct them from nullable fields.

Project-directory session launch should share the existing pieces after directory
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
- git-operation tools other than the guarded project-directory commit.

## Sandbox model

For a project-directory session, `projectRoot`, `workingDirectory` and the writable target
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
- Existing readable paths, masked paths, CoW paths, MCP controls, GUI hardening,
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

Clicking a notification opens or focuses a window at the conversation's
canonical agent route.
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
control-socket daemon reuse/startup, PID-bound random-port discovery, private
ready-file compatibility fallback, development `.app` builder,
background-after-last-window behavior, and guarded
Quit path are implemented. App-launched backends now publish a one-minute,
single-use auth bootstrap credential in their private atomic readiness record;
the first WKWebView redeems it for the shared HttpOnly cookie without exposing
the persistent auth key. App-launched backends require this authentication for
all TCP clients even when deploy configuration has no key; an ephemeral secret
is generated in memory for that backend lifetime. Protocol 3 carries version,
build, project, and protocol compatibility metadata in the trusted control-socket
or private ready-file response. AppKit does not query protected `/api/status`
over TCP before the webview redeems its credential. The bundled CLI now performs daemon
reuse and startup through the shared control socket, reads the versioned,
PID-bound endpoint record, and returns a fresh bootstrap credential to AppKit;
the fixed-port probe is gone. It also returns the selected project ID, so the
first project-directory window opens the folder chosen by the user rather than the
daemon's boot project. Older development bundles retain the private ready-file
launch only when the bundled CLI does not recognise `__desktop-connect`;
connection, authentication, and compatibility failures are surfaced without
starting a competing backend. Quit-time running-session checks use the trusted
control socket rather than an unauthenticated native HTTP client. Native navigation compares the
complete scheme/host/effective-port origin; every other HTTP(S) origin opens in
the system browser and non-web origins are blocked from the privileged webview.
The WebKit script bridge uses a weak proxy and is removed during window close,
so a closed window does not remain retained by its user-content controller.
The build is ad-hoc signed rather than unsigned so the
bundle is internally consistent. WebSocket, text-input, accessibility,
notification, and lifecycle acceptance still require the development Mac.

This phase makes no project-directory-session backend changes. It prevents a large product
refactor from depending on an untested desktop wrapper.

### Phase 1: make macOS sandboxing honest

- Complete Phase 1 of `macos-support.md`: provider config delivery, gate/hooks,
  MCP wiring and explicit errors for unsupported sandbox options.
- Add per-session private temporary storage and the required direct-edit
  Seatbelt profiles.
- Validate read-only and edit roots on real hardware.
- Complete hard network filtering before exposing configurable network policy as
  a security claim in the desktop UI.

### Phase 2: introduce project-directory sessions

- Add `Head.UsesProjectDirectory`, `Head.WorkingDir`, project-directory permission fields and the
  branchless-head invariants. No stored session-kind field is needed.
- Add API capabilities and create/list/get/interrupt/resume endpoints.
- Split head spawning so common provider/sandbox/session startup can launch from
  either a worktree spec or a project-directory spec.
- Create a project-directory draft only on first submit; preserve the immediate composer
  experience in the frontend.
- Ensure all worktree-only background watchers skip project-directory sessions.
- Reuse the existing chat event store and WebSocket protocol unchanged wherever
  possible.

Status: the stored model, branchless lifecycle, shared spawn API, watcher skips,
existing chat protocol reuse, first-submit creation, and backend-derived native
sandbox capability fields are built.

### Phase 3: enforce permissions and guarded commits

- Implement distinct read-only and edit sandbox profiles for project-directory sessions.
- Add controlled restart/resume for a mode change, including failure recovery.
- Add runtime authorization for the independent commit toggle.
- Implement the project-directory commit operation with project/branch/HEAD validation and
  no other Git mutation tools.
- Surface concurrent editors and stale commit failures clearly.

Status: the shared permission contract, controlled stop/resume on a filesystem
mode change, immediate commit authorization, and branch/HEAD guarded commit are
built. OS-specific sandbox validation and the concurrent-editor warning remain.

### Phase 4: build the project-directory chat flow

- Add the project-directory draft route and reuse the normal responsive shell.
- Reuse structured chat without mounting the worktree inspector.
- Add project/path display, provider/model controls, and workspace permission
  controls.
- Add project-switch behavior with Stop and switch / Keep running / Cancel.
- Add close-window active-turn confirmation through the native bridge, with a
  browser-safe fallback dialog for development.
- Make every project-directory conversation discoverable and openable from full Hydra.

Status: the reusable chat-only layout and its permission card are built. The
`/project-directory/<project>` route opens the project-directory composer and creates the
branchless session when its first prompt is submitted. It then navigates to the
canonical agent route in the normal responsive shell. New-window and close
operations use a transport-neutral bridge with browser fallbacks. Linux consumes
the shared operations too. Stop-and-switch behavior remains.
AppKit and WebView2 now offer Stop Session and Close,
Close and keep running, and Cancel for an active project-directory turn; stopping happens
through the authenticated page before native code permits the close. It stops
only the provider process and retains the head, worktree, branch and conversation
for automatic resume when the head is opened later.

### Phase 5: desktop lifecycle and notifications

- Add New Full Window and New Chat Window app/menu-bar actions.
- Track the frontmost full window's project and persisted fallback project.
- Route native notifications to the correct conversation.
- Implement last-window, background-work and explicit-Quit behavior.
- Add recovery UI for backend launch failure, incompatible versions and a stale
  ownership record.

Status: New Hydra Window/New Project Chat commands, shared-daemon ownership,
last-window persistence, incompatible-version refusal, backend-exit reporting,
and active-session Quit confirmation are implemented in the initial shell.
Frontmost-project tracking, menu-bar state, native notifications, and richer
stale-ownership recovery remain.

### Phase 6: distribution

- Produce universal or separate arm64/amd64 builds as appropriate.
- [x] Put the shared agent/history database under
  `~/Library/Application Support/Hydra/db.sqlite3`, with transactional import
  independently from checkout-local development databases.
- Define the remaining application support, cache, and log locations using
  macOS conventions without breaking existing CLI users.
- Sign and notarize the app and bundled executable.
- Add an update mechanism only after service ownership and active-session
  behavior are proven; reuse the existing verified atomic update design where
  it fits.
- Document migration between CLI Hydra and `Hydra.app` installations.

## Remaining macOS work

In priority order:

1. Complete and validate the macOS security backend: provider config/gate/MCP
   delivery, per-head temporary storage, project-directory read-only/edit Seatbelt rules,
   and a real hard-network implementation. Do not advertise a network posture
   which currently degrades to network-off as equivalent.
2. Finish project-directory lifecycle: Stop and switch / Keep running / Cancel when
   changing project, frontmost-project tracking, concurrent-editor warning, and
   richer stale/backend-failure recovery.
3. Add native notifications and activation routing for questions, approvals,
   completion, failure, and backend exit; add menu-bar state only as an optional
   convenience, not as the only reopen/quit path.
4. Run the native acceptance matrix on supported Intel and Apple Silicon Macs:
   shared cookies/WebSockets, IME, VoiceOver/keyboard navigation,
   Retina/non-Retina and multi-display restore, Spaces/full screen, uploads,
   clipboard, external links, sleep/wake, and lifecycle behavior.
5. Define all support/cache/log locations, produce universal or paired
   arm64/amd64 artifacts, sign every executable, notarize and staple the app,
   and test Gatekeeper from a quarantined download.
6. Implement coordinated signed updates with active-head deferral, readiness
   rollback, database compatibility, downgrade refusal, CLI coexistence,
   repair/uninstall-with-data-preserved, and clean-VM upgrade tests from the last
   released version.

Items 4-6 require macOS builders, real target-OS execution, and release signing
credentials. Their detailed acceptance criteria are in
[desktop-native-validation.md](desktop-native-validation.md).

## Validation

Backend tests must cover:

- a project-directory session never creates a branch or worktree;
- project-directory sessions survive backend restart and exact provider resume;
- read-only denies writes to ordinary files, `.hydra` and `.git`;
- edit permits in-project writes but denies writes through escaping symlinks;
- commit Off rejects the operation immediately;
- commit On commits only on the validated current branch/HEAD;
- concurrent branch or HEAD changes make a pending commit fail safely;
- every worktree-only watcher skips project-directory sessions;
- changing mode interrupts, replaces and resumes exactly one provider process;
- two clients attach to one session without duplicate event ingestion;
- closing a window has no implicit process effect at the HTTP layer.

Frontend and desktop end-to-end validation must cover:

- launch to an immediately usable composer;
- first message creates and titles the session;
- several windows at full and chat routes share one backend;
- project selection is fixed after session creation;
- project switch choices behave correctly for idle and active turns;
- the normal agent list reopens the original project-bound conversation;
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

Use [desktop-native-validation.md](desktop-native-validation.md) for the exact
IME, accessibility, notification, multiple-display, and upgrade test scope and
the automation/manual boundary.

## Deliberately deferred

- Moving an existing conversation to another directory.
- Arbitrary unregistered folders.
- Importing arbitrary Claude CLI history.
- A native Swift rewrite of the React chat UI.
- Branch creation, merge, publish, review, tests, artifacts or previews inside
  the project-directory agent view.
- Automatic locking or reconciliation between two edit-mode project-directory sessions in
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
- Does a project-directory session need a stable snapshot of resolved project policy for
  its whole lifetime, or only per provider launch? Mode restart argues for an
  explicit persisted policy revision.
- Should background completion notifications be opt-in per conversation or a
  single application preference?
