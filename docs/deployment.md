# Deploying Hydra: the prod/dev instance split

Status: **proposed, unbuilt** (audit + plan). The pieces that already exist are
marked BUILT inline.

## Background: what actually runs today

The day-to-day Hydra on this machine is `mage dev`. That is worth stating
plainly, because it explains every problem below:

- `Dev()` (`magefiles/magefile.go:1302`) sets `HYDRA_DEV_BUILD=1` and enters
  `devServerLoop` (`:1328`), which builds `.mage/hydra` from the **working tree**
  and runs it in the foreground.
- `HYDRA_DEV_BUILD=1` makes `BuildWeb` (`:1161`, flag read at `:1163`) run Vite
  with `--mode development`, which turns off minification and turns on source
  maps (`web/vite.config.ts:105-109`).
- The UI's restart button (`web/src/routes/__root.tsx:577` `handleRestart`) calls
  `POST /api/dev/restart` -> `Server.DevRestart` (`internal/http/handlers.go:1513`)
  -> `os.Exit(42)` (`devRestartExitCode`, `:56`). `devServerLoop` catches exit 42,
  **rebuilds**, and starts the new binary. The button only renders when the
  server reports `development: true`, which is `HYDRA_DEV_RESTART=1`
  (`internal/cli/runtime.go:249`).

So the current setup is a development loop being used as a production server. It
dies with the terminal, it serves an unminified bundle with source maps, and its
binary tracks whatever is in the working tree of `/home/callum/code/hydra`.

There is already a real deploy path, `mage deploy:service`
(`magefiles/magefile.go:921`, BUILT): it builds a production binary to
`~/.local/bin/hydra`, provisions the bundled sandbox tools, and writes a
`systemd --user` unit via `service.RenderSystemdUnit`
(`internal/service/systemd.go:31`). It is not installed on this machine
(no `~/.local/bin/hydra`, no `~/.config/systemd/user/hydra.service`), and it has
the gaps listed under "Audit" below.

## Requirements

Splitting out what each half of the ask actually demands, because they pull
against each other.

**Deploying properly means:**

1. The server survives the terminal closing, logging out, and a reboot.
2. It restarts itself on a crash.
3. It runs a **fixed artifact**, not a live checkout. This is the whole point of
   deploying: a half-finished edit in the repo must not be able to take down the
   server you are running your work on.
4. Production frontend build: minified, no source maps.
5. Logs land somewhere queryable (journal), not a scrollback buffer.
6. A deliberate, unchanging network posture.

**"Still restart it to refresh changes" means:**

7. A one-click way to get merged changes into the running server.
8. That path must never leave you with a dead server (bad build, bad binary).

Requirement 3 and requirement 7 are in direct conflict *only if you conflate two
different operations*. They separate cleanly:

- **Restart** = re-exec the artifact already on disk. Picks up a binary someone
  installed, re-reads config, clears leaked state. No build, no toolchain needed,
  cannot fail to produce a binary.
- **Update** = build a new artifact, prove it starts, swap it atomically, then
  restart. Can fail, and when it fails nothing has changed yet.

Prod gets both, as separate actions. Dev keeps today's fused "rebuild and
restart", because in dev a failed build costing you the server is fine.

**Two more requirements that fall out of the code, not the ask:**

9. **Restarting is not free.** bwrap is launched with `--die-with-parent`
   (`internal/sandbox/linux.go:181`) and the drain path calls
   `Registry.StopAll()` (`internal/session/registry.go:665`). A server restart
   therefore kills **every running head**; they come back via `--continue`
   (lazily on attach, or `resumeHeadsOnBoot`), but an in-flight turn is lost.
   Restart must be a deliberate act, and must never be wired to a file watcher on
   the prod instance.
10. **Two instances must not manage the same project.** Same project root means
    the same `.hydra/local/worktrees/`, the same `hydra/<id>` branch namespace,
    and two daemons independently resuming the same heads. This is a correctness
    requirement, not a preference.

## Audit: what already works, what is missing

### Works

- Per-project isolation of the daemon socket, pid, lock and info files:
  `sha256(projectRoot)[:16]` under `$XDG_RUNTIME_DIR/hydra/`
  (`internal/daemon/socket.go`).
- Per-project DB (`.hydra/local/state/db.sqlite3`), worktrees, status dirs
  (`internal/paths`).
- Bind address override via `HYDRA_API_ADDR` (`internal/cli/server.go:121`), with
  a hard refusal to bind non-loopback without an auth key.
- Preview port range configurable per project: `preview_ports`
  (`internal/config/config.go:967`, default `26601-26699`).
- Dev vs prod frontend build already exists (`HYDRA_DEV_BUILD`).
- `go build -o` over a running binary does **not** fail with `ETXTBSY` - the Go
  linker unlinks the output first (verified). Running processes and existing
  sandbox bind mounts keep the old inode, which is what we want.

### Missing / broken

- **No instance concept.** Nothing namespaces a Hydra installation. Grep for
  `HYDRA_INSTANCE` / `profile` in `internal/paths`, `internal/cli`,
  `internal/config` returns nothing.
- **User-global state is shared between any two instances:**
  - `~/.config/hydra/projects.json` - the project list
    (`internal/projects/projects.go:70,78`)
  - `~/.config/hydra/uuid.txt` (`:20`) and `~/.config/hydra/config.toml`
    (`internal/config/config.go:1064`)
  - `~/.local/share/hydra/logs/hydra.log` (`internal/cli/root.go:66`) - two
    processes rotating one file independently loses lines.

  The shared project list is the blocker for requirement 10: both instances would
  see, and try to manage, the same projects.
- **The systemd unit name is hardcoded** `hydra.service`
  (`magefiles/magefile.go`, in `Deploy.Service`), so only one can be installed.
- **The unit's restart semantics do not cover the restart button.**
  `RenderSystemdUnit` emits `Restart=on-failure` / `RestartSec=2`
  (`internal/service/systemd.go:52-53`). Exit 42 is non-zero so it *does*
  restart - but it counts against systemd's default start rate limit
  (5 starts / 10s), so a few quick restarts put the unit in `failed`. There is no
  `RestartForceExitStatus`, no `StartLimit*` tuning.
- **`Development` is tied to the rebuild loop.** The restart button only appears
  when `HYDRA_DEV_RESTART=1`, which today means "mage will rebuild me". A
  systemd-managed prod server wants the button with *restart-only* semantics, so
  the flag needs to become a mode, not a boolean.
- **The CLI auto-upgrade fights systemd.** `daemon.Connect` compares the invoking
  binary's stamp against the running daemon's (`internal/daemon/upgrade.go:19`
  `binaryStamp`, `:63` `isStale`) and, if they differ, calls `StopDaemon` (`:84`,
  SIGTERM) and then `EnsureRunning` to spawn a detached `hydra __daemon`. Against
  a systemd-managed daemon that is wrong either way: with `Restart=on-failure`
  the SIGTERM exits 0, the unit goes inactive, and an unmanaged daemon is now
  running; with `Restart=always` systemd restarts and two daemons race for the
  socket. Nothing currently detects that the daemon is service-managed.
- **`Deploy.Service` does not enable linger**, so the unit dies at logout unless
  the user runs `loginctl enable-linger` from the printed instructions.

## Proposal

### Shape

Two instances, disjoint project sets, disjoint port blocks.

| | prod | dev |
|---|---|---|
| lifecycle | `systemd --user`, linger, restart on failure | `mage dev` in a terminal |
| binary | `~/.local/bin/hydra`, installed artifact | `.mage/hydra`, from the working tree |
| frontend | minified, no source maps | unminified, source maps |
| web port | 26600 | 26700 |
| previews | 26601-26699 | 26701-26799 |
| projects | all your real work, incl. the Hydra repo | scratch / the worktree under test |
| restart button | restart-only (re-exec the artifact) | rebuild + restart (today's behaviour) |
| update | explicit "update and restart" action | n/a, every restart is an update |

**The non-obvious part: heads that develop Hydra belong on prod, not dev.** Dev
is the instance you restart constantly, and a restart kills every running head
(requirement 9). So prod is where agents live, and dev is the throwaway you point
at a worktree to *look at* what an agent built. Dev needs no systemd, no auth key
and no durability; it is a viewer, not a workhorse.

### Phase 1: make two instances possible (the only hard blocker)

Add an instance name, defaulting to `default`, sourced from `HYDRA_INSTANCE` (and
a `--instance` flag on the root command). It namespaces exactly three things:

- the user config dir: `~/.config/hydra/` -> `~/.config/hydra/instances/<name>/`
  for `projects.json` and `uuid.txt`, with a one-time migration of the existing
  files into `instances/default/`. Leave `~/.config/hydra/config.toml` shared:
  the user-scope config layer is genuinely machine-wide, and duplicating it would
  surprise.
- the log file: `hydra.log` -> `hydra-<name>.log` for a non-default instance.
- the daemon runtime key: fold the instance into the `sha256` input in
  `internal/daemon/socket.go` so the same project root under two instances gets
  two sockets. Not strictly needed if the roots differ, but it makes "same root,
  two instances" fail cleanly rather than by one SIGTERMing the other.

Everything else is already per-project-root or already env-overridable. Ports are
config, not code: dev sets `HYDRA_API_ADDR=localhost:26700` and
`preview_ports = "26701-26799"` in its boot project's config.

Escape hatch that works **today, with no code change**: `os.UserConfigDir()`
honours `XDG_CONFIG_HOME`, so pointing the dev instance at a different
`XDG_CONFIG_HOME` separates `projects.json`. Do not rely on it - that variable is
inherited by every child process, including the agent sandboxes, so `git`,
`claude` and friends would go looking for their config in the wrong place.

### Phase 2: split restart from update

- Turn `Server.Development bool` into a mode: `off` / `restart` / `rebuild`,
  derived from `HYDRA_DEV_RESTART` (`1` stays `rebuild` for compatibility;
  `restart` is what the unit sets). The button renders for `restart` and
  `rebuild`, with the tooltip and toast wording following the mode ("Restart the
  server" vs "Rebuild and restart the server").
- Teach the unit to honour it: add `RestartForceExitStatus=42`,
  `Restart=always`, and relax the rate limit (`StartLimitBurst=10`,
  `StartLimitIntervalSec=60`) in `RenderSystemdUnit`. The existing health-poll
  loop in `handleRestart` (`__root.tsx:598-610`) already works unchanged, since
  it just polls `/health` until the new process answers.
- **Warn before a prod restart when heads are live.** Requirement 9 makes this
  the difference between a safe button and a footgun: confirm with a count of
  running heads, and say plainly that in-flight turns are lost and each head will
  resume with `--continue`.

### Phase 3: update-and-restart

An explicit action, distinct from restart, that the daemon can run itself - the
daemon is *not* inside a sandbox, it is the thing that spawns them, so it can run
the toolchain directly.

1. Build to `~/.local/bin/hydra.new` (frontend embedded, production Vite mode).
2. Smoke-test it: run `hydra.new --version` (or a dedicated `hydra selfcheck`
   that boots the runtime against a temp root and exits). Abort on failure -
   nothing has been swapped, the running server is untouched.
3. `os.Rename` `hydra` -> `hydra.prev`, `hydra.new` -> `hydra`. Atomic on the
   same filesystem. Existing sandbox binds pin the old inode, so running heads
   keep the binary they started with.
4. Exit 42; systemd starts the new one.

Rollback is `mv hydra.prev hydra && systemctl --user restart hydra` from a
terminal. Verifying *before* the swap is what keeps requirement 8: the only
surviving failure mode is "passes selfcheck, crashes at runtime", and the start
rate limit stops that looping.

Whether the trigger lives in the UI or stays `mage deploy:service` + restart is a
judgement call worth deferring until phases 1-2 are in use. The mage target is
already sufficient and has no new failure modes.

### Phase 4: `Deploy.Service` polish

- Take an instance name and render `hydra@<instance>.service` (or
  `hydra-<name>.service`), so prod and a second deployment can coexist.
- Offer to run `loginctl enable-linger` rather than only printing it.
- Make the daemon record that it is service-managed - systemd sets
  `INVOCATION_ID` in the service environment, so `WriteDaemonFiles`
  (`internal/daemon/upgrade.go:32`) can stamp `managed=systemd` into the `.info`
  file. `isStale` then skips the SIGTERM-and-respawn takeover and tells the user
  to `systemctl --user restart` instead. This closes the CLI/systemd conflict
  above.

## Decisions and rejected alternatives

- **Prod keeps no source maps at all.** `sourcemap: 'hidden'` (maps emitted, no
  `//# sourceMappingURL` comment) is the usual production answer, but `dist/` is
  embedded into the binary with `//go:embed all:dist` (`web/embed.go`), so hidden
  maps would ride along as several MB of binary. Excluding `*.map` from the embed
  and shipping them beside the binary is possible but is a lot of machinery for a
  single-user deployment where the dev instance *is* the symbolication tool: run
  the same commit under dev and reproduce. Revisit if Hydra ever ships to someone
  who cannot rebuild it.
- **Prod restart does not rebuild.** Rebuilding requires Go, Node and a source
  checkout at runtime, and a failed build during a restart leaves no server at
  all. That is precisely requirement 8.
- **No file watcher on prod.** `mage preview` / `mage devAutoReload` exist for
  that and are dev tools; auto-restarting a server that kills every running head
  on restart is not something to automate.
- **User-scope `config.toml` stays shared** between instances. It is documented
  as machine-wide, and splitting it would make a setting silently not apply.
- **Not building a supervisor that outlives the daemon.** Detaching agent
  sessions from the daemon's lifetime would make restarts cheap and would remove
  requirement 9 entirely, but it is a large change to the session registry,
  `--die-with-parent`, and the scope reaper. Worth its own doc if restarts ever
  become routine.

## Rough sizing

- Phase 1 (instance namespacing): small. One resolver in `internal/paths` plus
  threading through `internal/projects`, `internal/cli/root.go` and
  `internal/daemon/socket.go`, plus a migration.
- Phase 2 (restart vs rebuild modes + unit flags): small. Mostly
  `internal/http/handlers.go`, `internal/cli/runtime.go`,
  `internal/service/systemd.go` and one button in `__root.tsx`.
- Phase 3 (update-and-restart): medium, and optional - `mage deploy:service`
  plus a restart already covers it manually.
- Phase 4 (`Deploy.Service` polish + systemd-managed detection): small.

Phases 1 and 2 together are what unlock the setup the whole doc is about;
3 and 4 are convenience.
