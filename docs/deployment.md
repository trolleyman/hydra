# Deploying Hydra: a self-updating local service

Status: **proposed, unbuilt** (audit + plan). Pieces that already exist are marked
BUILT inline.

The end state: **one installed service that rebuilds itself on demand.** You press
a button, it compiles in the background while still serving, streams the build log
into a toast, and only swaps the binary and restarts if the build succeeded. Dev
and prod stop being different things - there is one server, built one way
(minified *with* source maps, precompressed), and the restart button *is* the
deploy. `mage dev` and its four cousins go away.

## What this is, and isn't

This is not a deployment in the classic sense - the machine keeps the source
checkout and the toolchain, and the server compiles itself. For a single-user
tool you are actively building, that is the right shape. The safety property you
actually want is preserved and is worth naming: **the installed binary is a
snapshot, and the button is an explicit "adopt current source".** A broken working
tree cannot take the server down until you ask it to, and a failed build cannot
take it down at all.

## The build flavour question, measured

`minify` and `sourcemap` are independent Vite options that `web/vite.config.ts`
derives from a single flag (`:106`, `:109`), which makes "production" and
"debuggable" look mutually exclusive. They aren't. Measured on this tree:

| flavour | JS on the wire | maps | binary |
|---|---|---|---|
| unminified + maps (**what you run today**) | 7.3 MB | 13.0 MB | 53.9 MB |
| minified, no maps | 3.9 MB | - | 37.4 MB |
| minified + maps | 3.9 MB | 12.4 MB | 49.9 MB |
| **minified + maps + precompressed** | **1.3 MB** | 12.4 MB | **~37.9 MB** |

Reading it:

- **Maps cost the browser nothing.** DevTools fetches `.map` files only when it
  is open. Same 3.9 MB of JS either way.
- **The server does not compress today.** No gzip, no `Content-Encoding` anywhere
  in `internal/cli/server_frontend.go` or the HTTP middleware - so raw size *is*
  wire size, and today's unminified bundle really is ~5.6x the bytes of the end
  state on every cold load. Invisible on loopback, very visible over Tailscale
  from a phone.
- **Precompression pays for the source maps almost exactly.** Embedding
  compressible assets gzipped shrinks `dist` from 19.9 MB to 7.9 MB, landing the
  binary at ~37.9 MB - i.e. today's *no-maps* production binary, but with full
  maps, and 3x less traffic.

So the end state is strictly better than today on every axis: 5.6x less JS on the
wire, 16 MB smaller binary, and original-source stack traces.

### Notes on doing the compression

- **Precompress at build time, don't gzip per request.** Assets are immutable and
  content-hashed, so compressing once at build time is free at runtime and lets
  you use `gzip -9`. Embed *only* the `.gz` for compressible types and decompress
  on the fly for the rare client that doesn't send `Accept-Encoding: gzip` (every
  browser does; `curl` doesn't). That is what makes the binary shrink rather than
  grow.
- Skip the already-compressed types (`.png`, `.woff2`) - they are most of what is
  left and gzip does nothing for them.
- Don't reach for `http.ServeContent` on a precompressed asset; set
  `Content-Encoding`, the `Content-Type` of the *original* extension, and
  `Content-Length` of the compressed bytes, and skip range support. Ranges on a
  content-encoded representation are a footgun and nothing here needs them.
- **API responses are a separate, also-worthwhile win.** Diff payloads are large
  and are not static, so they want a normal streaming gzip middleware rather than
  precompression. Worth doing, but independent of the above.

## Yes, `HYDRA_DEV_BUILD` can go

`isDev` is used in exactly two places in `web/vite.config.ts` (`:106` minify,
`:109` sourcemap). Once both are constants, `isDev` and the `mode` check at `:56`
are dead, and with them:

- `HYDRA_DEV_BUILD` itself, and the five `os.Setenv` calls that set it
  (`magefile.go:1304,1318,1373,1460,1642`);
- the dual build stamp - `.mage/web-build.stamp` and `.mage/web-build-dev.stamp`
  collapse to one (`BuildWeb`, `:1161-1166`);
- the `NODE_ENV=development` / `--mode development` branch (`:1194-1198`).

This also deletes a live trap rather than just simplifying: heads currently
inherit `HYDRA_DEV_BUILD=1` and `HYDRA_DEV_RESTART=1` from the `mage dev` process
that started the daemon (verified with `printenv` inside a head), so any
`mage build` an agent runs silently produces a development frontend - and a
`mage deploy:service` from such a shell would install a dev bundle as prod. With
one build flavour there is nothing to get wrong.

`mage devFast` / `mage demo` are unaffected: they run the Vite *dev server*,
which is a different code path and stays unminified with HMR, as it should.

## And most of the magefile's run-loops

There are currently eight ways to start Hydra: `Run`, `Dev`, `DevExpose`,
`DevFast`, `DevAutoReload`, `Preview`, `Demo`, `Prod`. Once the server updates
itself, most are duplicates of each other:

| target | fate |
|---|---|
| `Dev` (`:1302`) | **gone** - the installed service updates itself |
| `DevExpose` (`:1313`) | **gone** - `HYDRA_API_ADDR` on the service, auth key already enforced |
| `Prod` (`:1061`) | **gone** - `deploy:service` covers it |
| `Preview` (`:1572`) | **gone** - watch-rebuild-restart, superseded |
| `DevAutoReload` (`:1459`) | **gone** - overlaps `DevFast` |
| `DevFast` (`:1371`) | **keep** - Vite HMR is genuinely faster than any rebuild loop, and is a different mechanism, not a duplicate |
| `Demo` (`:1640`) | **keep** - simulation mode, fully isolated (see below) |
| `Run` (`:520`) | **keep** - foreground, for debugging the daemon itself |

Eight down to three, plus `devServerLoop` (`:1328`) and the whole exit-42 rebuild
dance in the magefile. That is the real simplification, and note it is downstream
of the in-app update, not of the sourcemap change.

(`mage demo` is worth keeping specifically because `runSimulationServer`
(`internal/cli/server.go:152`) returns *before* `setupRuntime` /
`serveUnixSocket` - it touches no daemon socket, DB, `projects.json`, or scope
sweep. It is the one genuinely isolated second instance, and it covers most
frontend work.)

## The update mechanism

### Flow

1. `POST /api/server/update` returns immediately; the daemon starts the build in
   a subprocess. **The old server keeps serving throughout.**
2. Build log streams to the client over a WebSocket, with phase events:
   `building` -> `verifying` -> `swapping` -> `restarting`.
3. On build failure: stop. Report the error in the toast. Nothing was touched,
   the server never went down. This is the whole safety argument.
4. On success, verify the new binary actually runs (`hydra --version`, or better
   a `hydra selfcheck` that boots the runtime against a temp root and exits).
5. `os.Rename` `hydra` -> `hydra.prev`, `hydra.new` -> `hydra`. Atomic on one
   filesystem. `go build -o` over a running binary does **not** `ETXTBSY` (the Go
   linker unlinks first - verified), and existing sandbox binds pin the old
   inode, so running heads keep the binary they started with.
6. Exit 42; systemd restarts into the new binary.

The daemon can do all of this itself - it is not sandboxed, it is the thing that
*spawns* sandboxes.

### API shape

Today it is one fire-and-forget call: `POST /api/dev/restart` ->
`Server.DevRestart` (`internal/http/handlers.go:1513`) -> `os.Exit(42)`, with the
client health-polling in `handleRestart` (`web/src/routes/__root.tsx:577`). That
splits into:

- `POST /api/server/restart` - restart only, no build. What prod wanted all along.
- `POST /api/server/update` - build, verify, swap, restart.
- `WS /ws/server/update` - the log + phase stream.

Two details worth getting right:

- **The stream dies on purpose.** The server that is streaming is the one about
  to exit, so the client must treat "socket closed after the `restarting` phase"
  as success, not as an error. The existing `/health` poll-then-reload loop
  (`__root.tsx:598-610`) already handles the rest and needs no change.
- **Write the log to a file too**, under the existing build-log dir
  (`paths.GetBuildLogDirFromProjectRoot`, `internal/paths/paths.go:237`), so it
  survives the restart and the toast can show the completed log after the reload
  rather than losing it mid-stream.

### The toast

Good idea, and there is precedent - the tests panel and the artifacts "Show build
log" already stream logs into the UI, and `handleRestart` already puts up a
persistent (`duration: 0`) toast. An expandable toast showing the tail of the
build log, with the phase as the title, is a small extension of things that exist.

## The hard part: "hot swap" without killing your agents

This is the one place the vision meets real resistance, and it is worth
separating two things that "hot swap" runs together:

1. **Rebuilding without downtime** - trivial, and covered above. The build
   happens while the old server serves; only a *successful* build causes any
   interruption.
2. **Swapping without killing running heads** - hard.

Today a restart kills every live head. Two mechanisms do it: bwrap runs with
`--die-with-parent` (`internal/sandbox/linux.go:181`), and the drain calls
`Registry.StopAll()` (`internal/session/registry.go:665`). Heads come back via
`--continue`, but an in-flight turn is lost.

Note the cgroup side is *already* fine: workloads run in transient systemd scopes
(`hydra-*.scope`), which outlive the process that created them. What binds a head
to the daemon is only `PR_SET_PDEATHSIG` and the fact that the PTY master fd
lives in the daemon's memory - close it and the agent gets `SIGHUP`.

Three routes:

- **(a) `syscall.Exec` self-replace.** Same PID, so the process never dies, and
  non-`CLOEXEC` fds survive `exec` - so the PTY masters can be handed to the new
  image by passing their fd numbers plus metadata in argv/env. This is the
  classic graceful-restart trick and fits Hydra's shape best. **Two caveats, and
  the first needs a spike before committing to this route:** `exec` terminates
  every thread but the caller, and Linux's parent-death signal is keyed to the
  parent *thread*, not the process - so if the thread that forked bwrap is not
  the one calling `exec`, `--die-with-parent` fires anyway. The fix is to drop
  `--die-with-parent` and lean on scope-based reaping, which
  `SweepOrphanScopes` already does. Second: scrollback rings are in memory and
  would need passing through a temp file, or accepting their loss.
- **(b) Split the process** - a small supervisor owning PTYs, plus a web/API
  server that restarts freely. Cleanest long-term, largest change.
- **(c) A per-head shim** owning the PTY, so nothing the daemon does matters.
  Medium-large.

**(a) is probably the answer**, and it has a pleasing side effect: it makes the
dev and prod restart paths genuinely identical, which is the simplification you
were after. But it is a spike first, not a plan yet.

## Audit: what else is missing

- **`Development` is a boolean meaning "mage will rebuild me"**
  (`internal/cli/runtime.go:249`), so the restart button only renders under the
  mage loop. Needs to become a mode (`off` / `restart` / `update`).
- **The systemd unit does not account for the button.** `RenderSystemdUnit`
  (`internal/service/systemd.go:52-53`) emits `Restart=on-failure` /
  `RestartSec=2`. Exit 42 is non-zero so it does restart, but it counts against
  systemd's default rate limit (5 starts / 10s), so a few quick presses land the
  unit in `failed`. Wants `RestartForceExitStatus=42`, `Restart=always`,
  `StartLimitBurst=10`, `StartLimitIntervalSec=60`.
- **The CLI auto-upgrade fights systemd.** `daemon.Connect` compares the invoking
  binary's stamp to the running daemon's (`internal/daemon/upgrade.go:19`, `:63`)
  and on a mismatch `StopDaemon`s it (`:84`, SIGTERM) then spawns a **detached**
  `hydra __daemon`. Against a service-managed daemon that is wrong either way.
  Detection is free - systemd sets `INVOCATION_ID` - so `WriteDaemonFiles`
  (`:32`) can stamp `managed=systemd` into the `.info` file and `isStale` can
  skip the takeover.
- **`Deploy.Service` never enables linger**, so the unit dies at logout unless
  the user runs the printed `loginctl enable-linger`.

## Plan

**Phase A - build flavour (small).** `sourcemap: true`, drop `isDev` /
`HYDRA_DEV_BUILD` / the dual stamp, add build-time precompression + the static
asset handler change. Independently valuable, no behaviour risk.

**Phase B - self-update (small/medium).** The update endpoint, the log stream,
the toast, verify-then-swap, the systemd unit flags, `Development` as a mode,
`INVOCATION_ID` detection, linger. Then delete `Dev`, `DevExpose`, `Prod`,
`Preview`, `DevAutoReload` and `devServerLoop`. This is where the magefile
collapses. Restart still kills heads, so it needs a confirmation showing the live
count.

**Phase C - restart without killing heads (medium, spike first).** Route (a)
above. Removes the confirmation from Phase B and makes "hot swap" literally true.

A and B are worth doing regardless. C is the one to prototype before planning.

## Decisions and rejected alternatives

- **Source maps in prod, minified and precompressed.** Reversing the first draft
  of this doc, which cut maps from prod on binary-size grounds - precompression
  more than pays for them. One caveat: maps hand out original source to anyone
  who can load the UI. Fine for loopback/Tailscale of your own code; reconsider
  before a public ngrok Funnel.
- **One instance, not two.** Untying minify from sourcemap removes the
  debuggability argument, and `SweepOrphanScopes`
  (`internal/sandbox/scope_linux.go:160`) is global - it reaps *all*
  `hydra-*.scope` units at daemon boot, so a second instance would kill the
  first's live sandboxes. If instances are ever revived they need a per-instance
  scope prefix, plus namespacing for `~/.config/hydra/projects.json`, `uuid.txt`,
  the shared `~/.local/share/hydra/logs/hydra.log`, the daemon runtime key, and a
  templated `hydra@<instance>.service`.
- **Update builds from the project root's working tree**, not from a fetched
  release. That is the point - it is a self-updating local service. The UI should
  show the commit it is about to build so it is never a surprise.
- **Verify before swapping, never after.** Rollback from a dead process is not
  something to rely on; `hydra.prev` is a manual escape hatch, not the mechanism.
- **No file watcher.** Auto-rebuilding a server that (pre-Phase C) kills every
  running head is not something to automate. `mage devFast` covers fast iteration.
