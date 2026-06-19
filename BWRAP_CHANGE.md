# Shared-namespace sandbox host (spike)

**Status:** experimental, behind `HYDRA_SHARED_NS=1` (off by default)
**Goal:** let a head's agent and its sandboxed bash terminals share **one writable
copy-on-write (`cow_paths`) overlay**, instead of bash terminals getting the COW
sources read-only.

## Why this exists

`cow_paths` exposes a host directory into the sandbox copy-on-write: the agent can
overwrite the files, but writes land in a per-head upper layer and never touch the
real tree (see `internal/heads/cow.go`).

Today every session is its own `bwrap` invocation:

```
agent          → bwrap A → mount ns A → overlay mount A (writable upper)
bash terminal  → bwrap B → mount ns B → overlay mount B
```

overlayfs gives **undefined behaviour / corruption** if two live overlay *mounts*
share one `upperdir`/`workdir`. The agent already owns the writable overlay on the
head's upper; a bash terminal shares the same worktree and would want the same
upper. Rather than risk corruption, bash terminals are mounted **read-only** — which
is the `Read-only file system` error you hit writing to a `cow_paths` dir from a
sandboxed bash terminal.

The key realisation: the corruption rule is about two separate overlay *mounts*, not
about many processes on one mount. Many processes in **one** overlay mount is normal
and safe. So if the agent and the bash terminals are all children of **one** `bwrap`,
they share that one overlay mount and one upperdir — no conflict, shared writes.

```
                    ┌─ agent          (child → same overlay)
bwrap (per head) ───┤
  pid-1 = supervisor├─ bash terminal  (child → same overlay)
  overlay mount     └─ bash terminal  (child → same overlay)
```

## Architecture

A "namespace host": one `bwrap` per head whose pid-1 is a small supervisor that
spawns further PTY-attached children on demand and hands their master fds back out
to the daemon.

```
hydrad (daemon, host)
  └── bwrap (one per head)            ← owns the mount ns + the single COW overlay
        └── hydra __sandbox-init      ← supervisor, pid-1 in the ns
              ├── claude / gemini …    (agent, first child)
              └── /bin/bash, …         (terminals, spawned on request)
```

- bwrap is not Docker — there is no `bwrap exec`. (And joining a userns via
  `--userns FD` still gives you a *fresh* mount namespace, so it would not inherit
  the overlay.) So the only way to get a new process into the existing overlay is to
  spawn it as a child of a process already inside — hence the supervisor.
- A bare signal can't carry a new PTY's master fd back to the daemon, so "signal the
  supervisor to spawn a shell" becomes a small control socket with fd passing.

## What changed

### `internal/nshost` (new)

The supervisor + daemon-side client + wire protocol.

- `Serve(socket)` — runs as pid-1 inside the bwrap (via `hydra __sandbox-init`).
  Listens on a unix socket; **one connection per spawned child**. For each: read the
  spawn request, launch a PTY child (`creack/pty`), pass the master fd back via
  `SCM_RIGHTS`, relay later signal requests, and report the child's exit.
- `Client.Spawn(req)` — daemon side: dials the socket, sends the request, receives
  the master fd, returns a `*Spawned`.
- `*Spawned` satisfies the session PTY shape (`Read`/`Write`/`Resize`/`Wait`/
  `Signal`/`Pid`/`Close`), backed by the received master fd plus the control conn.
  The supervisor drops its own copy of the master after passing it, so the daemon
  closing its copy is what delivers `SIGHUP` to the child.
- Windows stub returns "unsupported" (bwrap + unix-socket fd passing are Linux-only).

The control socket lives in a host dir bind-mounted into the bwrap (writable), so
the supervisor's listener is reachable from the daemon at the same path.

### `internal/cli/sandbox_init.go` (new)

Hidden `hydra __sandbox-init --socket <path>` command — the process bwrap launches
as pid-1. The hydra binary is already bound into every sandbox at
`/tmp/hydra-internal` (now exported as `heads.SandboxHydraBinPath`).

### `internal/session`

- `Session.proc` is now an interface, `PTY`, satisfied by both the local
  `ptyProcess` (its own bwrap) and `nshost.Spawned` (remote child).
- `Registry.Start` refactored into `reserve()` + `register()`.
- New `Registry.StartWithProc(...)` backs a session with an already-running remote
  PTY instead of launching its own bwrap; the proc is closed when the session exits.

### `internal/heads/nshost.go` (new) + wiring

- `sharedNSEnabled()` — reads `HYDRA_SHARED_NS` (`1`/`true`/`yes`).
- `ensureNamespaceHost(...)` — launches the supervisor bwrap once per head, reusing
  the agent's **exact** sandbox options (binds, masks, network, **writable COW
  overlay**) but with `__sandbox-init` as the entrypoint and the control-socket dir
  added writable. Waits for the socket, returns a client.
- `startAgentSession(...)` — default path calls `reg.Start` (one bwrap per session,
  unchanged). With the flag on, it starts the namespace host and runs the agent as
  the supervisor's first child (`reg.StartWithProc`). Used by `SpawnHead` and
  `ResumeHead`.
- `StartShellSession` — with the flag on and a namespace host present, spawns
  sandboxed bash as a **sibling child** of the supervisor, so it shares the writable
  overlay. Without the flag (or host), the existing read-only-COW path is unchanged.
- `runPreExitInNamespace(...)` — with the flag on and a host present, the
  `pre_exit_script` runs as a child of the **still-live supervisor** (the same bwrap
  as the agent, sharing its writable COW overlay so it sees the agent's writes). It
  runs **before** `removeNamespaceHost`, so the kill order is: kill agent session →
  kill bash shells → pre-exit hook → tear down supervisor → remove worktree/branch.
  Without a host it falls back to a fresh standalone sandbox (the prior behaviour).
  A hung hook is bounded by `preExitTimeout` and killed via the supervisor (the
  passed-in master fd is blocking, so the child is signalled, not just disconnected).
- `removeNamespaceHost(id)` — tears down the supervisor + socket dir; called from
  `KillHeadNoLock` (after the pre-exit hook) and the spawn-cleanup path.

### `internal/sandbox`

- `WrapPreSpawn(script, argv)` exposes the existing pre-spawn wrapper. In
  shared-namespace mode the agent child's argv is wrapped with it, so the
  `pre_spawn_script` runs **inside the supervisor's bwrap** — the same one the agent
  and bash terminals share — and its writes land in the shared COW overlay.

## How to try it

On a host with an overlay-capable bwrap (see the `cow_paths` note about
`HYDRA_BWRAP` on distros that strip overlay support):

1. Run the daemon with `HYDRA_SHARED_NS=1`.
2. Configure a `cow_paths` entry for the head (e.g. `pipeline/out`).
3. Spawn the head, open a **sandboxed** bash terminal, and write into the COW dir:
   `echo aa > pipeline/out/test.txt` — it now succeeds and is visible to the agent.

The "Regular shell (host)" terminal deliberately stays outside the namespace (it is
unsandboxed by design), so only **sandboxed** terminals share the overlay.

## What's proven vs. needs a host

- ✅ The spawn / fd-passing / exit machinery is proven end-to-end **without bwrap**
  by `internal/nshost` tests: one supervisor spawns two children that write to the
  same shared file and whose exit codes propagate. `mage build` and `go test ./...`
  are green.
- ⚠️ The overlay sharing itself needs an overlay-capable bwrap (can't run nested in
  the dev sandbox), so it is validated on a real host via the steps above.

## Hooks in shared-namespace mode

Both lifecycle hooks run **in the head's one shared bwrap** when the flag is on, so
each sees (and writes to) the same COW overlay as the agent:

- `pre_spawn_script` — wrapped around the agent child's argv (runs, then `exec`s the
  agent), exactly as `withPreSpawn` does for the standalone path.
- `pre_exit_script` — spawned as a child of the still-live supervisor during kill,
  before the supervisor is torn down.

For sandboxed **bash terminals**, `pre_spawn_script` is still intentionally skipped
(it is a once-per-head agent hook; interactive shells open repeatedly), unchanged
from today's behaviour.

## Robustness

- **Reaping:** we do not pass bwrap's `--as-pid-1`, so bwrap installs its own reaper
  as pid 1 of the namespace and our supervisor runs as its child. The supervisor
  reaps its own direct children (agent, terminals) via `cmd.Wait`; orphaned
  grandchildren reparent to bwrap's pid-1 reaper and are collected there — they do
  not accumulate as zombies.
- **Per-head launch, no global stall:** the supervisor registry holds its lock only
  to claim a head's slot; the slow launch (build + start + up-to-10s socket wait)
  runs without the lock, and concurrent callers for the same head block on that
  slot's `ready` channel instead of relaunching. One head's launch never stalls
  another's.
- **Crash eviction + synchronous teardown:** a single watcher goroutine is the sole
  waiter on each supervisor. If the supervisor exits — a crash or an explicit
  `removeNamespaceHost` kill — the watcher evicts the registry slot, runs cleanup,
  and removes the socket dir. So a crashed host is not left cached: the next
  attach/resume re-creates a fresh one (the child sessions get EOF and exit, and
  lazy resume brings the head back). `removeNamespaceHost` kills then blocks on the
  watcher, so teardown is complete before the worktree is removed.

## Remaining design properties (not bugs)

- **One policy per namespace:** everyone in a head's namespace shares its seccomp /
  network / masks / writable paths — which is the intended behaviour (a shared
  terminal should have the same confinement as the agent). A supervisor crash takes
  that head's terminals with it; they come back on the next attach via the eviction
  + re-create path above. The unsandboxed "Regular shell (host)" stays a separate,
  unconfined process by design.
- **Pre-spawn for terminals:** sandboxed bash terminals still skip `pre_spawn_script`
  (a once-per-head agent hook), unchanged from the standalone behaviour.

All of this is gated off by default; with `HYDRA_SHARED_NS` unset the behaviour is
exactly as before (one bwrap per session, bash terminals get COW read-only).
