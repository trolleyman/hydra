# Windows support: current state and implementation plan

Status: **native backend planning; desktop shell partially implemented**. The
Windows Forms/WebView2 application and packaging scaffold live under
`desktop/windows`, but the ConPTY, daemon transport, and sandbox files audited
below remain explicit unsupported stubs. Companion to
[macos-support.md](macos-support.md) - several work items are shared.

Packaging that native runtime as a standalone Windows desktop application, with
full Hydra and focused chat windows, is covered by
[windows-desktop-chat.md](windows-desktop-chat.md).

## Background

Hydra sandboxes heads with bubblewrap on Linux and Seatbelt on macOS. Windows
has neither, and the primitives it does have change the shape of the port:

- **No mount namespaces, no bind mounts.** Like macOS, anything Linux does by
  mounting over a path must become an ACL rule, a file copy, or an env-var
  redirect. The seeding "intent layer" refactor planned for macOS (deliver
  file X so the agent sees it at location Y) is the same refactor Windows
  needs; build it once with three backends.
- **There is strong prior art: OpenAI's Codex CLI shipped a native Windows
  sandbox in 2026** (see "Prior art" below) and published its reasoning. They
  evaluated AppContainer, Windows Sandbox (the VM), and Mandatory Integrity
  Control and rejected all three; their production design composes
  **write-restricted tokens, dedicated low-privilege sandbox users, ACL
  grants, per-user firewall rules, job objects, and a private desktop**. This
  plan follows that shape rather than re-deriving one.
- **Why not AppContainer** (this plan's original candidate): it is
  *default-deny* - an AppContainer process can read only
  `ALL APPLICATION PACKAGES`-ACLed locations and write nowhere until granted.
  That polarity is wrong for open-ended developer workflows (shells, git,
  Python, package managers, build tools all read broadly across the host),
  which is exactly why Codex rejected it after evaluation. A write-restricted
  token has the same polarity as Linux: reads work as normal, writes only
  where the sandbox identity is granted.
- **Windows Sandbox** (the feature the current stub's error message mentions)
  is a full utility VM: GB-scale overhead, slow start, awkward host file
  sharing, no clean per-head lifecycle. Rejected for per-head use (by Codex
  too); the stub message should be updated when the backend lands.
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

Nothing in this plan needs a kernel driver. Unlike the Linux and macOS
backends, the *preferred* sandbox mode needs a one-time elevated setup step
(create sandbox users, firewall rules, logon rights) and a small elevated
helper at runtime (`CreateProcessAsUserW` requires privileges the normal user
lacks); a weaker fully-unelevated fallback exists. `hydrad` itself stays
unelevated on every platform.

### Prior art: the Codex Windows sandbox

Codex CLI's platform lineup is Seatbelt on macOS (same substrate as Hydra),
Landlock + seccomp on Linux (different from Hydra's bwrap namespaces + pasta,
but solving the same problem), and on Windows a two-mode native sandbox:

- **Elevated mode (their preferred):** two permanent local users,
  `CodexSandboxOffline` and `CodexSandboxOnline`. Being distinct principals
  gives the filesystem boundary "for free" (the users can only touch what is
  explicitly granted), Windows Firewall deny-outbound rules scoped to the
  offline user's SID give kernel-enforced network-off, and DPAPI secrets
  stay bound to the developer's profile so sandbox users cannot unwrap them.
  Write-allow ACEs are stamped on the workspace + configured writable roots;
  sensitive subpaths (`.git`, `.codex`) get explicit deny-write ACEs; an
  `audit_everyone_writable` check flags directories where the boundary would
  not hold. Execution is a four-layer split: unelevated CLI -> one-time UAC
  setup binary -> long-lived elevated runner accepting spawn requests over
  IPC -> child via `CreateProcessAsUserW` with a restricted token, in a job
  object, on a private desktop (keystroke/clipboard isolation).
- **Unelevated mode (their fallback, and their abandoned first design):** a
  write-restricted token whose restricted-SID list is Everyone + logon
  session + a synthetic `sandbox-write` SID, with ACEs for that SID stamped
  on the workspace. They found ACL stamping slow (filesystem walks before
  commands), semantics hard to evolve, and network isolation weak without
  elevation - which is why elevated mode became the default.
- Documented failure modes worth inheriting: "Log on locally" rights stripped
  by GPO (error 1385), AV intercepting `CreateProcessAsUserW`, corporate
  token-manipulation restrictions, Everyone-writable directories breaking the
  boundary. Their escape hatch on hostile enterprise machines is WSL2 - same
  as this plan's Phase 0.

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
| FS sandbox (writable/masked) | feasible, proven by Codex | sandbox-user principal + ACL grants/denies |
| Config seeding (Binds/ROOverlays) | feasible, shared with macOS | copy + env redirection intent layer |
| Network off | feasible, proven by Codex | per-user firewall deny-outbound |
| Hard network egress | feasible, needs one-time admin | deny-outbound user + loopback CONNECT proxy |
| Per-head /tmp | feasible | per-head `TMP`/`TEMP` env |
| Whole-tree teardown | feasible, better than today | job object `KILL_ON_JOB_CLOSE` |
| HardenGUI | feasible, stronger than Linux | private desktop (Codex does this by default) |
| Secrets masking | partly free | DPAPI already excludes other principals; ACLs for files |
| cow_paths | copy only | no reflink on NTFS; ReFS/Dev Drive block clone where present |
| Seccomp | not needed | restricted token + firewall cover the threat model |
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

### Phase 2: sandbox backend (Codex-style: sandbox users + ACLs + job objects)

Goal: `sandbox.BuildSpec` on Windows returns a real confined spec: a child
run as a dedicated sandbox principal, in a job object, with ACL-enforced
write boundaries. Follow the Codex architecture rather than inventing one.

- [ ] One-time elevated `hydra setup` (a separate small binary, so the main
      harness never elevates): create the local sandbox users, grant logon
      rights, install the per-user firewall rules, register the elevated
      runner. Idempotent; repairs tampered rules on re-run (as Codex does).
- [ ] Elevated runner helper: a long-lived elevated process that accepts
      spawn requests from `hydrad` over authenticated local IPC, validates
      them against policy, and launches children via `CreateProcessAsUserW`
      with the ConPTY handle in the attribute list and a job object with
      `KILL_ON_JOB_CLOSE` (this also upgrades services/previews teardown
      from leader-only kill). This is the one genuinely new architectural
      component versus Linux/macOS.
- [ ] Sandbox principals: Codex uses two shared users (offline/online).
      Hydra runs many heads concurrently, and a shared principal means
      co-tenant heads can terminate each other's processes and read each
      other's worktrees - the cross-head variant of the pkill problem the
      Linux backend already fights. Design: provision a small *pool* of
      sandbox users at setup time (user creation needs elevation, so it
      cannot happen per-spawn) and lease one per head; fall back to the
      shared-user model when the pool is exhausted, documented as a weaker
      boundary. Per-head ACL grants make even the shared-user case
      write-bounded.
- [ ] FS policy: write-restricted-token polarity, same as Linux - reads work
      broadly (system dirs, toolchains, Program Files are world-readable),
      writes only where granted. Stamp write-allow ACEs for the head's
      principal on the worktree, head state dir, per-head temp, and
      `writable_paths`; explicit deny-write ACEs for `masked_paths`-style
      protections inside writable trees (Codex does exactly this for `.git`
      and its config dir). `masked_paths` *read*-masking of secrets is
      partly free (a distinct principal cannot read the developer's profile
      or unwrap DPAPI credentials) and otherwise explicit deny-read ACEs.
      Port Codex's `audit_everyone_writable` idea: warn when Everyone-
      writable directories would let the boundary leak. ACL grants are
      persistent host-visible state, unlike mounts: cleanup on head kill is
      mandatory, and a startup sweep garbage-collects ACEs from crashed
      heads (per-head grants are attributable to the leased principal).
- [ ] Unelevated fallback mode: write-restricted token (restricted-SID list
      of Everyone + logon session + a synthetic per-head SID) with the same
      ACE stamping, for machines where enterprise policy blocks setup.
      Codex tried this first and demoted it (slow ACL walks, weak network
      story) - offer it, but never present it as equivalent; hard egress is
      unavailable in this mode and must fail closed to network-off.
- [ ] Git common-dir write grant (the `GitCommonDir` equivalent of the
      Linux/darwin bind) via the same ACE mechanism.
- [ ] `HardenGUI`: run the child on a private desktop (keystroke/clipboard/
      window isolation) - Codex ships this on by default; kernel-enforced,
      stronger than the Linux env-var approach.
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

### Phase 3: network egress

Goal: the four `network.mode` postures work natively, via the firewall +
user-identity pattern Codex validated (firewall rules scoped to the sandbox
principal's SID), not token capabilities.

- [ ] `off`: run the head as a principal covered by a deny-all-outbound
      firewall rule (installed once by `hydra setup`). Kernel-enforced,
      strictly better than today.
- [ ] `unrestricted` / `advisory`: run as a principal with no deny rule;
      advisory additionally injects the proxy env vars as on Linux.
- [ ] `hard`: deny-all-outbound principal, with the head's proxy env vars
      pointing at the existing CONNECT proxy on 127.0.0.1. Windows Firewall
      does not filter loopback traffic, so the proxy stays reachable while
      every direct dial dies at the kernel, like the nft lock - but this
      loopback exemption is load-bearing and subtle, so validate it
      explicitly on real hardware early (if it proves unreliable, add a
      per-user allow rule for the proxy port). The Go proxy and hostname
      allow-list run unchanged. `allowed_loopback_ports` needs no extra
      work if loopback is open; otherwise they become allow rules.
      Note this couples network mode to the leased principal: pool users
      need their firewall posture set per-lease (rules keyed to the user
      SID, toggled or pre-provisioned per mode at setup time).
- [ ] `DetectHardMode` grows a windows arm (probe: sandbox users + firewall
      rules present and intact?); `internal/heads/egress.go` keeps failing
      closed to network-off until it reports available - and always in
      unelevated-fallback mode.
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
      "Windows Sandbox backend"; the design is sandbox users + restricted
      tokens).
- [ ] End-to-end on real hardware: run `hydra setup`, spawn a head as a
      sandbox user, verify gate/hooks/MCP/status.json, kill/merge cleanup
      (ACEs released, principal returned to the pool, job object gone),
      hard-mode egress blocks a direct dial while the proxy works.
- [ ] CI: windows-latest runner spawn-and-probe test (runners have admin, so
      the elevated setup step works); keep the cross-compile check on Linux
      CI.

## Known can't-do list

1. In-place mount-overlays (bind mounts, overlayfs cow) - no unprivileged
   mounts on Windows. Substitute: copies + env redirects (shared with macOS).
2. The nshost shared-namespace supervisor model - namespaces do not exist.
   Substitute: job objects; nshost stays unported by design.
3. A full-strength sandbox without a one-time elevated setup - creating
   local users, firewall rules, and logon rights all require admin, and
   `CreateProcessAsUserW` requires privileges at runtime. Substitute: the
   unelevated write-restricted-token fallback (weaker, no hard egress -
   Codex reached the same conclusion), or WSL2.
4. Reflink-style CoW on NTFS. Substitute: plain copies, ReFS block clone on
   Dev Drives.
5. Guaranteed operation on locked-down enterprise machines - GPO can strip
   "log on locally" rights, block token manipulation, or AV can intercept
   the runner (all failure modes Codex documents). Substitute: WSL2.

## Rough sizing

Phase 0 is documentation plus a validation pass (a day, needs a Windows+WSL2
machine). Phase 1 is the plumbing bulk (days: ConPTY and the daemon lifecycle
are the two real pieces). Phase 2 is the largest single chunk (a couple of
weeks: the elevated setup binary + runner helper are new architecture, plus
the ACL engine with cleanup and its share of the seeding refactor - do the
macOS seeding intent layer first so Windows only adds a backend). Phase 3 is
small once Phase 2 exists (setup installs the rules; the proxy already does
the hard part). Phase 4 needs Windows hardware or CI runners.

Ordering note: Phases 0 and 1 are independent of the macOS work; Phase 2
should land *after* the macOS Phase 1 seeding refactor to avoid building the
delivery abstraction twice.

## References

- [Building a safe, effective sandbox to enable Codex on Windows](https://openai.com/index/building-codex-windows-sandbox/)
  (OpenAI, May 2026) - design rationale, rejection of AppContainer / Windows
  Sandbox / MIC, elevated vs unelevated modes.
- [Codex Windows sandbox docs](https://developers.openai.com/codex/windows) -
  setup requirements, modes, enterprise caveats, WSL2 fallback guidance.
- [Codex Windows sandbox deep dive](https://codex.danielvaughan.com/2026/05/14/codex-cli-windows-sandbox-engineering-restricted-tokens-acls-elevated-architecture/)
  - restricted tokens, synthetic SIDs, four-layer execution architecture,
  troubleshooting matrix.
- [Codex sandbox investigation](https://simonwillison.net/2025/Nov/9/codex-sandbox-investigation/)
  (Simon Willison) - the Linux (Landlock + seccomp) and macOS (Seatbelt)
  layers for cross-platform context.
