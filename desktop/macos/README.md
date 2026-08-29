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

- The app first probes `127.0.0.1:26600` and attaches when the server reports a
  compatible version.
- Otherwise it asks for an initial project, starts the bundled backend on an
  OS-assigned loopback port, and waits for its atomic readiness record.
- Every window shares one backend, `WKProcessPool`, cookie store, and local
  storage.
- Cmd+N opens a full Hydra window. Cmd+Shift+N opens a project composer with the
  focused workspace and Edit mode preselected.
- Closing all windows leaves the app and app-owned backend running. Use the Dock
  or File menu to open another window.
- Explicit Quit stops an app-owned backend. If active sessions are found, Hydra
  confirms first. A server that was already running is never stopped by the app.
- Backend output is appended to
  `~/Library/Application Support/Hydra/logs/backend.log`.

## Required on-device validation

Before treating this as a shippable app, verify on a real Mac:

- two full and two focused windows share cookies, local storage, WebSockets, and
  live session state;
- the backend readiness record appears atomically and an app-owned server exits
  cleanly on Quit;
- an existing compatible `hydra server` is reused and survives app Quit;
- Cmd+N/Cmd+Shift+N, window tabbing, text input, IME, paste, file upload, shell
  tabs, and external links behave correctly;
- closing the final window leaves running work attached and reopening a window
  does not duplicate the provider process;
- the active-session Quit confirmation is accurate;
- Gatekeeper behavior is understood for the ad-hoc build before adding Developer
  ID signing and notarization.

Native notifications, a menu-bar status item, notification click routing,
universal binaries, signing/notarization, updates, and the dedicated immediate
focused-draft route remain follow-up work.
