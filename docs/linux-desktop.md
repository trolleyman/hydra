# Hydra as a standalone Linux app

Status: **implementation started; shared focused-session foundation and first
Linux WebKitGTK shell spike built.**
This document adapts the desktop product defined in
[macos-desktop-chat.md](macos-desktop-chat.md) to Linux. The shared backend, API,
and React base is already the branch point for platform work: focused heads are
branchless, run in a registered project's real directory, support enforced
Edit/Read-only mode and guarded commits, and render in a chat-only layout.

This plan only covers a standalone Linux desktop application. It does not
replace the browser UI, the CLI, or the existing `systemd --user` deployment in
[deployment.md](deployment.md), and it does not propose a Linux-native rewrite
of the React interface.

## Initial product decisions

- **First supported baseline:** Ubuntu LTS with GNOME on Wayland. KDE, X11, and
  other distributions remain validation targets, but do not expand the first
  support promise until their results are known.
- **Backend lifecycle:** an app-managed detached daemon is the default when no
  compatible backend is already running. The app attaches to an existing CLI or
  service-owned backend instead of competing with it.
- **First packaging attempt:** AppImage, installed per-user without root. It is
  only the release path if the spike proves that Hydra's namespaces, mounts,
  helpers, provider execution, and updates work from its mounted runtime. A
  `.deb` package for Ubuntu LTS is the planned fallback, not a reason to weaken
  the sandbox.

## Product shape

Ship one Hydra desktop application with the same two window types agreed for
macOS:

- **Full Hydra** - the existing project, head, diff, test, artifact, preview,
  publish, and review interface.
- **Focused chat** - a small conversation window attached directly to one
  registered project's real directory, without worktree-oriented chrome.

Several windows share one local Hydra backend and one set of projects, sessions,
and conversation history. Closing a window does not stop its head. Explicit Quit
must account for active work and for a backend which may be shared with a browser
or CLI client.

The behavioral contract for drafts, project selection, conversation history,
permissions, concurrent editors, closing an active chat, and notifications is
owned by [macos-desktop-chat.md](macos-desktop-chat.md). Those are cross-platform
product decisions despite that document's name. Linux work should not fork them.

## Goals

- Install and launch Hydra from an ordinary desktop application menu without a
  source checkout, Go toolchain, Node installation, or terminal setup.
- Bundle the Go backend and built React assets while continuing to use the same
  HTTP, WebSocket, event-store, and provider contracts as browser-served Hydra.
- Support current Linux desktop environments under Wayland and X11 without
  making one shell, panel, or tray implementation part of the product contract.
- Reuse an already-running compatible Hydra backend instead of creating a second
  database or agent owner.
- Preserve the Linux sandbox and egress guarantees of normal Hydra sessions.
- Provide signed, reproducible amd64 and arm64 artifacts with an update story
  that does not interrupt active heads unexpectedly.

## Non-goals for the first release

- Replacing the existing source-based `systemd --user` installation.
- Shipping a native GTK, Qt, or Rust implementation of chat or project UI.
- Supporting every distribution-specific package format on day one.
- Running providers inside Flatpak's application sandbox. Hydra's own sandbox
  launches tools, accesses registered source trees, and manages namespaces;
  nesting it inside a restrictive desktop sandbox is a separate investigation.
- Making a status icon the only way to reopen or quit Hydra. Some Linux desktops
  do not expose legacy trays or StatusNotifier items.
- Adding arbitrary-directory focused chats, provider-history import, or other
  features deliberately deferred by the shared desktop plan.

## Architecture

### Keep the desktop shell thin

The desktop layer owns only:

- application and multi-window lifecycle;
- starting or discovering one compatible backend;
- opening full and focused internal routes;
- native menus, file/directory dialogs, notifications, and deep-link routing;
- close and Quit coordination;
- packaging and update handoff.

React continues to own all product UI. The shell must not duplicate chat state,
settings, navigation, or permission decisions. Native-to-web messages should be
small semantic commands such as `new-focused-window`, `window-closing`, and
`notification-opened`, with versioned payloads and an ordinary browser fallback
for every essential flow.

### Select the webview by proving it

Do not commit to GTK/WebKitGTK, Wails, Tauri, or another wrapper from a feature
comparison. Build two disposable spikes against the production frontend. At
minimum compare:

1. a small GTK application using the distribution WebKitGTK runtime; and
2. the most credible maintained Go or Rust webview wrapper at spike time.

The comparison must exercise:

- independent windows sharing cookies, local storage, and authenticated
  WebSockets;
- the composer, terminal keyboard handling, clipboard, drag/drop, uploads,
  downloads, media, IME, screen readers, and high-DPI scaling;
- Wayland and X11 behavior, including popup placement and window activation;
- opening external links without allowing arbitrary navigation in the app
  webview;
- notification actions and click routing when every window is closed;
- portal-backed file and directory selection where available;
- backend launch, readiness, crash recovery, and clean Quit behavior;
- development against Vite without changing production routes;
- runtime and package size on representative distributions.

Prefer the smallest maintained shell that passes the spike. Using a system
WebKitGTK can reduce the shipped runtime and receive distribution security
updates, but makes minimum distro/runtime versions part of compatibility.
Bundling a browser runtime gives more rendering consistency at a much larger
artifact and update cost. Record that tradeoff with measured results before
choosing.

### One backend, with explicit ownership

Linux already has daemon sockets, runtime records, a localhost web listener, and
an optional `systemd --user` service. The app should extend those mechanisms
rather than invent a desktop-only server.

The launch sequence is:

1. Read a user-scoped discovery record containing a Unix socket path, PID,
   protocol version, build identity, and instance nonce. Do not assume a fixed
   TCP port.
2. Connect over the Unix socket and perform a versioned readiness handshake.
3. If no live compatible service exists, start the bundled Hydra backend and
   wait for it to publish the record atomically.
4. If the existing service is incompatible, show recovery choices. Never start
   a competing owner against the same state directory.
5. Mint a short-lived, single-use bootstrap credential for each webview, then
   replace it with the normal session credential. Do not put a durable auth key
   in a URL, process argument, log, or web storage.
6. Track whether the desktop process launched the backend, but do not equate
   ownership with window lifetime.

The lifecycle is:

- **Prefer an existing user service** when a compatible installed service is
  running.
- **Otherwise launch an app-managed detached per-user backend** whose lifetime
  is governed by active heads and explicit Quit, not by the last webview
  process.
- **Optionally integrate with systemd** through a packaged user unit or
  transient user service when available, while retaining a non-systemd path for
  distributions and containers which do not provide a user manager.

The CLI, desktop app, and browser must negotiate the same protocol and state
schema versions. A newer app may offer an explicit backend upgrade, but it must
not silently replace an executable while another client owns active work.

### State and filesystem locations

Use the XDG base directory rules, with a single migration/discovery layer shared
by desktop and CLI builds:

- configuration: `$XDG_CONFIG_HOME/hydra`, defaulting to `~/.config/hydra`;
- durable state and database: `$XDG_STATE_HOME/hydra`, defaulting to
  `~/.local/state/hydra`;
- caches and downloaded runtime assets: `$XDG_CACHE_HOME/hydra`, defaulting to
  `~/.cache/hydra`;
- sockets, locks, and bootstrap credentials: `$XDG_RUNTIME_DIR/hydra`, mode
  `0700` and rejected if ownership or permissions are unsafe;
- user-installed binaries and desktop files: XDG data locations, without
  assuming `~/.local/bin` is on the graphical session's `PATH`.

The agent/history SQLite database is user-global on every platform: under the
Linux state directory above, `~/Library/Application Support/Hydra` on macOS,
and `%LOCALAPPDATA%\Hydra` on Windows. CLI, browser-server, and desktop builds
open the same store. Project-local `.hydra/local` remains the home of worktrees,
caches, artifacts, tests, logs, and per-head sidecars.

On first open, Hydra transactionally imports agent rows from every registered
legacy project database. Conflicting agent IDs with different data abort the
whole import, completed source paths are recorded for idempotency, and legacy
database files are never changed or deleted automatically.

### Provider and tool discovery

A graphical launch inherits a much smaller environment than an interactive
shell. The application must not rely on `.bashrc`, `.zshrc`, `nvm`, or a terminal
setting `PATH`.

Reuse the explicit tool-resolution and environment-seeding model used by the
installed service. On first run, report provider executables and required
sandbox helpers as capabilities with actionable diagnostics. Let users choose
an absolute provider executable or an opt-in login-shell discovery step; do not
silently execute shell startup files on every launch.

Packaging the Hydra binary does not imply packaging Claude, Codex, Git, or all
build toolchains. The installer and first-run UI must state which external tools
remain required and which Hydra helpers are bundled.

### Sandboxing remains Hydra's boundary

The desktop wrapper must not weaken `internal/sandbox/linux.go`, network egress
filtering, MCP governance, GUI hardening, or focused-session permissions.
Running from a GUI changes process ancestry and environment, not the security
model.

Validate on real distributions that the packaged backend can still use the
required user namespaces, mounts, cgroups, and helper binaries. Detect missing
kernel features and unprivileged-user-namespace policy before the first session,
and distinguish a reduced capability from a secure hard-mode launch. Never
present Edit/Read-only or network filtering as enforced when its prerequisite is
unavailable.

Flatpak is deferred because its filesystem and process sandbox conflicts with a
tool whose purpose is to launch sandboxed developer processes over user-selected
source trees. An AppImage is less restrictive but still needs tests for mounted
runtime paths, executable discovery, updates, and sandbox helper behavior.

## Linux desktop integration

### Windows, menus, and deep links

- Register a desktop entry and stable application ID.
- Support New Full Window, New Chat Window, Settings, and Quit from the
  application menu and desktop actions where the environment exposes them.
- Treat single-instance activation as a request delivered to the existing app,
  not as permission to start another backend.
- Define a versioned `hydra://` deep-link grammar for project and conversation
  identities. Reject unknown actions and never accept raw filesystem paths or
  shell commands from a link.
- Restore window size and position conservatively. Do not restore a window
  entirely onto a disconnected display or assume client-side decorations.

### Notifications and background work

Use the desktop notification portal when available and a maintained
FreeDesktop-compatible fallback otherwise. Backend events remain semantic; the
shell decides whether and how the current environment can display actions.

Initial events match the shared plan: needs input, turn completed, turn failed,
and unexpected interruption. Suppress a notification when the relevant window
is active. A click must open or focus the exact conversation. Notification
buttons are an enhancement; the whole-notification click remains useful when a
server or desktop drops action buttons.

Do not require a tray icon. If StatusNotifier support is available it may show
running or waiting state and offer window actions, but notifications, desktop
activation, and reopening the installed app must cover environments without it.

### File selection and portals

Folder registration, uploads, downloads, and external-link opening should use
XDG Desktop Portal APIs where available. The web fallback remains available for
development and unusual environments. Portal document handles must not become
the persisted project identity: store the canonical project path after access
is granted, and detect when that access is no longer available.

## Packaging and updates

### Initial artifact set

Start with two architectures and a deliberately small support matrix:

- amd64 and arm64 tar archives for developers and diagnostics;
- AppImage as the first per-user, no-root installation attempt, only if the
  sandbox and webview spikes prove it reliable;
- a `.deb` package targeting Ubuntu LTS if AppImage fails that proof, and in any
  case before a production support promise;
- repository-native `.deb` and `.rpm` packages after filesystem layout,
  dependency versions, and upgrade behavior stabilize.

Every artifact includes the Hydra backend, built/precompressed web assets,
desktop entry, icons, MIME/deep-link registration, licenses, and any Hydra-owned
helpers. Prefer dynamic system webview dependencies if the selected shell and
support matrix make their versions tractable. Do not download executable code
on first launch merely to complete an advertised standalone install.

Publish the supported distribution versions, libc baseline, WebKit/runtime
minimums, kernel capability assumptions, and external provider requirements.
Unsupported environments should fail with a precise diagnostic rather than a
blank webview.

### Signing and provenance

- Build in a clean reproducible environment and emit checksums.
- Sign release metadata and packages using the mechanism appropriate to each
  repository/package format.
- Generate an SBOM for the Go binary, web dependencies, shell, and bundled
  helpers.
- Keep a machine-readable build identity and desktop/backend protocol version in
  both the shell and backend.
- Verify downloaded updates before staging them.

### Update behavior

The installed desktop app cannot assume a source checkout or compiler, so the
current source-rebuild update flow is not its distribution mechanism. Reuse its
verified staging, atomic replacement, and readiness principles with signed
binary releases.

An update must coordinate three things independently: desktop shell, backend,
and state schema. Download in the background, verify, and offer installation
only at a safe boundary. If active heads cannot survive backend replacement,
defer it or ask the user to stop them. Package-manager installations should be
updated by their package manager; the app may report availability but must not
overwrite package-owned files. A portable/AppImage build may use an app-owned
updater after that path is proven.

## Implementation sequence

### Phase 0: inventory the shared base

- Turn the built/unbuilt status in `macos-desktop-chat.md` into an executable
  desktop checklist rather than reimplementing focused heads.
- Confirm the focused API, permission restart, guarded commit, and chat-only
  layout work unchanged on Linux.
- Inventory current daemon discovery, project-scoped state, auth, tool lookup,
  runtime files, and `systemd --user` deployment.
- Define desktop/backend protocol and build identity fields before either spike
  grows a permanent bridge.

Exit criterion: a short architecture record names the existing interfaces the
desktop shell will call and the remaining shared gaps it depends on.

### Phase 1: prove the shell and backend handshake

- Build the two webview spikes and run the full matrix above on Wayland and X11.
- Launch two full-Hydra windows against one existing backend.
- Launch the bundled backend when none exists and prove atomic discovery,
  readiness, authentication, stale-record recovery, and version rejection.
- Close every window while a simulated head runs, then reopen without losing or
  duplicating it.
- Record measured framework results and make the shell decision in this doc.

Exit criterion: the selected unsigned development app can coexist with the CLI
and browser without competing backend or database ownership.

Status: a separately-tagged GTK 4/WebKitGTK 6 executable opens an explicit
loopback Hydra URL without adding desktop runtime dependencies to the normal
CLI. Daemon ownership and the SQLite agent/history store are now user-global;
the shell starts or reuses that service and reads its atomically published web
listener instead of assuming a port. The global database uses each platform's
native state location and transactionally imports retained project-local legacy
stores. Protocol negotiation, authentication bootstrap, multi-window behavior,
and the full shell comparison remain.

### Phase 2: add desktop window routes and lifecycle

- Finish the shared dedicated chrome-free focused route and immediate draft
  flow described by the macOS plan.
- Add native New Window/New Chat commands, project handoff, deep links, and
  active-window close confirmation.
- Implement explicit Quit semantics for app-launched, service-owned, and
  externally-owned backends.
- Keep browser-safe dialogs and navigation paths for every essential action.

Exit criterion: full and focused windows support the agreed lifecycle, and no
window action implicitly interrupts a head.

### Phase 3: integrate the Linux desktop

- Add desktop entry, icons, application ID, file/directory portals, external
  links, and notifications.
- Route notification clicks and secondary activations to exact windows.
- Add optional StatusNotifier integration without making it required.
- Verify accessibility, IME, clipboard, drag/drop, high-DPI, multi-monitor, and
  dark/light theme behavior across representative GNOME and KDE sessions.

Exit criterion: all critical flows work without a tray and under both Wayland
and X11.

### Phase 4: harden runtime and sandbox behavior

- Implement XDG runtime/state layout and compatibility lookup or migration.
- Make provider/helper discovery independent of an interactive shell.
- Package all Hydra-owned sandbox helpers and validate their permissions.
- Add capability diagnostics for namespaces, cgroups, network filtering,
  portals, notifications, and the selected webview runtime.
- Run focused Read-only/Edit and ordinary worktree sessions through the packaged
  app on every supported distribution.

Exit criterion: the package makes the same security claims as a tested CLI
installation, and refuses or clearly labels unavailable hard-mode features.

### Phase 5: package a preview

- Produce reproducible amd64 and arm64 archives and an AppImage preview.
- Prove user installation, desktop integration, mounted-runtime behavior,
  provider/tool discovery, sandbox helpers, and safe AppImage replacement on
  Ubuntu LTS/GNOME.
- If any required sandbox property cannot be preserved, stop the AppImage path
  and produce the Ubuntu LTS `.deb` instead.
- Add uninstall behavior which leaves user projects and durable Hydra state
  intact.
- Test clean install, upgrade, downgrade rejection, CLI coexistence, and removal
  in fresh VMs.
- Publish the support matrix and external tool requirements.

Exit criterion: a user can install, launch, run a focused edit safely, quit,
upgrade, and uninstall without a source checkout.

### Phase 6: production distribution

- Sign artifacts and release metadata, publish checksums and an SBOM, and add
  release CI on controlled amd64 and arm64 builders.
- Add `.deb` and `.rpm` repositories when dependency policy is stable.
- Add a portable updater only for artifacts not owned by a package manager.
- Expand distro coverage from test evidence, not from a generic "Linux"
  promise.

Exit criterion: supported installations have a verified update path and a
documented recovery path for backend or webview failure.

## Validation matrix

Test at least:

- the primary supported GNOME/Wayland distribution;
- KDE Plasma/Wayland;
- one X11 session;
- amd64 and arm64;
- systemd user manager present and absent;
- the minimum supported webview/runtime and the newest supported version;
- source-based CLI service already running, desktop backend already running,
  stale runtime record, incompatible backend, and backend crash;
- graphical login with a minimal `PATH` and no shell startup files;
- unprivileged user namespaces enabled and disabled;
- focused Read-only, focused Edit, guarded commit, and ordinary worktree heads;
- no tray/StatusNotifier implementation;
- notifications allowed, denied, and unavailable;
- high-DPI fractional scaling, multiple monitors, IME input, and a screen reader;
- clean install, upgrade with idle heads, update deferred for active heads, and
  uninstall while preserving state.

Run `mage build`, frontend lint/typecheck, and `go test ./...` for implementation
changes. Desktop acceptance additionally requires VM and real-session tests;
headless web tests cannot establish window-manager, portal, notification, IME,
or sandbox behavior.

## Risks to retire early

- **WebKitGTK fragmentation:** system runtime versions may differ enough to make
  frontend behavior or security support unpredictable.
- **Backend ownership ambiguity:** desktop, CLI, and a user service can race to
  own the same durable state unless discovery and locking are one protocol.
- **Graphical environment mismatch:** a terminal-tested provider may be missing
  from the app's `PATH`, environment, secret service, or agent socket.
- **Nested packaging constraints:** Flatpak, Snap, and AppImage each alter paths,
  mounts, process launch, or updates in ways that may conflict with Hydra's own
  sandbox.
- **Linux desktop variability:** trays, notification actions, activation, and
  client-side decorations are not consistent product foundations.
- **Update ownership:** an in-app updater must never overwrite files owned by a
  distribution package manager.
- **Security overclaim:** missing namespaces, cgroup delegation, or egress
  helpers must not silently turn a configured hard boundary into prompt advice.

## Open decisions for the spikes

- Which webview shell passes the measured Wayland/X11, accessibility, and
  multi-window requirements with the smallest maintainable dependency surface?
- Can AppImage preserve every required sandbox and helper behavior on Ubuntu
  LTS, or must the supported installer be the planned `.deb` fallback?
- Which existing project-scoped state belongs in the new XDG user-scoped state,
  and what compatibility window is required for CLI users?
- Can active provider processes survive a packaged backend update, or must the
  first updater always defer until all heads stop?
