# Roadmap - open items

The open backlog, extracted from the former root-level `PLAN.md` when its 82
completed items were retired. These are ideas and gaps, not commitments, and some
may have been partly addressed since they were written - check the current code
before starting. Grouped by area.

## Sandbox

- [ ] **Network: enforce `allowed_hosts` at the OS layer.** The config field was
  originally reserved but unenforced (full network on/off only). A filtering
  HTTPS-CONNECT proxy the sandbox is forced through gives host-level egress
  control without root. (Largely delivered by `internal/egress`; see
  [security-audit.md](security-audit.md) rec 3 - retained here for the pieces not
  yet covered.)

- [ ] **Windows: implement the Windows Sandbox backend and ConPTY attach.**
  Currently stubbed with a clear "not supported" error. See
  [windows-support.md](windows-support.md).

- [ ] **Per-agent network namespace + rootless userspace NAT for true port
  isolation.** Today the Linux sandbox network is binary
  (`internal/sandbox/linux.go`): the default **shares the host network
  namespace**, so every agent sees the host's `127.0.0.1` and the same port space
  - two agents both grabbing `:5173`/`:8080` collide, and an agent's dev server is
  reachable from (and clashes with) everything else on the box. The only
  alternative, `network.enabled=false` -> `--unshare-net`, gives a fresh netns
  with its own loopback (real port isolation) but **kills outbound entirely**,
  which most agents need (bun/git/API). macOS (`darwin.go`) is even coarser:
  `(deny network*)` is all-or-nothing (Seatbelt _can_ express
  `network-bind`/`network-outbound` port filters, but we don't use them; and macOS
  has no netns, so it can't give per-agent localhost isolation anyway).

  _Stop-gap already shipped:_ the pre-prompt tells agents to bind servers to
  custom/non-default localhost ports (ideally OS-assigned) and never assume
  well-known ports are free. That's convention, not enforcement.

  _Proposed fix:_ give each agent its **own** network namespace (own loopback =>
  full per-agent port isolation - its `:5173` is invisible to other agents and the
  host) **while keeping outbound** via a rootless userspace NAT: `pasta` (from
  passt; preferred - fast, no extra caps) or `slirp4netns`, the same approach
  Podman uses for rootless containers. Work involved: (a) add `pasta`/`slirp4netns`
  as a host dependency (neither is installed today); (b) wire bwrap to run under
  the NAT - either run `pasta` against the sandbox PID's netns, or launch the bwrap
  tree inside the NAT's namespace; (c) decide inbound policy - host services agents
  may need to reach (web UI `:8080`, the `--simulation` artifact server) would
  require explicit port mapping through the NAT; (d) keep the current shared-net
  path as a fallback when the NAT helper is absent. Moderate effort + a new host
  dependency; do it once cross-agent port collisions become real pain. (The egress
  work has since built on pasta - this item is the port-isolation half.)

- [ ] **Reconsider `~/.cache` being writable, and give Hydra a real cache story.**
  `internal/sandbox/defaults.go` grants every head write access to `~/.cache` as
  a "broad XDG cache shared by many tools". On this machine that directory holds
  an **18GB Go build cache**, a 2.5GB Google profile cache and 2.1GB of
  google-chrome - so an agent can write entries the HOST later builds from or a
  browser later reads. The sandbox otherwise confines writes to the worktree;
  this is the widest hole in that, and it is a default rather than a considered
  grant.

  The mechanism to fix it already exists: `cow_paths` takes a home/absolute
  entry, overlays it in place, and "supersedes its writable bind" - reads pass
  through to the real directory, writes stay per-head. So `cow_paths =
  ["~/.cache"]` keeps every cache WARM on read (the 18GB of Go objects, the
  646MB of Playwright browsers) while making writes invisible to the host. One
  line, already built.

  What that breaks is the reason to think about it properly: writes stop
  persisting ACROSS heads, and some are meant to. `web/scripts/build-fonts.ts`
  keeps built webfonts in `~/.cache/hydra/fonts/<signature>/` precisely so a
  fresh worktree restores in 0.06s instead of rebuilding for 19s, and each head
  gets a fresh worktree. Under CoW that reverts to 19s per head.

  So the shape is: **default-deny (CoW `~/.cache`), opt-in share** - one narrow
  Hydra-owned directory bound read-write and shared across heads, for artifacts
  that are content-addressed and cheap to distrust. Today's default is the
  inverse, share-everything.

  **Per-project, not machine-wide** (decided): encapsulation is the point of the
  exercise, and a cache one project's agents can write is a cache another
  project's agents should not read. The cost is real and accepted - version-pinned
  artifacts like the webfonts are byte-identical everywhere, so each project pays
  its own 19s build once instead of the machine paying it once. Somewhere like
  `<state-dir>/projects/<project-id>/agent-cache/`, kept clear of that project's
  `cache/`,
  which is already Hydra's own per-head scratch (849 gate-policy/mcp-catalog
  files) and not a user-facing cache.

  Still open: whether consumers get a `HYDRA_CACHE_DIR` contract rather than
  hardcoding a path (they should, so the location can move); and how to keep the
  `~/.cache` subdirectories that genuinely need shared writes. `ms-playwright` is
  the load-bearing one - the e2e runner's `playwright install` is a no-op only
  because the browser is already there, and a per-head CoW would re-download
  646MB. That argues for CoW taking a SUBSET rather than a whole directory:
  a config that says which parts of `~/.cache` stay shared and which are
  overlaid, instead of today's all-or-nothing entry.

  Needs testing on the host: bwrap will not nest, so a sandbox-policy change
  cannot be exercised from inside a head.

## Agent UX

- [ ] **Sweep slot sessions by owner, not by ID prefix.** `Registry.KillMatching`
  is a `strings.HasPrefix` sweep (`internal/session/registry.go:638`). The
  `heads.SlotSep` (`@`) scheme now makes `SlotPrefix(headID)` unambiguous, so this
  is no longer a correctness bug - but recording the owning head ID on the session
  and sweeping by field equality would retire the whole prefix-matching bug class
  rather than one instance of it. The registry already carries a per-session
  worktree label, so there is a natural home for it.

- [ ] **Go language server alongside sandboxed agents** so the agent can query LSP
  information (definitions, references, diagnostics) instead of only reading files.

- [ ] **`hydra attach <id> [command]`:** run an arbitrary command (e.g. `bash`) in
  the head's sandbox instead of attaching to the agent. If the head's session has
  stopped but its worktree/branch still exist, resume the agent first.

- [ ] **Transitional state on merge/kill.** When merging or killing a head, move it
  into a transitional state and return an HTTP status indicating work-in-progress,
  so the UI button stays disabled only until the operation completes.

- [ ] **Stream command stdout/stderr live** and prefix log lines (e.g.
  `[stdout]` / `[stderr]`), preserving interleaving instead of buffering and
  printing everything at once.

- [ ] **Server-side comments, notified by id.** Today a review comment is
  `localStorage` only (`web/src/lib/reviewDrafts.ts` - dies on reload, never
  leaves the browser it was typed in) and "Comment to agent" formats it plus a
  diff context block into the transcript (`buildReviewMessage`), where it cannot
  be re-read, re-anchored, or survive a compaction. Proposed in
  [review-agent.md](review-agent.md): one append-only server-side store with a
  `draft`/`published` status (drafts sync but are invisible to agents), anchors
  (`commit, path, line-range, hunk_hash`), threads that exist without a forge
  parent (`mergeLocalNotes` must stop dropping orphans), `get_review_comments` /
  `add_review_comment` tools alongside the already-built
  `reply_to_review_comment` -> `reviewq.OpNote`, and agents notified with
  `Comments added: #4 (path:line)` instead of injected text - constant-size, and
  an id stays resolvable after the transcript scrolls away. Ids: per-head
  sequential `#N` (one token, human-speakable, safe because every write is
  daemon-mediated), not a bare UUID. Read + append only; published comments are
  never edited. Numbers cover forge comments too, assigned on first sight via an
  append-only `(origin, external_id) -> #N` map and never reused - but Hydra owns
  the *numbering*, not the content: forge comments stay live-fetched, because
  people comment/edit/delete on the forge directly and a local copy claiming to
  be authoritative would need endless reconciliation.

  The review slot that was meant to feed this is now BUILT
  ([review-agent.md](review-agent.md)), so it currently has nowhere to put a
  finding - it can only talk. That makes this the next piece, not a nice-to-have.

- [ ] **Finish the review slot's open ends** ([review-agent.md](review-agent.md)):
  exercise it against a live head (it has never launched a real Claude in a real
  checkout - the simulation server does not spawn sandboxes), a status dot on the
  Review tab, syncing the checkout forward as the head commits
  (`EnsureReviewCheckout` takes a ref, but nothing calls it between turns, so a
  long-lived reviewer keeps looking at the commit it started on), and lens-named
  extra slots (`<head>@review-security` - the naming leaves room, nothing creates
  them).

## Diff viewer

- [ ] **Auto-load diffs for short changes (< 1000 lines)** via the diff-files
  endpoint instead of defaulting to "No changes loaded" - currently each file must
  be loaded manually.

- [ ] **Diff-viewer selector logic.** Let the left selector pick "Latest commit"
  when the right is on "Latest changes" (and auto-select this combo when the
  uncommitted-changes button is pressed); order the left selector with the latest
  commit at the top and `main` at the bottom; forbid selecting a left state
  at/after the right (and a right state at/before the left).

- [ ] **Fix the uncommitted-changes button breaking the diff-header layout** - it
  adds a new line that splits the left buttons from the settings button (likely the
  tooltip).

- [ ] **Make the expand-lines buttons work in demo mode** (may need a new API
  endpoint).

- [ ] **Fix diff-viewer comments:** the add-comment button is half-clipped
  (overflow / z-index), the comment dialog flickers in and out, and Ctrl/Cmd+Enter
  doesn't submit. Render the comment inline by splitting the diff (GitLab-style) so
  the diff and the comment box are visible at the same time.

- [ ] **Image diffs between branches.** Use the artifacts image diff viewer code to
  also let the user diff regular image files between branches.

## Artifacts

- [ ] **Render ANSI in artifact logs/errors in colour** instead of stripping it.
  Artifact generation output (the error box + the live/persisted build-log panes in
  `web/src/components/ArtifactsPanel.tsx`) is raw terminal output that carries ANSI
  SGR escape sequences (e.g. Playwright's dim `ESC[2m ... ESC[22m`). Right now
  `web/src/lib/ansi.ts` `stripAnsi` removes them so the text reads cleanly. Replace
  this with a proper renderer that maps SGR codes to spans/styles (colour, bold,
  dim, underline) - likely a small parser or a lib like `ansi-to-html`/`anser` - so
  the logs show the original colouring. The stderr-in-red distinction in `LogView`
  is currently a per-line stream flag, not from ANSI; reconcile the two when
  rendering.

## Web

- [ ] **Tabs inside the inspector pane, and head-level events as chat rows.** The
  inspector is five mutually-exclusive things stacked in one scroll (Changes bar,
  Tests, Previews, Artifacts, Files+diffs), which is what the sticky-header
  co-ordination machinery (`--sticky-changes-h` / `--sticky-section-h` /
  `STICKY_CARD_TOP` / the hard-coded `max-h-[calc(100vh-140px)]`) exists to
  survive - tabs would simplify it away, give each section the full pane height,
  and create the page's first addressable sub-view state (`?tab=`, later
  `?file=` / `?thread=`). Separately, head-level events (status transitions, test
  verdict changes, publishes, merges) are ephemeral today - `AgentTransitionRow`
  lives inside a toast and is lost if you were not looking - and should become
  `ChatItem` rows in the transcript alongside the existing `commit` chips, rather
  than a separate Activity feed. Argued in
  [agent-page-tabs.md](agent-page-tabs.md), which also explains why chat and diff
  should *not* be tabbed apart on a live head.

- [ ] **Async markdown renderer so fenced code blocks pick up on-demand syntax
  highlighting.** The syntax-highlighting refactor split Prism (via refractor)
  into a small eager set (~47 common languages, `web/src/lib/prism.ts`) plus ~250
  grammars loaded on demand (`web/src/lib/prismLazy.ts` `ensureLanguage` +
  generated `prismLazyRegistry.ts`). The three *code* surfaces were wired to lazy-load a
  missing grammar and re-highlight once it lands: the diff worker
  (`highlight.worker.ts`, async already), the diff small-file fast path
  (`DiffViewer.tsx`), and the repo file viewer (`RepositoryView.tsx` `CodeView`).
  **Markdown code fences were deliberately left on the eager set** - a fenced block
  in a language outside the eager ~47 (e.g. ` ```ocaml `/` ```clojure `) renders as
  plain text instead of highlighted. The reason: `renderMarkdown`
  (`web/src/lib/markdown.tsx`, and the parallel inline renderer in
  `RepositoryView.tsx`) is a **synchronous, pure `string -> ReactNode` function**
  that calls `prism.hasLanguage(lang)` and skips highlighting when the grammar isn't
  registered; it has no way to `await ensureLanguage(lang)` and re-render, and it's
  consumed in many places (`AgentDetail`, `RepositoryView`, `settings/ConfigForm`).
  Fix: give markdown the same lazy-load-then-re-highlight treatment the code
  surfaces got - e.g. have `renderMarkdown` collect the set of fence languages it
  saw and expose it, and a thin wrapper component (or hook) call `ensureLanguage`
  for each unregistered one and bump a nonce to re-render; or move markdown
  rendering into a small component that memoizes on `[text, grammarsReady]`. Keep
  it a pure function for the callers that just want a one-shot string. Low priority
  / cosmetic: only affects exotic languages in agent-authored markdown; common
  fence languages (bash, json, ts, js, go, python, yaml, diff, ...) are already
  eager.

## Git

- [ ] **Interactive credential prompts for daemon-side git - revisit the blanket
  `GIT_TERMINAL_PROMPT=0`.** Daemon-side pushes/fetches (`internal/git/push.go`,
  and the publish flow in [publish](../internal/http/publish.go)) run strictly
  non-interactively: `GIT_TERMINAL_PROMPT=0` + `GIT_SSH_COMMAND="ssh
  -oBatchMode=yes"`, mapping auth failures to an actionable UI error ("add your key
  to ssh-agent, or switch to HTTPS + a credential helper"). That is the safe
  default, but it means a fixable prompt (HTTPS password, ssh key passphrase after
  reboot) is a hard failure. Follow-up: forward the prompt to the user instead -
  git supports this cleanly via `GIT_ASKPASS`/`core.askPass`, ssh via `SSH_ASKPASS`
  (+ `SSH_ASKPASS_REQUIRE=force`; needs the process detached from a tty, e.g.
  setsid): point both at a small `hydra __askpass` helper that relays the prompt
  text over the daemon socket to the web UI as a modal (same parked-approval UX as
  the security gate) and writes the answer to stdout. Design constraints: the
  secret is never logged, never persisted by Hydra (at most offered onward to `git
  credential approve` on explicit opt-in); timeout/cancel fails the push cleanly
  with the current actionable error as fallback; ssh-agent remains the
  *recommended* path for passphrase keys - the modal is a rescue hatch, not the
  story.

## Notifications

- [ ] **Action buttons on the OS notifications (Allow / Always allow / Deny inline;
  open-from-closed-tab).** The out-of-tab desktop notifications
  (`web/src/lib/notifyPrefs.ts` `fireNotification`) are fired via the
  non-persistent `new Notification(...)` constructor, which **ignores the `actions`
  field entirely** - so they are click-the-whole-thing-to-open only. The
  security-gate approval notifications in particular would benefit from inline
  **Allow once / Always allow / Deny** buttons, since they already carry a `reqid`
  + a decide endpoint (`decideAgentApproval`, wired in `useAgentNotifications.ts`).
  Buttons require the *persistent* path:
  **`ServiceWorkerRegistration.showNotification(title, { actions: [...] })`**, whose
  clicks arrive as a `notificationclick` event (with `event.action`) **inside a
  service worker**, not on the page. Hydra deliberately has no service worker today
  (`notifyPrefs.ts:8-9` scopes it out). Scope: (1) register a minimal SW and switch
  firing to `registration.showNotification` with an `actions` array; (2) handle
  `notificationclick` in the SW - either `fetch` the decide endpoint directly from
  the SW (it can carry the ALLOW/DENY + remember decision) or `postMessage` an open
  client so the existing `decide()` runs; (3) map the retraction work
  (`dismissNotification` on state-clear + `autoDismissMs`) onto the SW
  notifications too. Constraints / gotchas: `actions` are capped at ~2 buttons on
  most platforms and are **unsupported on Firefox/Safari desktop** (they silently
  drop to no buttons - the whole-notification click must stay a working fallback);
  a decide-from-SW path must handle the tab being fully closed. Bonus: a service
  worker also unlocks notifications for a **fully closed** tab via Web Push, though
  that is a larger follow-on (push subscription + a daemon-side push sender) and can
  be deferred. Start with the approval notifications (clearest button semantics);
  the needs_input / finished ones can stay click-to-open.

## Chat mode

- [ ] **Desktop apps with full Hydra and focused direct-directory chat windows.**
  Ship one `Hydra.app` with one shared local backend and two window types: the
  existing full interface and a clean structured-chat window. Focused chats run
  directly in a registered project's real root, support enforced Edit/Read-only
  mode plus an independent guarded-commit toggle, persist in Hydra history, and
  remain openable from full Hydra. A chat never changes directory: switching
  project stops or backgrounds the current agent and creates a new chat.

  Reuse the existing `Head` model without a stored kind. The invariant is
  `Branch == nil` means focused, while `Worktree == nil` only means there is no
  live Hydra checkout and can also describe an archived or degraded normal head.
  Archived normal heads retain their historical branch name; archived focused
  heads remain branchless, so `Archived` plus `IsFocused()` distinguishes both.
  Do not put a derived, nonexistent worktree path on archived heads: callers use
  non-nil `Worktree` as evidence that the checkout can be read or operated on.
  The shared branchless lifecycle, permission API, guarded commit path, full-Hydra
  spawn option, and chat-only React layout are built. This is the common base for
  macOS, Windows, and Linux app branches. Initial native shells now exist for
  AppKit/WKWebView, Windows Forms/WebView2, and GTK/WebKitGTK. The macOS and
  Windows shells include shared-server launch handshakes and multi-window
  foundations; the Linux shell includes user-global daemon discovery and
  launch. All still need their respective native validation, notifications,
  and release packaging. The shared dedicated focused route and first-message
  creation flow are built; project/history switching and the native lifecycle
  bridge remain.
  See [macos-desktop-chat.md](macos-desktop-chat.md),
  [windows-desktop-chat.md](windows-desktop-chat.md), and
  [linux-desktop.md](linux-desktop.md) for the platform sequences. Each app also
  depends on closing its security-critical platform gaps in
  [macos-support.md](macos-support.md) or [windows-support.md](windows-support.md),
  or validating the packaged Linux sandbox described by the Linux plan. Linux
  now has native menus and safe-close prompts, native notifications with exact
  conversation routing, GTK folder selection, constrained deep links, JSON
  diagnostics, and a `mage buildDesktopDeb` preview target. The remaining Linux
  work is real GNOME/KDE, Wayland/X11, IME, accessibility, multi-monitor,
  notification activation, install/upgrade/removal, and packaged-sandbox test
  coverage.

- [ ] **Mic / voice input.** Dictation button in the composer like the Claude app.

## Deployment

- [x] **One build flavour: minified + source maps, gzipped on the way out.**
  Done. `minify` and `sourcemap` were both derived from `mode === 'development'`,
  which made "production" and "debuggable" look mutually exclusive. Measured:
  today's unminified bundle was 7.3 MB of JS on the wire; it is 3.9 MB minified
  and 121 KB after gzip. `HYDRA_DEV_BUILD`, its five `os.Setenv` calls and the
  dual build stamp are gone with it - along with the trap where heads inherited
  `HYDRA_DEV_BUILD=1` and silently built dev bundles. Compression is a runtime
  middleware (`internal/http/compress.go`) rather than build-time
  precompression, so API responses benefit too. Build-time precompression would
  additionally shrink the binary by ~12 MB - still open, if that matters.

- [x] **The installed service updates itself, restarting via `syscall.Exec`.**
  Done. `POST /api/server/update` builds while still serving, streams the log to
  a toast, verifies the new binary starts, swaps it atomically and re-execs. A
  failed build changes nothing. Re-execing keeps the PID, so no supervisor is
  involved and the web listener is carried across (the port is never unbound).
  `Dev`, `DevExpose`, `Prod`, `Preview`, `DevAutoReload` and `devServerLoop` are
  deleted - eight ways to start Hydra down to three. See
  [deployment.md](deployment.md).

- [ ] **Restart without killing every running head.** Spiked, deliberately not
  built. A PTY master crosses `syscall.Exec` fine - the same trick the web
  listener already uses - but *only* with the parent-death signal dropped: with
  `Pdeathsig` set, as every sandbox has it via `internal/scope.StartFunc`, the
  exec SIGKILLs the child even though the process never died, because Linux keys
  `PR_SET_PDEATHSIG` to the parent THREAD and `exec` kills every thread but the
  caller. (It depends on which thread forked - forking and exec'ing on one thread
  lets the child survive and gives a false green light.) So the cheap route
  trades away the guarantee that a *crashed* daemon cannot orphan a sandbox,
  leaving `SweepOrphanScopes`-at-next-boot as the only backstop; it would also
  need that sweep taught to skip the units it just adopted. Splitting the PTY
  owner into a supervisor that never restarts buys the same thing without the
  trade. Until then a restart stops running heads, they resume with `--continue`,
  and the UI confirms first. See [deployment.md](deployment.md).

- [ ] **Add first-class named Hydra instances**, if wanted. Explicit
  `HYDRA_STATE_DIR` instances already isolate their database, project trees,
  daemon runtime, and transient scope prefix by the resolved state path. A named
  installed instance would still need to namespace `uuid.txt`, the shared
  `~/.local/share/hydra/logs/hydra.log`, and its systemd service as
  `hydra@<instance>.service`. See [deployment.md](deployment.md) for why one
  installed instance is probably right. Simulation mode (`mage demo`) is already
  fully isolated and covers most frontend work.
