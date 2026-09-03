# Roadmap - open items

This is Hydra's concise backlog of known gaps and promising next steps. It is
not a commitment or an implementation history. Detailed design notes live in
the linked subsystem documents, and completed work belongs in Git history.

## Current focus

- Finish validating and packaging the native desktop apps.
- Make review and diff workflows easier to navigate and trust.
- Close the remaining cross-platform sandbox gaps.

## Sandbox and platform support

- [ ] **Finish native Windows support.** Implement the Windows sandbox backend,
  ConPTY attachment, network enforcement, and native validation. WSL2 remains
  the supported Windows path for now. See
  [windows-support.md](windows-support.md).

- [ ] **Finish macOS sandbox hardening and validation.** Complete hard network
  egress, temporary-directory and copy-on-write handling, then exercise the
  Seatbelt backend on supported macOS releases. See
  [macos-support.md](macos-support.md).

- [ ] **Show shared-cache storage usage.** Add per-key sizes and cleanup controls
  to the Project settings cache list without putting directory scans on the
  normal config-read path.

- [ ] **Isolate selected provider state per head on Linux.** Split Claude and
  Codex state into copied refreshable authentication, private writable session
  data, and read-only shared extensions, matching the macOS provider-state
  layout without cloning large session databases or breaking resume. Provider
  directories are already selected by agent type, so other providers remain
  absent while this deeper same-provider isolation is designed.

## Agent and review UX

- [ ] **Track session ownership explicitly.** Record the owning head on each
  session and sweep by that field instead of relying on slot ID prefixes.

- [ ] **Add language-server access for agents.** Provide a Go language server
  first so agents can query definitions, references, and diagnostics directly.

- [ ] **Extend `hydra attach`.** Allow `hydra attach <id> [command]` to run an
  arbitrary command in a head's sandbox, including when the agent session needs
  to be resumed first.

- [ ] **Make long-running lifecycle operations observable.** Give merge and kill
  explicit transitional states, stream command output with stdout/stderr
  ordering preserved, and keep controls disabled only while work is active.

- [ ] **Finish review-slot validation and affordances.** Exercise reviewers
  against real heads, expose reviewer status and unread activity in the tab UI,
  and decide whether named review lenses such as security deserve additional
  slots. The detached review checkout already follows new commits. See
  [review-agent.md](review-agent.md).

- [ ] **Complete comment activity UX.** Add per-comment read state, batched
  notifications, and decide whether agents may resolve review threads. The
  server-side comment store, shared numbering, agent tools, mentions, and diff
  rendering are already built. See [review-agent.md](review-agent.md) and
  [review-threads.md](review-threads.md).

## Diff viewer

- [ ] **Clarify comparison selection.** Make valid base/target combinations
  obvious, put recent states first, and select the right comparison when jumping
  to uncommitted changes.

- [ ] **Stabilize the diff header and comment composer.** Keep the uncommitted
  indicator from reflowing the header, render new comments inline with the diff,
  and remove clipping, flicker, and keyboard-submit bugs.

- [ ] **Complete demo-mode context expansion.** Make expand-lines controls work
  against simulation data as they do against a real repository.

- [ ] **Add image-file diffs.** Reuse the artifact image comparison UI for image
  files changed between Git refs.

- [ ] **Add durable per-file review state.** Track which files have been viewed
  and how far review has progressed without marking new changes as already read.
  See [diff-review-state.md](diff-review-state.md).

- [ ] **Revisit moved-block visualization only with the quieter design.** The
  earlier whole-line colour treatment was reverted; any retry should use boxed,
  identity-preserving moves with jump navigation. See
  [diff-moved-blocks.md](diff-moved-blocks.md).

## Artifacts and web UI

- [ ] **Render ANSI styling in artifact logs.** Replace ANSI stripping with a
  safe SGR renderer for colour, emphasis, and dim output while preserving the
  existing stdout/stderr distinction.

- [ ] **Add inspector tabs and durable activity rows.** Give Tests, Previews,
  Artifacts, and Files addressable subviews inside the inspector pane, while
  recording head lifecycle events in chat rather than hiding them in ephemeral
  toasts. See [agent-page-tabs.md](agent-page-tabs.md).

- [ ] **Lazy-load syntax highlighting in Markdown fences.** Let uncommon fenced
  languages request their Prism grammar and re-render, matching the diff and
  repository viewers.

## Git and notifications

- [ ] **Support interactive Git credential prompts safely.** Relay Git and SSH
  askpass prompts through a time-limited UI flow without logging or persisting
  secrets; keep non-interactive failure as the fallback.

- [ ] **Add actions to supported OS notifications.** Use a minimal service worker
  for approval actions and closed-tab routing while retaining click-to-open
  behavior on platforms that do not support notification buttons.

## Desktop and chat

- [ ] **Ship validated native desktop apps.** Complete real-device validation,
  lifecycle bridges, notifications, accessibility, signing, packaging, and
  update flows for the existing Linux, macOS, and Windows shells. See
  [linux-desktop.md](linux-desktop.md),
  [macos-desktop-chat.md](macos-desktop-chat.md), and
  [windows-desktop-chat.md](windows-desktop-chat.md).

- [ ] **Add voice input.** Offer optional dictation from the chat composer with
  clear recording state and platform-appropriate permission handling.

## Deployment

- [ ] **Restart without stopping running heads.** Preserve agent sessions across
  daemon re-exec without weakening the guarantee that crashed daemons cannot
  orphan sandbox processes. See [deployment.md](deployment.md).

- [ ] **Add named installed instances if real demand appears.** Explicit state
  directories already isolate development and simulation instances; a supported
  named service would also need namespaced logs, IDs, runtime paths, and service
  units.
