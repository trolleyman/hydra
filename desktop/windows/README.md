# Hydra Windows development shell

This directory contains the thin Windows Forms/WebView2 host for Hydra. It owns
native application and window lifecycle while the existing Go backend and React
UI own all product state and rendering. It follows the AppKit/WKWebView shape in
`desktop/macos` rather than introducing a shared cross-platform shell runtime.

## Build on Windows 11

Requirements:

- Windows 11 x64 or Arm64;
- the .NET 8 SDK and Go/Node/Mage requirements used by the main Hydra build;
- the WebView2 Runtime;
- an extracted official 64-bit PortableGit distribution matching the target
  architecture.

From PowerShell at the repository root:

```powershell
desktop\windows\build-app.ps1 -Runtime win-x64 -PortableGitDirectory C:\Downloads\PortableGit
dist\windows\win-x64\Hydra\Hydra.exe
```

The script produces a self-contained .NET application, the bundled Go backend,
and the supplied PortableGit distribution. The app always prepends that Git to
the backend's `PATH`; it does not select a system Git. Provider CLIs such as
Claude Code, Codex CLI, Gemini CLI, and Copilot CLI remain external.

For shell development without rebuilding the bundled Go executable, set
`HYDRA_DESKTOP_BACKEND` to a Windows Hydra executable before launching the app.

## Current behavior

- The app probes `127.0.0.1:26600` and attaches to a compatible Hydra server.
- Otherwise it asks for an initial project, starts the bundled backend on an
  OS-assigned loopback port, and waits for its atomic readiness record.
- Every window shares one backend and one persistent WebView2 user-data folder.
- Ctrl+N opens a full window. Ctrl+Shift+N opens the focused project composer.
- Closing every window leaves the notification-area icon and app-owned backend
  alive. Its menu can open a new full/focused window or exit Hydra.
- Exit stops an app-owned backend after confirming when sessions are active. A
  compatible server which was already running is never stopped by the app.
- Backend output is appended beneath `%LOCALAPPDATA%\Hydra\logs`.

This is an unsigned development shell, not a production installer. The native
Windows session backend and sandbox remain release gates in
`docs/windows-support.md`.

## Required Windows validation

- Restore and publish both target runtimes from a clean checkout.
- Verify two full and two focused windows share storage, WebSockets, and live
  session state.
- Verify the readiness file, bundled Git selection, logs, backend failure, and
  app-owned versus pre-existing server behavior.
- Verify keyboard accelerators do not steal composer/terminal input, including
  IME, paste, upload, external links, accessibility, and per-monitor DPI.
- Verify active-session Exit confirmation and whole backend process-tree exit.
- Verify last-window, notification-area reopen, and explicit Exit behavior.
