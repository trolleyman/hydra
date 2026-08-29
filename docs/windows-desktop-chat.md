# Hydra for Windows and focused chat windows

Status: **shared focused-session foundation and initial Windows shell built;
native validation and Windows agent runtime unbuilt.** This document adapts the
product shape in
[macos-desktop-chat.md](macos-desktop-chat.md) into a standalone Windows desktop
application. It starts from the platform-neutral focused-session work already
merged into `main`; it does not propose a second session model or a Windows-only
frontend.

The native sandbox, ConPTY, daemon, and process-lifecycle port is covered by
[windows-support.md](windows-support.md). That work and this app plan are related
but distinct: an app shell can be proved against the existing simulation server
before native heads work, while a production app capable of running agents
depends on the Windows runtime phases below.

## Product shape

Ship one standalone Hydra application for Windows with the same two window types
planned for macOS:

- **Full Hydra** - the existing project, head, diff, test, artifact, preview,
  publish, and review interface.
- **Focused chat** - a small structured-chat window attached directly to one
  registered project's real directory, with Edit/Read-only and guarded-commit
  controls and none of the worktree review chrome.

Both surfaces remain React routes served by the existing Go backend. The native
shell owns Windows lifecycle and integration; it must not fork chat rendering or
business logic. Browser-served Hydra remains supported.

"Standalone" means the installer carries the Hydra executable and web assets,
launches without WSL2 or a separately installed Hydra CLI, and provides normal
Start menu, taskbar, notification, and uninstall behavior. The app always uses a
bundled PortableGit distribution so its Git and POSIX-script behavior does not
vary with host configuration. Agent providers and the other developer tools
they invoke remain external prerequisites; provider authentication and updates
stay with Claude Code, Codex CLI, Gemini CLI, and Copilot CLI.

## Shared implementation status

The following base is already merged and must be reused unchanged:

- focused heads are ordinary branchless heads (`Branch == nil`) and run in the
  registered project root without a Hydra worktree;
- branchless create/list/archive/restart/resume behavior and watcher exclusions;
- the platform-neutral focused create and permission API;
- Edit/Read-only switching through controlled stop and exact resume;
- immediate authorization changes for the independent commit toggle;
- guarded commits which revalidate the real checkout's branch and HEAD;
- the focused option in the existing spawn composer;
- the reusable chat-only React layout and focused permission controls;
- simulation fixtures for editable, read-only, working, and archived focused
  sessions.

Still shared and unbuilt are first-message draft creation, a dedicated
chrome-free focused route, project/history switching, native close confirmation,
the concurrent-editor warning, native notification events, and backend-derived
capabilities. These should land once for every desktop shell, not in Windows UI
code.

## Windows-specific decisions

### One backend per Windows user

- Every full and focused window connects to one user-scoped Hydra backend.
- A second app process discovers and activates the existing instance instead of
  opening another database owner or choosing another arbitrary port.
- The app also composes with a compatible Hydra CLI daemon already running as
  the same Windows user.
- Closing a window has no process effect. Closing the last window leaves the
  backend alive while heads are running or the tray mode is enabled.
- Explicit Exit owns shutdown. If work is active it offers to cancel, stop the
  heads, or leave Hydra running in the notification area.
- No Windows service or machine-wide daemon is required. The backend, database,
  logs, lock, and discovery records are per-user under the appropriate local app
  data directories.

The native Windows port already needs a portable daemon shutdown endpoint and a
`LockFileEx` single-instance lock. The app should consume that mechanism instead
of adding a second desktop-only lock protocol.

### Native Windows Forms and WebView2 shell

Use a thin, self-contained .NET Windows Forms shell hosting WebView2. This
mirrors the built macOS AppKit/WKWebView shell: each platform owns a small native
lifecycle layer while the Go backend and React product remain shared. A single
cross-platform desktop framework is not a goal.

The initial development shell is under `desktop/windows`. It launches or reuses
one backend, shares a persistent WebView2 profile between windows, opens full and
focused composer windows, owns notification-area lifecycle, and consumes the
same atomic readiness protocol as `desktop/macos`. It is not yet validated on
Windows hardware and is not an installer.

The shell technology is acceptable only if it proves:

- multiple top-level windows sharing cookies, storage, and authentication;
- WebSockets, uploads, downloads, clipboard, media, IME, accessibility, and the
  embedded terminal;
- reliable new-window interception and routing to full/focused native windows;
- accelerator handling without stealing composer or terminal keystrokes;
- native notification click activation when the app is closed to the tray;
- a stable user-data directory across application updates;
- development against Vite and production against the bundled backend without
  route or origin forks;
- clean install, update, uninstall, and crash recovery.

Do not add Electron or another general cross-platform runtime. Hydra already has
a Go service and browser application; a second product runtime and update owner
would be substantial permanent surface.

### Backend bootstrap and authentication

The Windows shell follows the same service contract as the macOS shell:

1. Acquire or inspect the user-scoped ownership/discovery record.
2. Attach to a compatible ready backend if one exists.
3. Otherwise launch the bundled Hydra executable hidden, wait for a bounded
   readiness handshake, and record that this app started it.
4. Bootstrap each webview with a short-lived token or app-owned local exchange;
   do not weaken localhost origin/authentication checks for all clients.
5. On version mismatch or stale ownership, show recovery UI. Never silently
   create a competing backend or database owner.

Do not use a fixed TCP port as the identity of the service. Reuse the portable
daemon control endpoint and let the backend advertise its HTTP endpoint and
protocol/build version. AF_UNIX is available on supported Windows releases, but
the spike must verify WebView2 bootstrap and lifecycle behavior rather than
assuming a browser can use that socket directly.

### Process and window lifecycle

- The shell process owns windows, app commands, taskbar behavior, and the
  notification-area icon.
- The Go backend owns head/provider processes and durable session state.
- A backend started by the app is detached from any one webview window. Job
  objects for individual heads must not make backend lifetime depend on the
  shell's window tree.
- If shell and backend are separate processes, an app update replaces neither
  while it is executing. Reuse Hydra's verified atomic update concepts, but add
  an explicit shell/backend version handshake and coordinated restart.
- Register app activation for notification clicks and the shared
  [`hydra://` deep-link grammar](desktop-deep-links.md), whose URLs contain only
  stable project/head identifiers. Never put bootstrap credentials in a URI or
  command line.

## Packaging and distribution

Target Windows 11 x64 and arm64. Produce both application builds once the native
runtime is working.
Use one authoritative version across the shell, bundled Go executable, embedded
frontend, protocol handshake, and installer metadata.

The packaging spike should evaluate packaged MSIX and a conventional per-user
installer against Hydra's actual requirements:

- launching and discovering a long-lived per-user backend;
- performing the one-time elevated sandbox setup from an explicit user action;
- installing or repairing the elevated runner described in
  `windows-support.md` without making the main app elevated;
- preserving the database and WebView profile across updates;
- Start menu shortcuts, file/protocol activation, notifications, clean
  uninstall, and code signing;
- enterprise environments where MSIX installation or local-user creation is
  blocked.

Prefer per-user installation for the ordinary app. Elevation belongs only to
the explicit, idempotent sandbox setup/repair path; the shell and `hydrad` must
run unelevated. An installer must not silently choose the weaker unsandboxed or
unelevated sandbox posture when setup fails.

Keep mutable data outside the installation directory:

- application/database state in the Windows roaming or local application data
  location chosen by the existing config semantics;
- logs, caches, runtime locks, and WebView profile in local application data;
- per-head scratch in the head's private `TEMP`/`TMP` directory.

Uninstall asks separately whether to retain user projects and Hydra application
data. It must not delete repositories, project roots, or provider configuration.
Removal of sandbox users, firewall rules, ACL grants, and the elevated runner is
an explicit cleanup operation with a startup/installer repair path for partial
state.

## Security and release gates

A webview wrapper does not make the current Windows stubs production-ready. The
release labels must be precise:

- **Shell preview:** the packaged UI can browse simulation data or attach to a
  backend elsewhere; it cannot claim native agent execution.
- **Unsafe developer preview:** native plumbing works with explicit trusted-root
  unsandboxed opt-in. This is never the default and is not a general release.
- **Production native app:** ConPTY, daemon lifecycle, config delivery, the
  sandbox-user/ACL backend, job-object teardown, and the selected network modes
  pass real-Windows validation.

Focused Edit mode is the highest-risk path because it writes the user's real
checkout. It must not ship as secure until all of these hold:

- the provider cannot write `.git` or effective Hydra policy directly;
- seeded gate/hooks/MCP configuration is delivered and tamper-resistant;
- writable and masked path ACLs survive symlink/reparse-point tests;
- guarded commit is the only Git mutation path when enabled;
- job-object teardown kills the whole provider process tree;
- the UI reports whether elevated or weaker fallback sandboxing is active;
- hard/off network modes fail closed when the firewall setup is missing or
  damaged.

Read-only focused mode is also enforced by the Windows sandbox, not by prompt
text. WSL2 remains the supported full-fidelity fallback for machines where GPO,
AV, or the absence of administrator approval prevents native sandbox setup, but
it is not the runtime hidden inside the standalone app.

## Implementation sequence

### Phase 0: freeze the shared desktop contract

- [x] Land the dedicated focused route and first-message creation flow.
- Land the project and history switcher, backend capabilities, and semantic
  notification events.
- Define the remaining native bridge messages for notification state, app
  version, and app activation. New-window, close-request, active-project, and
  active-turn state messages are defined; AppKit and WebView2 consume the window
  and project operations.
- Keep the bridge transport replaceable so macOS and Windows shells implement
  the same semantics without sharing native code.
- Add browser fallbacks for every bridge-dependent action used in development.

This phase extends the merged base; it must not reopen the `Branch == nil`
model or duplicate the permission/commit implementation.

### Phase 1: prove a Windows shell against simulation

- [x] Commit to a Windows-native Windows Forms/WebView2 shell, consistent with
      the separate AppKit/WKWebView shell on macOS.
- [x] Add a self-contained development publish script which packages the
      production frontend, bundled Go executable, and caller-supplied official
      PortableGit payload for x64 or arm64.
- [x] Share one backend and persistent WebView2 profile across full and focused
      windows, with native new-window commands and notification-area lifecycle.
- [x] Restore and compile the Windows Forms/WebView2 project from Linux with the
      .NET 8 SDK and Windows targeting enabled; real-Windows runtime validation
      remains required below.
- [ ] Open two full windows and two focused windows against simulation on real
      Windows and prove shared cookies, storage, WebSockets, and session state.
- [ ] Prove app commands: New full window, New chat window, Settings, and Exit.
- [ ] Prove deep-link/notification activation, native close interception, tray
      lifecycle, file upload/download, IME, accessibility, and terminal keys.
- [x] Produce the source/build shape for an unsigned development package;
      signing and automatic update wait until backend ownership is stable.

This can run before the native Windows head backend exists and is the cheapest
way to reject an unsuitable shell.

Status: an app-launched protocol-3 backend now includes a one-minute,
single-use auth bootstrap credential in its private atomic readiness record.
The first WebView2 window places it only in the URL fragment and redeems it for
the persistent profile's ordinary HttpOnly cookie. App-launched backends require
this authentication for all TCP clients even when deploy configuration has no
key; an ephemeral secret is generated in memory for that backend lifetime.
Protocol 3 carries version, build, project, and protocol compatibility metadata
in the trusted control-socket or private ready-file response. The shell does not
query protected `/api/status` over TCP before WebView2 redeems its credential.
Navigation compares the complete scheme/host/effective-port origin, keeping any
other loopback service out of the privileged native message bridge; only
external HTTP(S) links are handed to the system browser. The selected project ID
is part of the trusted connection record, and quit-time running-session checks
go through the control channel instead of a separate unauthenticated HTTP
client. The shell now
invokes the shared bundled `__desktop-connect` contract first and no longer
probes a fixed TCP port. On Windows that command deliberately reports the
still-unimplemented native daemon transport, so the shell falls back to its
private ready-file launch until Phase 2 supplies the portable control endpoint.
Once that backend lands, the same shell code will reuse its versioned, PID-bound
endpoint and control-channel bootstrap without another discovery protocol.

### Phase 2: make the bundled backend native

Complete Phase 1 of [windows-support.md](windows-support.md):

- ConPTY sessions and interactive attach;
- user-scoped runtime paths, AF_UNIX control endpoint, `LockFileEx` ownership,
  explicit shutdown, and detached autostart;
- Windows script/shell resolution and per-head temp/config path handling;
- Windows CI plus real-hardware daemon and terminal validation.

Then wire the shell to discover, launch, authenticate, monitor, and recover that
backend. An explicit root-config opt-in may enable an unsafe developer build,
but the normal app continues to block agent launch until sandbox setup is ready.

### Phase 3: complete native confinement

Complete Phases 2 and 3 of `windows-support.md`:

- idempotent elevated setup and repair;
- sandbox-user pool, restricted tokens, ACL grants/denies, cleanup, and audit;
- elevated spawn runner, ConPTY handoff, private desktop, and job objects;
- shared config-delivery intent layer and Windows provider configuration;
- off/advisory/unrestricted/hard network postures with fail-closed detection.

Add an in-app setup status page which can invoke the separately signed elevated
setup helper after an ordinary Windows consent prompt, explain failures, and
offer WSL2 documentation. The helper performs only setup/repair/removal; it does
not run the Hydra UI or daemon elevated.

### Phase 4: finish focused-window lifecycle

- Create an untitled focused window immediately and atomically create its head
  on first submit.
- Select the frontmost full window's project, falling back to persisted last
  project, and make the directory immutable after creation.
- Implement history and project switching with Stop and switch, Keep running,
  and Cancel behavior.
- Implement active-turn close confirmation through the native bridge.
- Route question, approval, completion, failure, and unexpected-exit
  notifications to the right window; suppress them for a frontmost conversation.
- Surface concurrent edit-mode sessions and the active sandbox strength.

Status: the shared bridge reports the selected head's live-turn state and the
Windows and macOS shells now offer Stop and close, Close and keep running, and
Cancel. Stop is issued by the authenticated web session and the native window
closes only after it succeeds. Draft project/history controls cover live focused
heads plus loaded archived history; Stop-and-switch project changes remain.

### Phase 5: sign, install, and update

The shared agent/history database location is already implemented as
`%LOCALAPPDATA%\Hydra\db.sqlite3`, including transactional import from retained
project-local databases. Installer and native-runtime validation remain.

- Choose the packaging model from the Phase 1/installer spike and document the
  rejected option.
- Build and test x64 and arm64 artifacts with matching shell/backend versions.
- Sign the shell, backend, setup helper, and installer; make signature failure a
  release failure.
- Add coordinated update only after active-session, rollback, database
  compatibility, and shell/backend ownership tests pass.
- Test upgrade, downgrade refusal, repair, uninstall-with-data, and complete
  cleanup on clean Windows VMs plus a representative enterprise-restricted VM.
- Document migration and coexistence with a CLI installation and with WSL2.

## Remaining Windows work

In priority order:

1. Build the native runtime foundation: ConPTY create/resize/attach, shell and
   script resolution, a user-scoped AF_UNIX control endpoint, `LockFileEx`
   ownership, detached autostart, explicit shutdown, stale-lock recovery,
   per-head temp/config paths, and whole-tree process teardown.
2. Replace the private readiness fallback with the now-wired shared
   `__desktop-connect` path once that transport exists, then prove CLI/desktop
   coexistence, auth bootstrap, version rejection, and backend recovery.
3. Build native confinement: signed elevated setup/repair helper, sandbox-user
   pool, restricted tokens, ACL grants/denies and cleanup, job objects, private
   desktop, provider configuration, and fail-closed off/advisory/unrestricted/
   hard network modes. The ordinary app and backend must never run elevated.
4. Finish focused lifecycle and native integration: Stop and switch / Keep
   running / Cancel, frontmost-project tracking, concurrent-editor warning,
   notification routing/suppression, activation/deep links, setup diagnostics,
   download/upload handling, tray-only and fully-exited activation.
5. Run the Windows 11 x64/arm64 native matrix: WebView2 profile and WebSockets,
   IME and terminal keys, Narrator/keyboard navigation (plus NVDA where
   supported), per-monitor DPI and multi-display restore, dark/high-contrast
   modes, clipboard/uploads, reboot, Remote Desktop, GPO/AV/elevation denial,
   missing Git/WebView/provider, and damaged firewall recovery.
6. Select and document an installer, build and sign x64/arm64 shell/backend/
   helper/installer artifacts, then implement coordinated signed updates with
   active-head deferral, readiness rollback, database compatibility, downgrade
   refusal, repair, uninstall cleanup with user data preserved, and clean plus
   enterprise-restricted VM upgrades from the last release.

Items 5-6 require Windows builders/VMs or hardware, WebView2, and release code-
signing infrastructure. Their detailed acceptance criteria are in
[desktop-native-validation.md](desktop-native-validation.md).

## Validation matrix

At minimum, acceptance covers:

- Windows 11 x64 and arm64;
- packaged and unpackaged development launch, clean install, update, repair,
  uninstall, reboot, and stale-lock recovery;
- one through many full/focused windows sharing one backend without duplicate
  provider processes or chat ingestion;
- WebView profile persistence, cookies/auth bootstrap, WebSockets, attachments,
  clipboard, terminal input, IME, screen reader navigation, scaling, dark mode,
  and multi-monitor restore;
- notification click activation when running, tray-only, and fully exited;
- no-provider, missing-Git, missing-WebView-runtime, blocked-elevation, GPO, AV,
  damaged-firewall, and incompatible-backend failure paths;
- read-only/edit/commit enforcement and process/network teardown from
  `windows-support.md` on real Windows, not cross-compilation alone;
- browser-only Hydra and the macOS/Linux backends remaining unchanged.

Run `mage build`, frontend lint/typecheck, `go test ./...`, Windows cross-builds,
and Windows-native integration tests. A green Linux cross-build is necessary but
cannot accept WebView, ConPTY, ACL, firewall, notification, installer, or update
behavior.

Use [desktop-native-validation.md](desktop-native-validation.md) for the exact
IME, accessibility, notification, multiple-display/DPI, and upgrade test scope
and the automation/manual boundary.

## Deliberately deferred

- A native rewrite of the React UI.
- Bundling provider CLIs, compilers, or arbitrary developer toolchains. Git is
  the deliberate exception and is app-owned.
- Hiding WSL2 inside the desktop app as an alternate backend.
- Machine-wide backend/service installation.
- Microsoft Store submission before the sandbox helper and update model are
  proven compatible with its packaging constraints.
- Arbitrary unregistered folders, conversation directory migration, and
  importing arbitrary provider history.
- Branch/review/test/artifact/preview chrome inside the focused window.

## Open implementation questions

- Which installer model handles the elevated sandbox helper, background
  backend, notifications, and enterprise repair most honestly?
- Should the WebView2 Runtime be bootstrapped by the installer or treated as a
  repairable Windows 11 prerequisite?
- How should a CLI and desktop bundle with different versions negotiate which
  backend owns the user's database?
- Can sandbox-user/firewall cleanup be safely offered from uninstall, or should
  it remain an explicit signed helper action so repository ACLs are auditable?
