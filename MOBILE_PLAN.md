# Mobile / Small-Screen Plan

Status of making Hydra's web UI usable on phones and other narrow viewports.
(Rewritten 2026-07-08; the original long-form plan is in git history.)

## What shipped

- **Responsive shell** (`web/src/routes/__root.tsx`): no global top bar; the
  sidebar owns the chrome and is collapsible on every size (header button,
  floating reveal, Ctrl/Cmd + .), persisted. Below `lg` it is an off-canvas
  overlay that closes on navigation / backdrop tap.
- **Agent detail on narrow screens** (`AgentDetail.tsx`): header/metadata rows
  wrap, padding tightens. The planned terminal/diff/artifacts *tabs* were
  dropped in favour of simple vertical stacking - simpler, and the chat view
  made the terminal much less central on mobile.
- **Diff viewer narrow mode** (`DiffViewer.tsx`): the file-list column is
  hidden below `md`; the diff takes the full width.
- **Repository browser**: two-column tree+content collapses to a paged
  mobile flow (`mobileContentOpen` in `RepositoryView.tsx`).
- **Touch support**: sidebar and terminal resize handles use pointer events
  (`touch-none`), so they work with touch.
- **Header/dropdowns**: overflow menus + responsive padding
  (`HeaderOverflowMenu`, `SpawnForm.tsx`); viewport meta is present.
- **Safe-area insets**: `viewport-fit=cover` + `env(safe-area-inset-*)`
  padding on `body` (`web/index.html`, `web/src/index.css`) keep the app
  shell clear of notches / punch-holes / the iOS home indicator.
- **Screenshots**: phone/tablet portrait+landscape and collapsed states are
  captured and tagged with `viewport::` axes in
  `web/scripts/screenshots/take-screenshots.ts`.
- **Chat view**: the original Phase 2 (parse the CLI's on-disk transcript into
  a new `GET .../messages` endpoint) and Phase 3 (structured stream-json
  driver) were superseded by **chat mode** - Claude runs in stream-json and
  the conversation streams as chat framing over the existing terminal
  WebSocket (`internal/claudestream`, `internal/http/chat_ws.go`,
  `web/src/components/AgentChat.tsx`). This is the phone-friendly interaction
  model, shipped; no transcript-parsing REST endpoint exists or is planned.

## Remaining

1. **Terminal height on mobile**: `AgentTerminal.tsx` uses a fixed 450px
   default. Deliberately deprioritised: chat mode is the phone experience,
   so this only affects deliberate raw-terminal use on a phone.
2. **Chat for Gemini / Copilot**: `chat_mode` is Claude-only (rejected for
   other agent types in `internal/http/handlers.go`). Needs per-CLI structured
   stream support; bash stays terminal-only by nature.
3. **Remote access/auth** for using the UI off the local machine remains out
   of scope here (see `[deploy]` / ngrok tooling).
