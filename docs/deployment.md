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
6. **`syscall.Exec` the new binary** - not exit-42-and-let-systemd-restart. See
   below.

The daemon can do all of this itself - it is not sandboxed, it is the thing that
*spawns* sandboxes.

### Why `exec`, not exit 42

Re-execing in place is better than the exit-code protocol on every axis, and the
reasons are independent of the fd handoff in Phase C:

- **No supervisor dependency.** Restart behaves identically under systemd, under
  `mage run` in a terminal, or under nothing at all. That deletes the exit-code
  protocol, `RestartForceExitStatus=42`, and the `StartLimit*` tuning from the
  plan entirely.
- **systemd never notices.** `Type=simple` tracks MainPID, and `exec` preserves
  the PID - so pressing restart ten times cannot trip the start rate limit into
  `failed`, which was a real wart of the exit-42 design.
- **Zero downtime, if you keep the listener.** Extract the TCP listener's fd
  (`(*net.TCPListener).File()`), clear `CLOEXEC`, pass the number in the
  environment, and `net.FileListener` it on the other side. The port is then
  never unbound: new connections queue in the accept backlog instead of getting
  `ECONNREFUSED`. It also deletes `devServerLoop`'s
  `time.Sleep(1 * time.Second) // Give the OS time to release the port`.
- **It is the mechanism Phase C needs anyway**, so adopting it now means Phase C
  adds fds incrementally rather than replacing the restart path.

**Take `exec` in Phase B with no fd handoff at all.** Heads still die at that
point - PTY masters are `CLOEXEC`, and `exec` terminates every thread but the
caller so bwrap's parent-death signal fires regardless - so keep the explicit
`Registry.StopAll()` for determinism rather than letting them die from a race.
Phase C then adds fd inheritance and removes `StopAll` and `--die-with-parent`
together.

Details that will bite on day one:

- **Exec the installed path, not `/proc/self/exe`.** After the swap
  `/proc/self/exe` still resolves to the *old* inode (now `hydra.prev`, or
  unlinked), so you would faithfully re-exec the binary you just replaced.
- **Guard against SIGTERMing yourself.** `serveUnixSocket` calls
  `daemon.StopDaemon` on startup, which reads the pidfile and signals it if
  `/proc/<pid>/cmdline` contains `__daemon`
  (`internal/daemon/upgrade.go:84`, `pidIsHydraDaemon` `:132`). After an `exec`
  the pidfile holds *your own* PID and your cmdline still says `__daemon`, so the
  fresh image can kill itself. A `pid == os.Getpid()` skip fixes it and is
  correct regardless of this work.
- **Keep exit 42 as the fallback.** `syscall.Exec` only returns on failure
  (`ENOENT`, `EACCES`, `ENOEXEC`); on that path `os.Exit(42)` and let whatever
  supervisor exists pick it up.
- **Nothing deferred runs after `exec`** - no `srv.Shutdown`, no cleanup
  closures. Drain first. But do *not* `Shutdown` the listener you are trying to
  preserve, since that closes it; extract the fd first.
- **Close the DB before exec** so SQLite's WAL is flushed cleanly.
- Order: verify new binary -> drain -> close DB -> dup listener fd and clear
  `CLOEXEC` -> `exec`.

What you give up is close to nothing. The one thing the supervisor contributed
was "if the new binary crash-loops, give up and sit in `failed`" - and that still
works, because a crash after `exec` is an ordinary process exit and systemd's
restart policy still applies. Verify-before-swap was always the real protection.

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
  to re-exec, so the client must treat "socket closed after the `restarting`
  phase" as success, not as an error. The existing `/health` poll-then-reload
  loop (`__root.tsx:598-610`) already handles the rest and needs no change -
  though with the listener carried across the `exec`, connections queue rather
  than being refused, so the poll should settle on the first attempt.
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

- **(a) Carry the PTY fds across the `exec`.** Phase B already re-execs in place,
  and non-`CLOEXEC` fds survive `exec`, so the PTY masters can be handed to the
  new image by clearing `CLOEXEC` and passing their fd numbers plus metadata in
  the environment - exactly what Phase B does for the listener, just more of it.
  This is the classic graceful-restart trick and needs no new mechanism.
  **Two caveats, the first of which is why this is spike-first:** `exec`
  terminates every thread but the caller, and Linux keys the parent-death signal
  to the parent *thread*, not the process - so if the thread that forked bwrap
  isn't the one calling `exec`, `--die-with-parent` fires anyway. The fix is to
  drop `--die-with-parent` and lean on the scope-based reaping `SweepOrphanScopes`
  already does, but that wants proving before it is planned. Second: scrollback
  rings live in memory and would need passing through a temp file, or accepting
  their loss.
- **(b) Split the process** - a small supervisor owning PTYs, plus a web/API
  server that restarts freely. Cleanest long-term, largest change.
- **(c) A per-head shim** owning the PTY, so nothing the daemon does matters.
  Medium-large.

**(a) is probably the answer**, and it is now a small increment rather than a
separate design, because Phase B adopts `exec` for its own reasons. That is the
main argument for taking `exec` early even though Phase B gains nothing from fd
inheritance yet.

## Audit: what else is missing

- **`Development` is a boolean meaning "mage will rebuild me"**
  (`internal/cli/runtime.go:249`), so the restart button only renders under the
  mage loop. Needs to become a mode (`off` / `restart` / `update`).
- **The systemd unit does not account for the button** - `RenderSystemdUnit`
  (`internal/service/systemd.go:52-53`) emits `Restart=on-failure` /
  `RestartSec=2`, and exit 42 counts against systemd's default rate limit
  (5 starts / 10s), so a few quick presses land the unit in `failed`. Moot once
  restart is an `exec`: the PID never changes and systemd is not involved. Noted
  because it is the reason the exit-code design needed unit changes at all.
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

**Phase B - self-update via `exec` (small/medium).** The update endpoint, the log
stream, the toast, verify-then-swap, `exec`-restart with the listener fd carried
over, the `os.Getpid()` guard in `StopDaemon`, `Development` as a mode,
`INVOCATION_ID` detection, linger. Then delete `Dev`, `DevExpose`, `Prod`,
`Preview`, `DevAutoReload` and `devServerLoop`. This is where the magefile
collapses. Restart still kills heads, so it needs a confirmation showing the live
count.

**Phase C - restart without killing heads (medium, spike first).** Carry the PTY
master fds across the `exec` that Phase B already does, drop `--die-with-parent`
in favour of scope-based reaping, and remove `StopAll`. Removes the confirmation
from Phase B and makes "hot swap" literally true.

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
- **`syscall.Exec` rather than exit-42-and-let-the-supervisor-restart.** It makes
  restart independent of how the process was started, keeps the PID (so systemd's
  start rate limit is never involved), and allows the listener - and later the
  PTYs - to be carried across. Exit 42 survives only as the fallback for when
  `exec` itself fails.
- **No file watcher.** Auto-rebuilding a server that (pre-Phase C) kills every
  running head is not something to automate. `mage devFast` covers fast iteration.
