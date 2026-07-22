# Windows support: current state and implementation plan

Status: **planning**. Nothing below has been implemented yet; this doc records
the July 2026 audit of the Windows stubs and the proposed design for a Windows
port. Companion to [macos-support.md](macos-support.md) - several work items are
shared and are called out as such. Update the checklists as pieces land.

## Background

Hydra sandboxes heads with bubblewrap on Linux and Seatbelt on macOS. Windows
has neither, and the primitives it does have change the shape of the port:

- **No mount namespaces, no bind mounts.** Like macOS, anything Linux does by
  mounting over a path must become an ACL rule, a file copy, or an env-var
  redirect. The seeding "intent layer" refactor planned for macOS (deliver
  file X so the agent sees it at location Y) is the same refactor Windows
  needs; build it once with three backends.
- **AppContainer is the natural sandbox substrate** - the mechanism browsers
  and UWP apps run under. Crucially it is *default-deny*: an AppContainer
  process can read only world/`ALL APPLICATION PACKAGES`-ACLed locations
  (system dirs, Program Files) and write nowhere, until specific directories
  are granted to its per-container SID via ACL entries. That is the opposite
  polarity from Linux (read everything except `masked_paths`), so the
  writable/masked model maps to *grants* rather than *masks*.
- **Restricted tokens + integrity levels** are the weaker alternative
  (low-integrity blocks writes via no-write-up but allows most reads). Simpler
  to ship, much weaker isolation; treated here as a fallback, not the target.
- **Windows Sandbox** (the feature the current stub's error message mentions)
  is a full utility VM: GB-scale overhead, slow start, awkward host file
  sharing, no clean per-head lifecycle. Rejected for per-head use; the stub
  message should be updated when the backend lands.
- **Job objects** replace process groups: `KILL_ON_JOB_CLOSE` gives reliable
  whole-tree teardown, which Linux gets from PID namespaces and signals.
- **ConPTY** (`CreatePseudoConsole`) replaces Unix PTYs; `creack/pty` has no
  Windows backend at all.
- **No Unix signals.** `os.Process.Signal` supports only `Kill` on Windows;
  graceful shutdown must be an explicit channel (an HTTP endpoint, console
  ctrl events, or job-object termination).
- **AF_UNIX sockets work** (Windows 10 1803+, supported by Go's `net`), so the
  daemon control socket can stay a unix socket; only autostart/locking/shutdown
  mechanics need porting.
- **WSL2 runs the Linux backend unchanged** - bwrap, pasta, seccomp, the lot.
  For a Windows *user* (as opposed to a Windows-native toolchain), Hydra
  inside WSL2 is full-fidelity Hydra today, and localhost forwarding makes the
  web UI reachable from Windows browsers automatically.

Nothing in this plan needs a kernel driver or a Windows service running as
SYSTEM. One item (hard-mode egress) needs a one-time admin step; everything
else runs as the unprivileged user.

## Current state (audited 2026-07)

Significant groundwork already exists - the tree is not Windows-hostile, it is
Windows-stubbed:

- `GOOS=windows go build ./...` and `go vet ./...` are **clean** (amd64).
- Deliberate `//go:build windows` stubs, each erroring with "not yet
  supported": `internal/sandbox/windows.go` (BuildSpec; `NoSandbox` specs
  already work), `internal/session/pty_windows.go` (ConPTY pending),
  `internal/daemon/autostart_windows.go` (autostart pending),
  `internal/cli/attach_term_windows.go` (interactive attach pending),
  `internal/nshost/host_windows.go`, `internal/usage/probe_windows.go`.
- Already genuinely Windows-aware: `paths.ComparePaths` (case-insensitive on
  windows), `internal/db/model_windows.go` (`COLLATE NOCASE` on
  `ProjectPath`), log dir under `%LOCALAPPDATA%` (`internal/cli/root.go`),
  Windows shell quoting (`internal/common/exec.go`), `.exe` suffix in mage,
  process-group signaling cleanly split behind `unix` tags with a documented
  best-effort fallback (`internal/services/pgroup_other.go`,
  `internal/preview/pgroup_other.go`), folder picker falls back gracefully.
- `internal/git` shells out to `git` only - works with Git for Windows.

Load-bearing gaps (what the stubs stand in for), in dependency order:

1. **No ConPTY session backend** - nothing can run an interactive agent
   terminal at all. This blocks everything else.
2. **No daemon autostart/stop** - `autostart_unix.go` uses `syscall.Flock` +
   `Setsid`, neither of which exists on Windows; and `upgrade.go`'s
   `StopDaemon` sends SIGTERM, which Windows silently ignores (the error is
   discarded), so auto-upgrade would spin until its timeout.
3. **`daemon/socket.go` runtime dir** is keyed by `os.Getuid()`, which is
   always -1 on Windows - all users of a shared TEMP collide on `hydra--1`.
   Should mirror `root.go`'s `%LOCALAPPDATA%` handling.
4. **Every config-driven script is `bash -c`** - tests, artifacts, services,
   previews, `pre_exit_script`, the host-run escape hatch
   (`internal/http/hostrun.go` uses `bash -lc`), and the namespace host's
   hardcoded `/bin/bash`. No shell abstraction exists.
5. **`internal/heads/seed.go` bakes in POSIX paths and env** -
   `/tmp/hydra-internal`, `/tmp/hydra-gate-policy.json`, the MCP catalog path,
   and `agentEnv()`'s `HOME`/`USER`/`TMPDIR=/tmp` (Windows tools want
   `USERPROFILE`/`USERNAME` and a real `%TEMP%`).
6. **The namespace-host supervisor (`internal/nshost`) is conceptually
   Linux-only** - bwrap + AF_UNIX `SCM_RIGHTS` fd passing. It has no Windows
   analogue and does not need one: a job object per head covers the
   supervision role.
7. **`attach_term.go` resize is SIGWINCH-based** - Windows needs console
   resize events or polling (the raw-mode side, `charmbracelet/x/term`,
   already supports Windows console modes).
8. **Egress hard mode requires pasta + nft** - `DetectHardMode` reports
   unavailable on Windows and heads fail closed to network-off, same as macOS
   today.
9. `internal/http/chat_ws.go` validates agent-reported output paths with a
   hardcoded `/tmp/` prefix - needs a per-OS prefix once Windows heads exist.

Cosmetic / accepted degradations: `os.Chmod` only toggles the read-only bit
(0700-style protection of the socket/state dirs needs ACLs if it needs to be
real); `SIGTERM` handlers never fire (Ctrl-C does); leader-only kill for
services/previews until job objects land; the systemd deploy target stays
Linux-only.

## Feasibility summary

| Feature | Verdict | Windows mechanism |
|---|---|---|
| Full-fidelity Hydra for Windows users | works today | WSL2 (Linux backend unchanged) |
| PTY sessions | feasible | ConPTY via `x/sys/windows` |
| Daemon (socket, autostart, upgrade) | feasible | AF_UNIX + `LockFileEx` + shutdown endpoint |
| Script runners (tests/artifacts/services) | feasible | Git for Windows bash (already a Claude Code prereq) |
| FS sandbox (writable/masked) | feasible, polarity flip | AppContainer SID + ACL grants |
| Config seeding (Binds/ROOverlays) | feasible, shared with macOS | copy + env redirection intent layer |
| Network off / advisory | feasible | drop `internetClient` capability / proxy env vars |
| Hard network egress | feasible, needs one-time admin | no capability + loopback exemption for proxy port |
| Per-head /tmp | feasible | per-head `TMP`/`TEMP` env |
| Whole-tree teardown | feasible, better than today | job object `KILL_ON_JOB_CLOSE` |
| cow_paths | copy only | no reflink on NTFS; ReFS/Dev Drive block clone where present |
| Seccomp | not needed | AppContainer is the syscall-surface reduction |
| nshost supervisor | not ported | job objects replace it |

## Plan

### Phase 0: WSL2 as the documented path (near-zero code)

Goal: Windows users have a supported way to run Hydra *now*, decoupling "use
Hydra on a Windows machine" from the multi-week native port.

- [ ] Validate the stock Linux flow inside WSL2 on real hardware: bwrap
      userns, pasta hard mode, daemon, web UI reachable from a Windows
      browser via localhost forwarding. All are expected to work; confirm and
      note any WSL-specific quirks (e.g. projects on `/mnt/c` are slow and
      9p-mounted - recommend keeping repos in the WSL filesystem).
- [ ] Write a short setup guide (README section or docs page).
- [ ] Make the Windows-native binary print a pointer to the WSL2 guide when
      sandboxing is unavailable, instead of only the terse stub error.

### Phase 1: native plumbing (no sandbox yet)

Goal: `hydra` on Windows can run the daemon, the web UI, and *unsandboxed*
heads end to end. Unsandboxed heads must be an explicit root-config opt-in
(same trust model as `unsafe_host`: a branch cannot grant itself host access),
never a silent fallback.

- [ ] ConPTY backend for `internal/session/pty_windows.go`:
      `CreatePseudoConsole` + `ResizePseudoConsole` from `x/sys/windows`
      (avoid adding an unmaintained wrapper dep if the direct calls stay
      small). The `Registry` (scrollback ring, fan-out, resize) is already
      platform-neutral.
- [ ] Daemon lifecycle:
      - `autostart_windows.go`: detach with
        `CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS | CREATE_NO_WINDOW`
        creation flags; single-instance lock via `LockFileEx`.
      - Replace the SIGTERM-based `StopDaemon` with a `POST /shutdown` on the
        control socket, used on *all* platforms (it is the right portable
        design anyway); keep kill-by-PID as the escalation. Fixes the silent
        no-op at `internal/daemon/upgrade.go` on Windows.
      - `socket.go`: key the runtime dir off `%LOCALAPPDATA%\hydra` on
        Windows instead of `os.Getuid()`. AF_UNIX socket itself stays; mind
        the ~108-byte sun_path limit when placing it.
- [ ] Interactive attach (`attach_term_windows.go`): raw mode already works
      via `charmbracelet/x/term`; implement resize by polling console size or
      reading window-resize input records.
- [ ] Shell abstraction for script runners: resolve `bash` from PATH plus the
      standard Git for Windows locations, and document Git for Windows as a
      hard prerequisite (Claude Code on Windows already requires it, so it is
      not a new ask). All `bash -c` call sites (tests/artifacts/services/
      preview/pre_exit/host-run) go through one helper; no cmd.exe dialect -
      config scripts stay POSIX everywhere.
- [ ] `seed.go` env split: `USERPROFILE`/`USERNAME`/`TEMP` on Windows, and
      make the `/tmp/hydra-*` well-known paths per-OS constants.
- [ ] Wire `signal.NotifyContext` expectations honestly: rely on Ctrl-C +
      the shutdown endpoint; delete the dead SIGTERM assumptions.
- [ ] CI: add `GOOS=windows` build+vet (cheap, on Linux) and a
      windows-latest runner for `go test ./...` with unit-testable pieces
      (ConPTY, daemon lock, paths).

### Phase 2: AppContainer sandbox backend

Goal: `sandbox.BuildSpec` on Windows returns a real confined spec:
AppContainer profile + job object.

- [ ] Per-head AppContainer profile (`CreateAppContainerProfile`, SID derived
      from the head ID; deleted on kill/merge). Launch via
      `CreateProcess` attribute list carrying `SECURITY_CAPABILITIES` and the
      ConPTY handle; assign to a job object with `KILL_ON_JOB_CLOSE` (this
      also upgrades services/previews teardown from leader-only kill).
- [ ] FS policy, polarity-flipped: grant the container SID read+write ACEs on
      the worktree, head state dir, per-head temp, and `writable_paths`;
      read-only ACEs on the project root and `restore_ro`-equivalents.
      `masked_paths` inside granted trees become explicit deny ACEs; outside
      them, default-deny already covers it. Decide and document how much of
      the host to make readable (Linux heads read nearly everything; a
      Windows head reading only system dirs + explicit grants is *stricter*,
      and probably fine - the agent mainly needs its worktree and toolchains).
      ACL grants are persistent host-visible state, unlike mounts: cleanup on
      head kill is mandatory, and a startup sweep should garbage-collect ACEs
      from crashed heads (SIDs are per-head, so stale ones are identifiable).
- [ ] Git common-dir write grant (the `GitCommonDir` equivalent of the
      Linux/darwin bind) via the same ACE mechanism.
- [ ] Config seeding: implement the Windows arm of the shared seeding intent
      layer from the macOS plan (Phase 1 there) - per-head copies +
      `CLAUDE_CONFIG_DIR` etc. Managed-settings substitute: seed hooks/gate
      config as user-level settings in the redirected config dir and deny
      writes on that file via ACE (same trick as the macOS Seatbelt
      deny-write). The hydra binary is delivered at a per-head path, which
      the pre-prompt already parameterizes after the macOS refactor.
- [ ] Per-head temp: point `TMP`/`TEMP` at the per-head dir (the Windows
      convention actually routes tools through env, so this is cleaner than
      Linux); grant it in the ACL set.
- [ ] cow_paths: copy into place (no reflink on NTFS); use ReFS/Dev Drive
      block cloning opportunistically when the volume supports it. In-place
      overlays over host paths stay impossible - same env-redirect substitute
      as macOS.
- [ ] Long paths: ship the `longPathsEnabled` application manifest and
      recommend `git config core.longpaths true` in the setup guide.
- [ ] Fallback decision point: if AppContainer proves too hostile to dev
      toolchains in practice (some tools misbehave under default-deny), the
      documented fallback is restricted token + low integrity + job object -
      weaker (reads mostly allowed) but shippable behind the same Spec.

### Phase 3: network egress

Goal: the four `network.mode` postures work natively.

- [ ] `off`: create the AppContainer with no network capabilities - kernel
      enforced, no tools needed. Strictly better than today.
- [ ] `advisory` / `unrestricted`: grant `internetClient` (+
      `privateNetworkClientServer` for LAN) and inject the proxy env vars as
      on Linux.
- [ ] `hard`: grant no internet capability; exempt the container from
      loopback isolation so it can reach the CONNECT proxy on 127.0.0.1
      (`NetworkIsolationSetAppContainerConfig` - requires elevation once per
      profile; make it a one-time `hydra setup` admin step with a clear
      error when missing). Non-proxy traffic has no capability and dies at
      the kernel, like the nft lock. The existing Go proxy and hostname
      allow-list run unchanged. `allowed_loopback_ports` = additional
      loopback exemptions.
- [ ] `DetectHardMode` grows a windows arm (probe: can we create a profile +
      set the loopback exemption?); `internal/heads/egress.go` keeps failing
      closed to network-off until it reports available.
- [ ] Port pinning: the netns invariant does not apply, but keep the pinned
      proxy port for consistency, as on macOS.

### Phase 4: polish and validation

- [ ] `internal/http/chat_ws.go` output-path validation gets a per-OS
      temp-prefix instead of hardcoded `/tmp/`.
- [ ] Folder picker: PowerShell `System.Windows.Forms.FolderBrowserDialog`
      one-liner in the existing `runtime.GOOS` switch.
- [ ] Usage probe (`internal/usage/probe_windows.go`): port if the underlying
      claude probe works on Windows; otherwise keep the graceful unavailable
      snapshot.
- [ ] Update the `sandbox/windows.go` stub error message (it still promises a
      "Windows Sandbox backend"; the design is AppContainer).
- [ ] End-to-end on real hardware: spawn a head under AppContainer, verify
      gate/hooks/MCP/status.json, kill/merge cleanup (ACEs + profile + job
      object all gone), hard-mode egress blocks a direct dial.
- [ ] CI: windows-latest runner spawn-and-probe test (GitHub runners allow
      AppContainer creation); keep the cross-compile check on Linux CI.

## Known can't-do list

1. In-place mount-overlays (bind mounts, overlayfs cow) - no unprivileged
   mounts on Windows. Substitute: copies + env redirects (shared with macOS).
2. The nshost shared-namespace supervisor model - namespaces do not exist.
   Substitute: job objects; nshost stays unported by design.
3. Loopback access from an AppContainer without a one-time elevated
   exemption - Windows blocks it by design. Substitute: `hydra setup` admin
   step for hard mode only (off/advisory need no elevation).
4. Reflink-style CoW on NTFS. Substitute: plain copies, ReFS block clone on
   Dev Drives.

## Rough sizing

Phase 0 is documentation plus a validation pass (a day, needs a Windows+WSL2
machine). Phase 1 is the plumbing bulk (days: ConPTY and the daemon lifecycle
are the two real pieces). Phase 2 is the largest single chunk (days to a
couple of weeks: AppContainer launch path, ACL engine with cleanup, plus its
share of the seeding refactor - do the macOS seeding intent layer first so
Windows only adds a backend). Phase 3 is small once Phase 2 exists (the proxy
already does the hard part). Phase 4 needs Windows hardware or CI runners.

Ordering note: Phases 0 and 1 are independent of the macOS work; Phase 2
should land *after* the macOS Phase 1 seeding refactor to avoid building the
delivery abstraction twice.
