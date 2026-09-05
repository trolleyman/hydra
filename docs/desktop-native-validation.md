# Desktop native validation

The shared Go and React tests, host builds, and cross-compilation catch protocol
and source regressions. They cannot accept behavior owned by AppKit/WKWebView or
Windows Forms/WebView2. The following release gates run on physical or virtual
machines of the target OS against the packaged application.

## Text input and IME

Test the composer, questions, settings inputs, terminal input, copy/paste, and
keyboard shortcuts with an ordinary Latin keyboard and at least one composing
input method (for example Japanese or Chinese). Composition text must remain
editable until commit; Enter, Escape, arrow keys, and app accelerators must not
submit, cancel, or corrupt it. Repeat after changing focus and opening a second
window. This catches native menu accelerators and webview key handling that DOM
tests do not reproduce.

## Accessibility

On macOS, run VoiceOver and keyboard-only navigation. On Windows, run Narrator
and keyboard-only navigation, with a focused pass using NVDA if it is part of
the supported matrix. Verify window/menu names, focus order, control roles and
states, dialog announcements, live approval/question notifications, zoom, and
high-contrast or increased-contrast modes. There must be no keyboard trap
between native chrome and the embedded webview.

## Notifications and activation

Exercise question, approval, completion, failure, and unexpected-backend-exit
notifications while the conversation is frontmost, in another Hydra window,
hidden/minimized, tray/menu-bar only, and fully exited where relaunch is
supported. A click must activate exactly the originating project and
conversation, dismiss or replace stale notifications, and never duplicate a
provider process. Notification permission denial must degrade to in-app state,
not lose the event.

## Multiple displays, DPI, and appearance

Open full and project-directory chat windows on displays with different scale factors. Move a
live window between them, detach/reconnect a display, sleep/wake, and relaunch.
Verify window bounds remain reachable, WebView pixels and text are sharp, menus
and popovers attach to the correct window, pointer coordinates remain correct,
and dark/light or contrast changes propagate without restarting. Windows also
needs per-monitor DPI and Remote Desktop coverage; macOS needs Retina/non-Retina
and Spaces/full-screen coverage.

## Installation and upgrades

Use clean target-OS VMs for each supported architecture. Cover unpackaged
development launch, clean install, launch after reboot, upgrade with no active
heads, upgrade deferred or cancelled with active heads, interrupted download or
install, rollback after failed readiness, downgrade refusal, repair, and
uninstall. Verify the database and user projects survive repair/uninstall,
shell/backend protocol mismatches fail clearly, package-manager-owned installs
are not overwritten by an app updater, and signatures/notarization remain valid
after replacement.

Upgrade tests must include migration from the last released database and
application layout, not only two builds from the same checkout. They need signed
artifacts and release metadata; an ad-hoc or unsigned development bundle can
exercise lifecycle but cannot accept the production trust/update path.

## Automation boundary

Automate repeatable assertions: clean install scripts, protocol/auth checks,
window launch counts, WebSocket continuity, persisted profile/cookies, update
readiness/rollback, database preservation, and accessibility-tree smoke tests.
The browser E2E suite runs the composer editing regressions in Playwright's
WebKit build when the host is Linux, giving every Linux run a quick WebKit
layout and editing pass. The Linux phase of the same E2E runner also builds
Hydra's GTK shell, opts it into automation with `--automation`, attaches the
distribution's `WebKitWebDriver`, and sends real X11 keyboard, pointer, and
clipboard events in a private Xvfb display. It requires WebKitWebDriver, Xvfb,
xdotool, and xclip; missing tools produce explicit skips.

The automation switch is opt-in and intended only for tests. Ordinary desktop
launches leave WebKit remote automation disabled. Treat the native runner as
development coverage rather than a packaged release result: release acceptance
still runs the installed application against the distribution's WebKitGTK
runtime.
Keep a short manual checklist for IME composition, screen-reader speech,
notification click behavior, multi-display movement, visual scaling, and OS
trust prompts. Record OS version, architecture, webview/runtime version, display
scales, input method, assistive technology, and package version with the result.
