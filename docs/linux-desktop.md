# Hydra as a standalone Linux app

Status: **preview implementation built; native lifecycle, notifications, folder
selection, diagnostics, and a local `.deb` target are present. Platform release
validation remains.**
This document adapts the desktop product defined in
[macos-desktop-chat.md](macos-desktop-chat.md) to Linux. The shared backend, API,
and React base is already the branch point for platform work: project-directory heads are
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
- **First packaging attempt:** an Ubuntu LTS `.deb` using the distro GTK 4 and
  WebKitGTK 6 runtimes. AppImage is deferred until mounted-runtime sandbox and
  upgrade behavior can be proven without weakening Hydra's sandbox.

## Product shape

Ship one Hydra desktop application with one responsive React shell. Each window
may display any canonical Hydra route. New chat windows begin on a
project-directory draft; existing conversations open their ordinary agent URL.
The available width determines the layout, rather than a dedicated window mode.

A project-directory chat is attached directly to one registered project's real
directory and omits the worktree inspector. Edit/Read-only and Allow commits sit
beside its workspace chip; the normal configuration strip retains test, network,
Git access, checked-out branch, and run mode.

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
- Adding arbitrary-directory project-directory chats, provider-history import, or other
  features deliberately deferred by the shared desktop plan.

## Architecture

### Keep the desktop shell thin

The desktop layer owns only:

- application and multi-window lifecycle;
- starting or discovering one compatible backend;
- opening full and project-directory internal routes;
- native menus, file/directory dialogs, notifications, and deep-link routing;
- close and Quit coordination;
- packaging and update handoff.

React continues to own all product UI. The shell must not duplicate chat state,
settings, navigation, or permission decisions. Native-to-web messages should be
small semantic commands such as `new-chat-window`, `window-closing`, and
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
open the same store. That state root also holds worktrees, caches, artifacts,
tests, logs, and per-head sidecars under `projects/<stable-project-id>/`.
Checkout development runtimes use the checkout's `.hydra/local` as their whole
state root, so their databases and project trees remain independent and are
never imported into production state.

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
filtering, MCP governance, GUI hardening, or project-directory-session permissions.
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
- Use `org.trolleyman.hydra` as the GTK application ID and keep it identical to
  the desktop-entry basename so Wayland and X11 associate every Hydra window
  with the installed Hydra icon.
- Support New Full Window, New Chat Window, Settings, and Quit from the
  application menu and desktop actions where the environment exposes them.
- Treat single-instance activation as a request delivered to the existing app,
  not as permission to start another backend.
- Use the constrained [`hydra://` deep-link grammar](desktop-deep-links.md) for
  project and conversation identities. Reject unknown actions and never accept
  raw filesystem paths or shell commands from a link.
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

### Profiling the webview

The Linux shell keeps WebKit developer features off during ordinary runs and
exposes opt-in diagnostics:

- `hydra-desktop --devtools` enables the WebKit Web Inspector. Open it from the
  application menu or with Ctrl+Shift+I, select Timelines, start recording, and
  reproduce the interaction. A diff-scroll capture should include a few seconds
  at rest before and after the scroll so JavaScript, style/layout, paint, and
  compositing work can be separated.
- `hydra-desktop --compositing-indicators` draws WebKit's accelerated-layer
  borders and repaint counters in the page. Repaint counters that climb across
  large diff surfaces while scrolling point to paint/compositing cost rather
  than React render work. Run this separately from the timing capture because
  the diagnostic overlay adds work of its own.
- `hydra-desktop --disable-persistent-animations` holds looping gradients,
  shimmers, status pulses, spinners, and work sparks still. Ordinary desktop
  runs retain their animation. Use the static mode as an A/B comparison when a
  timeline shows continuous full-window paints while the page is otherwise
  idle; short interaction and entrance transitions remain enabled.
- `hydra-desktop --hardware-acceleration=never` selects WebKitGTK's
  non-accelerated rendering path. The default is `always`, matching the normal
  WebKitGTK 6 policy. Treat `never` as a profiling comparison rather than an
  assumed optimization: depending on the graphics stack and page, it can reduce
  full-surface compositing work or make rendering slower.
- `hydra-desktop --low-paint` enables a deliberately plain diagnostic rendering
  mode. It disables CSS animations, transitions, gradients, rounded clipping,
  shadows, filters, masks, explicit layer hints, and sticky positioning. The
  mode keeps controls usable for typing and scrolling, but it is not a product
  theme and should only be used to distinguish page styling cost from
  WebKitGTK's final-surface paint cost.

For a checkout-local profiling run, use the environment form so Mage can keep
its normal development state and daemon setup:

```bash
HYDRA_DESKTOP_DEVTOOLS=1 \
HYDRA_DESKTOP_COMPOSITING_INDICATORS=1 \
mage runDesktopLocal
```

Use only `HYDRA_DESKTOP_DEVTOOLS=1` for the first timing capture. Then repeat
with only `HYDRA_DESKTOP_COMPOSITING_INDICATORS=1` to inspect repaint behavior,
or compare the original timeline against:

```bash
HYDRA_DESKTOP_DEVTOOLS=1 \
HYDRA_DESKTOP_DISABLE_PERSISTENT_ANIMATIONS=1 \
mage runDesktopLocal
```

To compare accelerated and non-accelerated rendering while retaining ordinary
animations, run:

```bash
HYDRA_DESKTOP_DEVTOOLS=1 \
HYDRA_DESKTOP_HARDWARE_ACCELERATION=never \
mage runDesktopLocal
```

`HYDRA_DESKTOP_HARDWARE_ACCELERATION` accepts only `always` or `never`; an
invalid value stops the launch with an error. It can be combined with
`HYDRA_DESKTOP_DISABLE_PERSISTENT_ANIMATIONS=1` for the fourth case in a full
rendering-path/animation A/B comparison.

For the maximal low-paint comparison, use the default accelerated renderer and
change only the page styling mode:

```bash
HYDRA_DESKTOP_DEVTOOLS=1 \
HYDRA_DESKTOP_LOW_PAINT=1 \
mage runDesktopLocal
```

`HYDRA_DESKTOP_LOW_PAINT=1` already disables every CSS animation, so it does not
need `HYDRA_DESKTOP_DISABLE_PERSISTENT_ANIMATIONS=1`.

The flags and environment variables apply to every webview opened by that
desktop process and are not persisted in Hydra settings.

When the Web Inspector shows little main-thread work but the window still
stutters, record the native multi-process application with Linux `perf`:

```bash
perf record --call-graph dwarf -- ./dist/linux/hydra-desktop --devtools
perf report --children
```

WebKit uses separate UI, web-content, network, and GPU processes, so retain
child-process samples and compare their command names. Distribution debug
symbols make native stacks substantially more useful. Some systems restrict
unprivileged performance counters; use the Web Inspector path when local policy
does not permit `perf`, rather than changing machine-wide security settings just
for Hydra.

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
  desktop checklist rather than reimplementing project-directory heads.
- Confirm the project-directory API, permission restart, guarded commit, and chat-only
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
native state location; checkout-local development databases remain independent
and are never imported into it. A desktop client now obtains a one-minute, single-use login credential
over the filesystem-protected daemon socket, places it only in the URL fragment,
and redeems it for the ordinary HttpOnly session cookie before routing starts.
TCP clients cannot mint credentials and redemption consumes them. A
desktop-owned backend always removes the localhost trust exemption and creates
an ephemeral auth secret when deploy configuration has none, so an unrelated
browser or loopback application cannot use its API. Like any per-user Unix
socket, this does not claim to exclude a hostile process already running as the
same OS user. Multi-window
behavior and the full shell comparison remain. The daemon's web endpoint is now
a versioned JSON ownership record tied to the authoritative live daemon PID;
stale records are ignored during startup, unsafe/non-loopback addresses and
unknown record protocols are rejected, and shutdown removes the record.
Every live `/api/status` response also advertises the shared desktop protocol
and backend build identity. Linux refuses to attach when the protocol is absent
or different, so compatibility is checked for reused daemons as well as newly
launched ones.
The GTK shell also supports repeated application activation and Ctrl+N as
native multi-window actions against the same application/backend. Each desktop
launch uses a fresh WebKit network session because the backend has a new random
loopback origin and a reused port must not expose an earlier launch's storage.
The shell mirrors Hydra's local-storage keys into a stable file under the
selected Hydra state root and restores them before the page loads. Updates are
batched through WebKit's in-process script-message channel, with no network
request. Browser-local state such as the last project, model, view preferences
and drafts therefore survives an app restart, while checkout-local development
runs remain isolated from the installed app. WebKit
policy keeps same-origin Hydra navigation embedded, opens clicked external
HTTP(S) links with the system handler, and blocks cross-origin redirects and
non-web schemes. Window-manager lifecycle still needs native Wayland/X11
validation.
Desktop cold-start explicitly binds `127.0.0.1:0`; the assigned port exists only
in the private ownership record. `mage buildDesktop` and `mage runDesktop`
dispatch by host OS; on Linux they build the frontend and tagged shell.
`mage runDesktop` uses the stable production socket and global database while
owning its development backend for the lifetime of the Mage command. It replaces
an earlier desktop-managed development backend so rebuilt code is loaded, then
stops its backend when the app exits or the command receives Ctrl+C. It clears
inherited development runtime,
database, and listener variables, including when launched from a terminal opened
inside a development Hydra. On Linux, both Mage runners use and register the
hidden user-local application identity `org.trolleyman.hydra.Devel`, including
its Hydra icon. The separate identity leaves an installed
`org.trolleyman.hydra` desktop entry, icon, and deep-link handler unchanged.
`mage runDesktopLocal` uses the
checkout-local development database and a worktree-specific daemon runtime
namespace while exercising this same random-port path. `mage run` uses that same
development namespace, so the two local commands can deliberately share a
backend. A directly launched Linux build defaults to production mode as well;
the local mode marker is supplied only by `runDesktopLocal`. It therefore selects
the stable production socket and global database instead of attaching based on
whichever daemon happened to start first. The namespace
isolates the socket, lock, PID, ownership metadata, listener record, and log, so
running a development desktop cannot attach to or restart another Hydra daemon
for the same OS user. The bundled `__desktop-connect` command exposes this same
control-socket discovery/bootstrap operation to thin native shells without
making the filesystem-protected endpoint protocol platform-UI-specific.
When either Linux Mage desktop runner closes or receives Ctrl+C, Mage stops the
desktop-managed daemon it owns. `runDesktopLocal` still leaves an existing
foreground `mage run` daemon alive. A directly launched installed desktop keeps
its global backend running according to the preference in Settings. The native
application has one primary Hydra window; further activations present it, while
additional windows may open new or existing conversations using the same
responsive routes. A native New Chat window starts at 940 x 780 with its sidebar
collapsed; expanding it is local to that window and does not overwrite the main
window's saved sidebar preference. The same URLs open in a browser when no
native bridge is present.
Daemon control and web listeners become ready before best-effort recovery of
previously running heads. Slow or broken provider/sandbox recovery therefore
appears in the daemon log without making the desktop report a false startup
timeout.

### Phase 2: add desktop window routes and lifecycle

- [x] Add the shared project-directory draft flow and canonical agent navigation
  described by the macOS plan.
- [x] Wire the shared lifecycle bridge into WebKitGTK for New Window, New Chat,
  and close requests. AppKit and WebView2 additionally consume
  active-project and active-turn lifecycle messages.
- [x] Add native New Window/New Chat/Settings commands, project handoff, a
  constrained [`hydra://` deep-link grammar](desktop-deep-links.md), and
  active-window close confirmation.
- [x] Guard only the last window while agents are actively working. Finished or
  waiting heads may retain a reusable sandbox process without triggering the
  guard, and closing a secondary window never offers to stop its shared head.
- [x] Make close and Quit copy follow backend ownership. Installed persistent
  backends leave agents running when a window closes. Command-owned Mage desktop
  runs explain that closing the last window stops the backend. Dialog titles
  report the number of active agents.
- Keep browser-safe dialogs and navigation paths for every essential action.

Exit criterion: windows at full and chat routes support the agreed lifecycle,
and no window action implicitly interrupts a head.

### Phase 3: integrate the Linux desktop

- [x] Stage a Freedesktop desktop entry, hicolor icon, and stable application ID
  in the explicit Linux build output.
- [x] Add a GTK folder chooser (portal-backed by GTK where the desktop exposes
  one) and GNotification integration, advertised to the web UI through explicit
  shell capabilities so other platform shells retain browser fallbacks.
- [x] Route notification clicks to the exact project/agent URL. Secondary
  process deep-link handoff to an already-running instance still needs an
  installed-session test.
- [x] Bridge GTK clipboard textures into the attachment-aware chat and spawn
  composers so Ctrl+V uploads copied images even when WebKitGTK omits them from
  the web paste event. Text paste stays on WebKitGTK's native path. The project-directory
  textarea opts into the bridge, so a sidebar spawn form mounted beside chat
  cannot consume that chat's paste.
- Keep desktop attachments on the normal local upload path. "Upload" here is a
  same-machine transfer into the project's ignored Hydra state, not a remote
  network upload. The copy gives the attachment a stable, browser-servable path
  after the source is moved or a head is removed, while the ordinary sandbox
  mask and read rules still govern arbitrary original paths. Dragging or pasting
  a file grants access only to that copied attachment; it does not turn desktop
  mode into unrestricted path serving.
- Add optional StatusNotifier integration without making it required.
- Verify accessibility, IME, clipboard, drag/drop, high-DPI, multi-monitor, and
  dark/light theme behavior across representative GNOME and KDE sessions.

Exit criterion: all critical flows work without a tray and under both Wayland
and X11.

### Phase 4: harden runtime and sandbox behavior

- Implement XDG runtime/state layout and compatibility lookup or migration.
- Make provider/helper discovery independent of an interactive shell.
- Package all Hydra-owned sandbox helpers and validate their permissions.
- [ ] Complete capability diagnostics for namespaces, cgroups, and network
  filtering. `hydra-desktop --diagnostics` now reports GTK/WebKitGTK versions,
  display/session details, desktop-bus notification availability, and portal
  availability as JSON.
- Run read-only/editable project-directory and ordinary worktree sessions through the packaged
  app on every supported distribution.

Exit criterion: the package makes the same security claims as a tested CLI
installation, and refuses or clearly labels unavailable hard-mode features.

Status: `/api/status` now reports the host OS plus native sandbox availability
and its diagnostic reason. Project-directory desktop windows visibly warn when the
sandbox backend is unavailable. Fine-grained namespace, cgroup, portal,
notification, and webview-runtime probes remain.

### Phase 5: package a preview

- [x] Add `mage buildDesktopDeb`, producing an amd64/arm64 `.deb` on the matching
  Linux host with the binary, desktop entry, icon, URL-scheme registration, and
  GTK/WebKitGTK dependencies.
- Prove user installation, desktop integration, mounted-runtime behavior,
  provider/tool discovery, sandbox helpers, and safe AppImage replacement on
  Ubuntu LTS/GNOME.
- [x] Use the Ubuntu LTS `.deb` path for the preview rather than claiming an
  unvalidated AppImage sandbox.
- Add uninstall behavior which leaves user projects and durable Hydra state
  intact.
- Test clean install, upgrade, downgrade rejection, CLI coexistence, and removal
  in fresh VMs.
- Publish the support matrix and external tool requirements.

Exit criterion: a user can install, launch, run a project-directory edit safely, quit,
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
- read-only and editable project-directory modes, guarded commit, and worktree Heads;
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
