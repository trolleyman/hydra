# Hydra macOS development shell

This directory contains the thin AppKit/WKWebView host for Hydra. It owns native
application and window lifecycle while the existing Go backend and React UI own
all product state and rendering.

## Build on macOS

Requirements:

- macOS 13 or newer;
- Xcode Command Line Tools with Swift 5.9 or newer;
- Go, Node, and Mage as required by the main Hydra build.

From the repository root:

```bash
desktop/macos/build-app.sh
open dist/macos/Hydra.app
```

The development build is ad-hoc signed. It is not notarized or suitable for
distribution yet.

For shell development without rebuilding the bundled Go executable, set
`HYDRA_DESKTOP_BACKEND` to an executable Hydra binary before launching the app
from a terminal. Finder launches do not inherit shell environment variables.

## Current behavior

- The bundled CLI connects through Hydra's filesystem-protected daemon control
  socket, reusing or starting the shared daemon and reading its PID-bound,
  versioned random-port record. There is no fixed TCP-port probe.
- The CLI returns a one-minute, single-use web bootstrap token; WKWebView
  redeems it for the shared HttpOnly session cookie.
- Every window shares one backend, WebKit's process model, the default cookie
  store, and local storage.
- Cmd+N opens a full Hydra window. Cmd+Shift+N opens the dedicated project-directory chat draft
  route, which creates its branchless session on first submit.
- Project-directory windows expose project and live/loaded archived history controls plus
  Stop Session and Close / Close and Keep Running / Cancel for an active turn.
  Stopping retains the head, worktree, branch and conversation.
- Closing all windows leaves the app running; quitting the native shell still
  leaves the shared backend and running work available to another Hydra client.
- Backend output is appended to
  `~/Library/Application Support/Hydra/logs/backend.log`.

## Required on-device validation

Before treating this as a shippable app, verify on a real Mac:

- two full and two project-directory chat windows share cookies, local storage, WebSockets, and
  live session state;
- the shared daemon's PID-bound endpoint record appears atomically, stale
  records are rejected, and a reused service-owned daemon survives app Quit;
- Cmd+N/Cmd+Shift+N, window tabbing, text input, IME, paste, file upload, shell
  tabs, and external links behave correctly;
- closing the final window leaves running work attached and reopening a window
  does not duplicate the provider process;
- the active-session Quit confirmation is accurate;
- Gatekeeper behavior is understood for the ad-hoc build before adding Developer
  ID signing and notarization.

Native notifications, notification click routing, a menu-bar status item,
frontmost-project tracking, universal binaries, signing/notarization, and
coordinated updates remain. Follow
[desktop-native-validation.md](../../docs/desktop-native-validation.md) for the
IME, accessibility, notification, multi-display, and upgrade acceptance gates.
