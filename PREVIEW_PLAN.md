# Server previews ([[artifacts]] type = "server"): fix plan

Context: the demo preview 502s under `network.mode = "hard"`, and the preview UX
(multi-instance panel, immutable version choice) needs simplifying. Diagnosis and
direction agreed 2026-07-07.

## 1. Fix the 502 (hard-mode netns + false-positive readiness probe)

Root cause, two halves:

- The demo command binds loopback *inside* the pasta netns
  (`HYDRA_API_ADDR=localhost:$HYDRA_PREVIEW_PORT`). pasta's inbound `-t` forward
  delivers to the guest's assigned address, not guest loopback, so the forward
  lands on a closed port. The server is up but unreachable from the host.
- Readiness is a bare TCP dial of `127.0.0.1:childPort`
  (`internal/preview/spawn.go`, prober). Under hard mode *pasta itself* holds the
  host port, so the handshake always succeeds and the instance flips to
  `running` even though nothing inside answers. Proxied requests then die at the
  real connect and `httputil.ReverseProxy`'s default error handler returns the
  observed bodyless 502 (`Content-Length: 0`).

Fixes:

- [ ] `.hydra/config.toml`: demo command binds all interfaces -
      `HYDRA_API_ADDR=0.0.0.0:$HYDRA_PREVIEW_PORT` (safe: private netns).
- [ ] Probe with a real HTTP GET (any response counts as ready) instead of a bare
      dial, so pasta's accept can't false-positive.
- [ ] When the dial succeeds but requests keep getting refused under hard mode,
      append a log hint: "server must bind 0.0.0.0 under network mode hard".
- [ ] Export `HYDRA_PREVIEW_ADDR` (host included, mode-aware: `0.0.0.0:NNNN`
      under hard mode, `127.0.0.1:NNNN` otherwise) alongside
      `HYDRA_PREVIEW_PORT`, and document it in the generated `[[artifacts]]`
      config docs.

## 2. UI nits (`web/src/components/PreviewPanel.tsx`)

- [ ] "Start the preview server without opening a tab" -> "Start the server".
- [ ] Use the lucide `Play` icon instead of the circular arrow.
- [ ] Drop the "Build log" header above the log output.

## 3. One server per script, following the diff "to" selection

Today instances are keyed by `(project, script, version)` and the panel also
surfaces still-running instances for other versions (`Manager.Others`), so
several previews pile up. Collapse to **one visible server per script**, driven
by the diff's "to" selection (preview what you're looking at):

- [ ] Introduce a stable "slot" per script that owns the proxy port; keyed
      instances become an implementation detail behind it.
- [ ] Selection -> channel mapping: pinned commit -> that commit's checkout;
      "Latest commit" -> branch-tip channel (see 4); "Latest changes" ->
      worktree channel (see 5).
- [ ] Remove the `Others` listing from the panel.

## 4. "Latest commit": background build + hot-swap (not in-place checkout)

In-place `git checkout` under a running server only helps hot-reloading dev
servers; the flagship command is build-then-serve (`bun run build && go run ./
server`), where checkout really means checkout + restart = downtime on every
commit, with 1-15 min builds. Instead:

- [ ] When the tip moves, spawn the new SHA's instance in the background
      (commit-pinned instances and their checkouts already exist), keep proxying
      the old one, and flip the slot's proxy target when the new one is ready;
      reap the old instance after the swap. URL/port never changes.
- [ ] No config knob for now; revisit an `[[artifacts]]` option (checkout-in-
      place for HMR dev servers) only when a real project needs it.

## 5. "Latest changes": sync into an own checkout (later)

Today the server runs *directly in the head's live worktree*: the build races
with and pollutes the agent's workspace, yet still only reflects a spawn-time
snapshot. Plan (sequenced last - the mode is rarely used):

- [ ] Run the server in its own checkout of the worktree's current state.
- [ ] While (and only while) the server is running, poll `git status
      --porcelain` in the worktree every ~2s and mirror modified +
      untracked-but-not-ignored files (plus deletions) into the checkout
      (`--exclude-standard` semantics: new non-gitignored files sync, build junk
      does not).
- [ ] File sync only visibly updates HMR-style servers; for build-then-serve,
      show a "code changed since start - restart" affordance instead of
      pretending to be live. This stale-restart badge also covers the gap until
      sync lands.

## Suggested order

1. 502 fixes (config binding, HTTP probe, `HYDRA_PREVIEW_ADDR` + docs)
2. UI nits
3. Slot per script driven by the "to" selection
4. Tip-follow via background build + hot-swap
5. Worktree sync + stale badge
