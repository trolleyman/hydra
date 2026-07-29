# Deploying Hydra: a self-updating local service

Hydra installs as a `systemd --user` service and rebuilds itself on demand. You
press a button in the sidebar; it compiles in the background while still serving,
streams the build log into a toast, and only swaps the binary and restarts if the
build succeeded.

There is one build flavour - minified, with source maps, precompressed - and one
way to run the server. The restart button *is* the deploy.

## What this is, and isn't

This is not a deployment in the classic sense: the machine keeps the source
checkout and the toolchain, and the server compiles itself. For a single-user
tool you are actively building, that is the right shape.

The safety property worth naming is that **the installed binary is a snapshot,
and the button is an explicit "adopt current source"**. A broken working tree
cannot take the server down until you ask it to, and a failed build cannot take
it down at all.

## Installing

```
mage deploy:setup     # once - generates the auth key non-localhost access needs
mage deploy:service
```

`Deploy.Service` (`magefiles/magefile.go`) builds a binary to
`~/.local/bin/hydra`, provisions the bundled sandbox tools (a headless service
cannot fall back to a nice shell environment), and writes
`~/.config/systemd/user/hydra.service` via `service.RenderSystemdUnit`. It offers
to enable lingering, without which a `--user` unit stops at logout and only
returns at the next login - the single most surprising thing about this
deployment. It does not enable or start the unit; it prints the two `systemctl`
lines.

The unit carries no exit-code protocol and no `StartLimit` tuning, because
restarts never reach systemd - see below.

## The build

`web/vite.config.ts` has exactly one flavour: `minify: 'esbuild'` and
`sourcemap: true`. Those are independent Vite options, and deriving both from a
`--mode development` flag is what used to make "fast" and "debuggable" look
mutually exclusive. They aren't - DevTools fetches a `.map` only when it is open,
so maps cost the browser nothing on a normal load.

Main-bundle bytes on the wire, and the resulting binary:

| | JS on the wire | binary |
|---|---|---|
| unminified + maps (the old `mage dev` build) | 7.3 MB total | 53.9 MB |
| minified, no maps | 399 KB | 37.4 MB |
| minified + maps, uncompressed | 399 KB | 49.9 MB |
| minified + maps, runtime gzip only | 122 KB | 49.9 MB |
| **minified + maps, precompressed** | **105 KB brotli / 122 KB gzip** | **~42 MB** |

Because there is one flavour, `HYDRA_DEV_BUILD` does not exist. That removed a
live trap as much as a branch: heads inherit the daemon's environment, so an
agent running `mage build` under a `mage dev` daemon silently produced a
development frontend, and a `mage deploy:service` from such a shell would have
installed one as prod.

### Compression

Static assets are compressed at build time by `web/scripts/precompress.ts`, which
writes `<name>.br` and `<name>.gz` and **deletes the original**. `dist` is
embedded in the binary, so keeping a copy nobody fetches would be paid for
forever - deleting it is what takes the binary from 49.9 MB to ~42 MB. It costs
~4-5s for ~970 files, fanning out across cores because `node:zlib`'s async calls
run on libuv's thread pool.

Brotli needs no new dependency at either end: node ships the encoder, and Go
never decodes brotli, it only serves the bytes.

The script also writes `dist/.encoded.json`, listing every file whose original it
replaced and which encodings exist for it. `internal/cli.serveAsset` loads that
once at startup, so serving is a map lookup rather than a hunt: absent means
"still on disk unencoded" (files under the size floor, and already-compressed
types like png and woff2), present means "the original is gone, here is what
exists instead". An empty index is a valid state, not an error - a `vite build`
without the precompress step leaves a plain `dist`, every lookup misses, and
every asset is read directly.

Details that are easy to get wrong, all covered by tests in
`internal/cli/server_frontend_test.go`:

- **Content-Type comes from the logical name.** The file on disk is
  `index-abc.js.br`, and `.br` means nothing to a browser. Nothing is sniffed
  either: for an encoded asset the bytes in hand are compressed, so sniffing
  answers "gzip" for everything. `.map` is registered with the `mime` package at
  init, since it has no entry in the system tables and would otherwise come back
  as gzip - which makes DevTools quietly ignore source maps.
- **Content-Length is the encoded length**, and Range is not supported: a range
  over a content-encoded body describes a representation the client never asked
  for.
- **A client accepting no encoding still gets readable bytes** - the gzip copy is
  decoded on the way out. That is why the identity fallback reads `.gz` and not
  `.br`: the standard library can do gzip.

Dynamic responses go through a separate runtime gzip middleware
(`internal/http/compress.go`) - diff payloads are the largest thing the UI
fetches and cannot be compressed ahead of time. It leaves static assets alone
automatically, never touching a response that already carries a Content-Encoding.
It also has to decide late (same sniffing problem), skip bodies under ~1KB (gzip
framing makes them bigger, and the UI polls several small JSON endpoints per
second per tab), treat a flush as "streaming, so the size threshold does not
apply", and pass through websocket upgrades, range requests and 204/304. It sits
*outside* `LoggingMiddleware`, which captures the body of a failed response for
the log and should capture the readable one.

## Restarting and updating

### Restart is `syscall.Exec`, not exit-and-be-restarted

`internal/selfupdate` replaces the process image in place. That choice pays for
itself three times:

- **No supervisor dependency.** Restart behaves identically under systemd, under
  `hydra server` in a terminal, and under nothing at all. There is no exit-code
  protocol, no `RestartForceExitStatus`, no `StartLimit` tuning, and no mage
  rebuild loop.
- **The PID never changes**, so systemd - tracking MainPID under `Type=simple` -
  does not observe a restart. Pressing restart repeatedly cannot trip the
  5-starts-in-10s limit into `failed`.
- **Descriptors cross the exec.** The web listener is handed to the new image by
  clearing `FD_CLOEXEC` and passing its number in the environment, so the port is
  never unbound: requests arriving mid-restart queue in the accept backlog
  instead of being refused.

Details that bite:

- **Exec the installed path, not `/proc/self/exe`** - after a swap that still
  resolves to the pre-swap inode, so you would faithfully re-exec the binary you
  just replaced.
- **`StopDaemon` must not signal itself.** `serveUnixSocket` calls it at startup;
  after a re-exec the pidfile holds our own PID and `/proc/<pid>/cmdline` still
  says `__daemon`, so `pidIsHydraDaemon` agrees we are a daemon worth killing.
  Guarded on `pid == os.Getpid()` (`internal/daemon/upgrade.go`), with a test
  that fails without it.
- **Exit 42 survives only as a fallback** for when `exec` itself fails
  (`ENOENT`, `EACCES`, `ENOEXEC`).
- **Nothing deferred runs after the exec.** Drain first - services, previews,
  sessions, then close the database so SQLite's WAL is checkpointed - but do not
  `Shutdown` the listener being preserved, since that closes it.

### Update is a restart with a build in front

1. `POST /api/server/update` returns immediately; the build runs in a
   subprocess. **The old server keeps serving throughout.**
2. The log streams over `/ws/server/update` as `phase` and `log` frames:
   `building` -> `verifying` -> `swapping` -> `restarting`.
3. A build failure stops there and reports. Nothing was touched, the server never
   went down. This is the whole safety argument.
4. On success the new binary must prove it starts (`--version`) *before* anything
   is swapped.
5. `os.Rename` `hydra` -> `hydra.prev`, `hydra.new` -> `hydra`: two renames within
   one directory, so there is no instant at which the binary does not exist.
   `go build -o` over a running binary does not `ETXTBSY` (the Go linker unlinks
   its output first), and the sandbox binds carrying this binary into running
   heads pin the old inode, so they keep the version they started with.
6. Re-exec.

The daemon can do all of this itself: it is not sandboxed, it is the thing that
*spawns* sandboxes.

Update is offered only when the daemon's project root is a Hydra checkout with
mage available - Hydra manages other people's repositories too, and rebuilding
the server from one of those would be nonsense. Those daemons get restart but not
update, reported as `can_restart` / `can_update` on `/api/status`.

### The UI

One toast for the whole run, keyed so a second press replaces it in place. Its
body reads the update store, so "Building..." becomes "Update failed" by
re-rendering the same card - there is never a second toast, and never a gap where
the first has gone and the next has not arrived.

The log goes through `LogView`, the same xterm view the artifact and test build
logs use. That is a correctness requirement, not a consistency one: real
`mage build` output is full of ANSI, so a stack of divs renders the escape
sequences as literal garbage. xterm also brings scrollback, selection and
follow-the-tail. The toast opts into `TOAST_CARD_WIDTH_WIDE` (44rem, measured at
85 columns) because a terminal has a real width requirement;
`web/src/lib/toastLayout.ts` documents it as the one exception to the
single-width notification column.

Two things the client has to get right, both about what "the stream ended" means:

- A **successful** update severs its own websocket - the server re-execs, so no
  terminal frame can arrive. A socket lost at or after the swap is success
  (`outcome: 'restarting'`); one lost while the build was still running is a real
  failure.
- Subscribers are **replayed the events so far**, which is what lets a late tab
  catch up. So the job is started *before* subscribing - connecting first hands
  you the previous run's history, terminal frame and all, and declares the update
  finished before it began.

A failed build opens the log automatically and says nothing was changed. There is
no reload on that path: the server never went anywhere.

### Restarting stops running heads

A restart stops every live agent. They come back via `--continue`, but the
in-flight turn is lost, so the UI confirms first and names the count.

Two mechanisms do it: bwrap runs with `--die-with-parent`
(`internal/sandbox/linux.go`) and the drain calls `Registry.StopAll()`
(`internal/session/registry.go`).

This is the one part of the design that is not free, and it is **not fixed** -
see "Not built" below.

## `mage` after all this

Eight ways to start Hydra became three. `Dev`, `DevExpose`, `Prod`, `Preview`,
`DevAutoReload` and `devServerLoop` are gone - the installed service updates
itself, and `HYDRA_API_ADDR` covers exposing a port.

What remains, because each does a genuinely different job:

- `mage run` - foreground, for debugging the daemon itself.
- `mage devFast` - Vite HMR in front of the Go API. Hot-module-replacement is
  faster than any rebuild loop and is a different mechanism, not a duplicate.
- `mage demo` - simulation mode. `runSimulationServer` (`internal/cli/server.go`)
  returns *before* `setupRuntime` / `serveUnixSocket`, so it touches no daemon
  socket, DB, `projects.json` or scope sweep. It is the one genuinely isolated
  second instance, and it simulates an update - phases, a streaming log, and a
  failure every third run - so the panel can be driven without a real build.

## Not built: carrying agent PTYs across a restart

Making a restart *not* stop running heads means handing their PTY masters to the
new image, the way the listener already is. A spike settled two things:

- **The mechanism works.** A PTY master crosses `exec` fine, and on the far side
  the child is still running and still responding through it.
- **It only works with the parent-death signal gone.** With `Pdeathsig` set - as
  every Hydra sandbox has it, via `internal/scope.StartFunc` - the exec SIGKILLs
  the child even though the process it belongs to never died. Linux keys
  `PR_SET_PDEATHSIG` to the parent *thread*, and `exec` terminates every thread
  but the caller.

That second finding depends on **which thread forked**, which is the trap for
anyone re-running it. An early version of the spike forked and exec'd from the
same goroutine and the child survived - a false green light. Forking from a
separate goroutine, pinned across the fork and unpinned after (the shape
`scope.StartFunc` produces, and the shape the daemon really has, since sessions
start on request handlers while the exec runs on the update goroutine), kills the
child every time. Reproduce that setup or you measure the wrong thing.

The spike itself was deleted with the finding written down here: it exercised
Linux and Go semantics rather than any Hydra code, and its negative assertion
would have to be deleted the day someone made it work.

So the cheap route requires dropping `Pdeathsig` *and* bwrap's
`--die-with-parent` for agent sessions, and those exist for a reason: they
guarantee that a daemon dying ungracefully cannot leave a sandbox running. Give
them up and the backstop becomes `SweepOrphanScopes` at the next daemon boot,
which means a crash leaves agents running and burning tokens until something
restarts. It would also need that sweep taught to skip the units it just adopted,
or the restarted daemon reaps exactly what it carried over.

The alternative is to split the PTY owner into a small supervisor that never
restarts, with the web/API server restarting freely in front of it. That buys the
same thing without the trade, at the cost of the larger change. It is the one to
build if restart-without-losing-agents starts to matter.

Note the integration cannot be exercised inside an agent sandbox - bwrap will not
nest - so any attempt at this needs testing on the host with real heads.

## Decisions and rejected alternatives

- **Source maps in prod, minified and precompressed.** The caveat: maps hand out
  original source to anyone who can load the UI. Fine for a loopback/Tailscale
  deployment of your own code; reconsider before a public ngrok Funnel. Dropping
  brotli would save ~4 MB more binary for 17% more wire - the other end of the
  same trade, if that ever becomes the one worth making.
- **Verify before swapping, never roll back after.** Recovering from a dead
  process is not something to rely on; `hydra.prev` is a manual escape hatch, not
  the mechanism.
- **Update builds from the project root's working tree**, not a fetched release.
  That is the point - it is a self-updating local service. The UI should show the
  commit it is about to build so it is never a surprise.
- **No file watcher.** `mage devFast` covers fast iteration; auto-restarting a
  server that stops every running head is not something to automate.
- **One instance, not two.** An earlier draft of this doc proposed a dev instance
  beside a prod one. Untying minify from sourcemap removed the debuggability
  argument, and `SweepOrphanScopes` (`internal/sandbox/scope_linux.go`) is global
  - it reaps *all* `hydra-*.scope` units at daemon boot, so a second instance
  would kill the first's live sandboxes. Reviving it would need a per-instance
  scope prefix, plus namespacing for `~/.config/hydra/projects.json`, `uuid.txt`,
  the shared `~/.local/share/hydra/logs/hydra.log`, the daemon runtime key, and a
  templated `hydra@<instance>.service`.
- **The CLI's binary-stamp auto-upgrade leaves a service-managed daemon alone.**
  It used to SIGTERM it and respawn it detached, which left systemd's unit
  inactive with an unsupervised daemon behind it. The daemon stamps
  `managed=systemd` into its info file (systemd sets `INVOCATION_ID` for every
  service) and `Connect` prints what to do instead.
