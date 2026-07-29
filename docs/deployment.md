# Deploying Hydra: one instance or two?

Status: **proposed, unbuilt** (audit + plan). Pieces that already exist are marked
BUILT inline.

Short version: **one instance, built minified *with* source maps, is almost
certainly what you want.** Minification and source maps are independent Vite
options that Hydra happens to have tied together; untying them removes the whole
reason to run a second instance for debuggability. Two instances buy exactly one
thing - somewhere to test a change without restarting the server your agents are
running on - and cost more than they look like they do.

## Background: what actually runs today

The day-to-day Hydra on this machine is `mage dev`, which matters because it
explains everything below:

- `Dev()` (`magefiles/magefile.go:1302`) sets `HYDRA_DEV_BUILD=1` and enters
  `devServerLoop` (`:1328`), building `.mage/hydra` from the **working tree** and
  running it in the foreground.
- `HYDRA_DEV_BUILD=1` makes `BuildWeb` (`:1161`, flag read at `:1163`) run Vite
  with `--mode development`, which turns minification off and source maps on
  (`web/vite.config.ts:106,109`).
- The UI restart button (`web/src/routes/__root.tsx:577` `handleRestart`) calls
  `POST /api/dev/restart` -> `Server.DevRestart` (`internal/http/handlers.go:1513`)
  -> `os.Exit(42)` (`devRestartExitCode`, `:56`). `devServerLoop` catches 42,
  **rebuilds**, and starts the new binary. The button renders only when the
  server reports `development: true`, i.e. `HYDRA_DEV_RESTART=1`
  (`internal/cli/runtime.go:249`).

So a development loop is being used as a production server: it dies with the
terminal, serves an unminified bundle, and its binary tracks the working tree.

`mage deploy:service` (`magefiles/magefile.go:921`, BUILT) already builds a
production binary to `~/.local/bin/hydra` and writes a `systemd --user` unit via
`service.RenderSystemdUnit` (`internal/service/systemd.go:31`). It is not
installed on this machine.

## The build flavour question, measured

`minify` and `sourcemap` are independent Vite options. `vite.config.ts` currently
derives both from one flag, which makes "production" and "debuggable" look like
opposites. They aren't. Measured on this tree (Hydra's own frontend):

| flavour | JS served | maps | JS gzipped | binary |
|---|---|---|---|---|
| minified, no maps (`mage build`) | 3.9 MB | - | 1.1 MB | 37.4 MB |
| unminified + maps (**what you run today**) | 7.3 MB | 13.0 MB | 1.5 MB | 53.9 MB |
| **minified + maps** (recommended) | 3.9 MB | 12.4 MB | 1.1 MB | 49.9 MB |

The things to read off it:

- **Minified + maps costs the browser nothing over minified alone.** Identical
  3.9 MB of JS; DevTools fetches the `.map` files only when it is open. Full
  original-source debugging, zero cost when you are not debugging.
- **The server does not compress** (no gzip / `Content-Encoding` anywhere in
  `internal/cli/server_frontend.go` or the HTTP middleware), so raw size *is*
  wire size. Today's unminified bundle really is ~1.9x the bytes on every cold
  load - noticeable over Tailscale from a phone, invisible on loopback.
- **The only real cost of maps is binary size**: +12.5 MB, because `web/dist` is
  embedded with `//go:embed all:dist` (`web/embed.go`). Still smaller than the
  53.9 MB binary you are running today.

So the choice the question assumed - "prod means giving up debuggability" - isn't
a real choice. Take both.

## Requirements

**Deploying properly means:**

1. Survives the terminal closing, logout, and reboot.
2. Restarts itself on a crash.
3. Runs a **fixed artifact**, not a live checkout - a half-finished edit must not
   be able to take down the server you work on.
4. Logs land in the journal, not a scrollback buffer.
5. A deliberate, unchanging network posture.

**"Still restart it to refresh changes" means:**

6. A one-click way to get merged changes into the running server.
7. That path must never leave you with a dead server.

3 and 6 conflict only if you conflate two operations. They separate cleanly:

- **Restart** = re-exec the artifact on disk. No toolchain, no build, cannot fail
  to produce a binary.
- **Update** = build a new artifact, prove it starts, swap atomically, restart.
  Can fail - and when it does, nothing has changed yet.

**One requirement that falls out of the code, not the ask:**

8. **Restarting is expensive.** bwrap runs with `--die-with-parent`
   (`internal/sandbox/linux.go:181`) and the drain calls `Registry.StopAll()`
   (`internal/session/registry.go:665`). A restart kills **every running head**;
   they return via `--continue`, but an in-flight turn is lost. So restart is a
   deliberate act, gated on a confirmation, never wired to a file watcher.

Requirement 8 is the *only* argument for a second instance, and it is worth
sizing honestly before paying for it.

## Do you want two instances?

### What they buy

One thing: somewhere to exercise a Hydra change without restarting the server
running your agents (requirement 8). That is real, but note you already tolerate
the alternative - today every test of a backend change restarts `mage dev` and
kills whatever was running.

Not debuggability - the table above covers that with one instance.

### What they cost

Beyond the isolation plumbing (below), there is a collision that makes a naive
second instance **actively destructive**, not merely untidy:

- **`SweepOrphanScopes()` (`internal/sandbox/scope_linux.go:160`) is global.** It
  runs at every daemon boot, lists *all* `hydra-*.scope` systemd units, and kills
  them on the reasoning that "we own no live sessions yet, so every one is
  stale". Boot a second instance and it reaps the **first instance's live agent
  sandboxes**. Fixing this needs a per-instance scope prefix, not just a config
  path split.
- **User-global state is shared**: `~/.config/hydra/projects.json`
  (`internal/projects/projects.go:70,78`), `uuid.txt` (`:20`), and the single
  `~/.local/share/hydra/logs/hydra.log` (`internal/cli/root.go:66`). Both
  instances would see - and `resumeHeadsOnBoot` would act on - the same projects.
- **The systemd unit name is hardcoded** `hydra.service`, so only one installs.
- Ongoing human cost: two project lists, two port blocks, and the standing
  discipline that they never manage the same project (same worktrees dir, same
  `hydra/<id>` branch namespace, two daemons resuming the same heads).

### What you already have instead

- **Simulation mode is fully isolated, today.** `runSimulationServer`
  (`internal/cli/server.go:152`) returns *before* `setupRuntime` /
  `serveUnixSocket`, so it touches no daemon socket, no DB, no `projects.json`,
  and never calls `SweepOrphanScopes`. `mage demo` is a genuinely safe second
  instance right now - mock data only, but that covers most frontend work.
- `mage devFast` gives Vite HMR against a real backend, but that backend is a
  real daemon and carries every collision above.

### Verdict

**One instance.** The debuggability argument dissolves once minify and sourcemap
are untied, and the remaining argument (restart kills my heads) is better
answered by fixing restarts than by running a second server. Revisit two
instances only if that actually starts to hurt.

## Audit: what's missing for a single deployed instance

- **`Development` is a boolean tied to the rebuild loop.** The restart button
  only appears when `HYDRA_DEV_RESTART=1`, which today means "mage will rebuild
  me". A deployed server wants the button with *restart-only* semantics, so this
  needs to become a mode.
- **The unit's restart semantics don't cover the button.**
  `RenderSystemdUnit` emits `Restart=on-failure` / `RestartSec=2`
  (`internal/service/systemd.go:52-53`). Exit 42 is non-zero so it does restart,
  but it counts against systemd's default start rate limit (5 starts / 10s), so a
  few quick clicks land the unit in `failed`. No `RestartForceExitStatus`, no
  `StartLimit*` tuning.
- **The CLI auto-upgrade fights systemd.** `daemon.Connect` compares the invoking
  binary's stamp against the running daemon's (`internal/daemon/upgrade.go:19`
  `binaryStamp`, `:63` `isStale`) and, on a mismatch, calls `StopDaemon` (`:84`,
  SIGTERM) then `EnsureRunning` to spawn a **detached** `hydra __daemon`. Against
  a service-managed daemon that is wrong either way: with `Restart=on-failure`
  the SIGTERM exits 0, the unit goes inactive, and an unmanaged daemon is now
  running; with `Restart=always` systemd restarts and two daemons race for the
  socket.
- **`Deploy.Service` never enables linger**, so the unit dies at logout unless
  the user runs the printed `loginctl enable-linger`.
- **`HYDRA_DEV_BUILD` leaks into every head.** A head spawned by a `mage dev`
  daemon inherits `HYDRA_DEV_BUILD=1` and `HYDRA_DEV_RESTART=1` in its sandbox
  environment (verified with `printenv` inside a head), so any `mage build` an
  agent runs silently produces a *development* frontend. Harmless while the
  server is itself a dev build; a real trap once `mage deploy:service` is run
  from a shell that inherited it, because it would install a dev bundle as prod.

## Plan

### Phase 0: untie minify from sourcemap

`web/vite.config.ts` - keep `minify: isDev ? false : 'esbuild'`, change
`sourcemap: isDev` to `sourcemap: true`. One line, and it is most of the value in
this doc. Costs +12.5 MB of binary; buys original-source stack traces in the
server you actually run.

(`sourcemap: 'hidden'` - maps emitted, no `//# sourceMappingURL` comment - is the
stricter production spelling, but it means DevTools won't pick them up
automatically, which defeats the point for a single-user tool. Plain `true`.)

### Phase 1: split restart from update

- Turn `Server.Development bool` into a mode: `off` / `restart` / `rebuild`, from
  `HYDRA_DEV_RESTART` (`1` stays `rebuild`; `restart` is what the unit sets). The
  button renders for both, with wording following the mode ("Restart the server"
  vs "Rebuild and restart the server").
- `RenderSystemdUnit`: add `RestartForceExitStatus=42`, `Restart=always`, and
  relax the rate limit (`StartLimitBurst=10`, `StartLimitIntervalSec=60`). The
  existing `/health` poll in `handleRestart` (`__root.tsx:598-610`) needs no
  change.
- **Confirm before restarting when heads are live**, showing the count and saying
  plainly that in-flight turns are lost (requirement 8).

### Phase 2: `Deploy.Service` polish

- Offer to run `loginctl enable-linger` rather than only printing it.
- Stamp `managed=systemd` into the daemon `.info` file (`WriteDaemonFiles`,
  `internal/daemon/upgrade.go:32`) - systemd sets `INVOCATION_ID` in the service
  environment, so detection is free. `isStale` then skips the
  SIGTERM-and-respawn takeover and tells the user to `systemctl --user restart`.
- Strip `HYDRA_DEV_BUILD` / `HYDRA_DEV_RESTART` from the environment the target
  builds in, so a deploy from a `mage dev` shell can't ship a dev bundle.

### Phase 3 (optional): update-and-restart

The daemon is not sandboxed - it is what spawns sandboxes - so it can run the
toolchain itself: build to `~/.local/bin/hydra.new`, smoke-test it
(`hydra --version`, or a `selfcheck` that boots the runtime against a temp root),
`os.Rename` `hydra`->`hydra.prev` and `hydra.new`->`hydra`, then exit 42.
Verifying *before* the swap is what satisfies requirement 7. `go build -o` over a
running binary does **not** fail with `ETXTBSY` (the Go linker unlinks the output
first - verified), and existing sandbox binds pin the old inode, so running heads
keep the binary they started with.

Worth deferring: `mage deploy:service` plus a restart already does this manually,
with no new failure modes.

### Not planned: making restarts cheap

Detaching agent sessions from the daemon's lifetime would remove requirement 8
entirely - and with it the last argument for a second instance. It is a large
change to the session registry, `--die-with-parent`, and the scope reaper, so it
belongs in its own doc. Flagged here because it is the *right* fix for the
problem two instances were being considered for.

## Decisions and rejected alternatives

- **Source maps in prod, minified.** Reversing the earlier draft of this doc,
  which recommended no maps in prod on binary-size grounds. 12.5 MB on a 37 MB
  binary is a poor trade against never being able to read a stack trace from the
  server you actually use. The one caveat: maps hand out full original source to
  anyone who can load the UI. That is fine for a loopback/Tailscale deployment of
  your own code; reconsider before putting Hydra behind a public ngrok Funnel.
- **No second instance for now**, per the section above.
- **Prod restart does not rebuild.** Rebuilding needs Go, Node and a checkout at
  runtime, and a failed build during a restart leaves no server at all.
- **No file watcher on the deployed instance.** `mage preview` /
  `mage devAutoReload` exist for that and are dev tools; auto-restarting a server
  that kills every running head is not something to automate.
- **User-scope `config.toml` stays shared** even if instances ever land - it is
  documented as machine-wide, and splitting it would make a setting silently not
  apply.

## Rough sizing

- Phase 0: one line.
- Phase 1: small - `internal/http/handlers.go`, `internal/cli/runtime.go`,
  `internal/service/systemd.go`, one button in `__root.tsx`.
- Phase 2: small.
- Phase 3: medium, and optional.

If two instances are ever revived, add: an instance name (`HYDRA_INSTANCE`)
namespacing `projects.json` / `uuid.txt` / the log file / the daemon runtime key,
a per-instance `hydra-<instance>-*.scope` prefix so `SweepOrphanScopes` stops
reaping its neighbour, and a templated `hydra@<instance>.service` unit.
