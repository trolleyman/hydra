# macOS support: current state and implementation plan

Status: **partially implemented**. The core Seatbelt backend described under
"What works" is present. Sandboxed heads do not currently launch on macOS: the
supervisor still expects the Linux-only `/tmp/hydra-internal` bind. The phases
below track the remaining runtime-delivery, provider-config, temporary-storage,
hard-network, hardening, and real-hardware validation work.

## Background

Hydra sandboxes heads with bubblewrap on Linux and Seatbelt (`sandbox-exec`) on
macOS. The two backends are selected at compile time via build tags
(`internal/sandbox/linux.go` vs `internal/sandbox/darwin.go`); they share the
`sandbox.Options` struct but implement different subsets of it.

The architectural fact that drives every design choice here: **macOS has no
namespaces and no unprivileged bind mounts**. Anything Linux does by mounting
over a path must become one of:

- a Seatbelt profile rule (allow/deny by path, network rule, mach service,
  signal target),
- a plain file copy (APFS `clonefile` for cheap CoW copies), or
- an env-var redirect so the tool looks at a per-head path instead.

Nothing in this plan needs root, kernel extensions, or system extensions.
`sandbox-exec` is formally deprecated but is the substrate Bazel, Nix, and
Apple's own daemons run on; there is no realistic alternative and it is
de-facto stable through current macOS.

## Current state (audited 2026-07)

What works:

- The whole tree cross-compiles and vets cleanly for `darwin` (arm64 + amd64).
- `internal/sandbox/darwin.go` + `internal/sandbox/profiles/sandbox.sb`
  implement the core FS policy: `writable_paths` / `masked_paths` /
  `restore_ro`, the git common-dir write grant, coarse network on/off,
  `NoSandbox`, and read-only `cow_paths` via APFS clonefile (`cp -c`).
- Daemon, PTY sessions, unix sockets, autostart, and socket paths are all
  portable (`creack/pty`, `//go:build !windows`). The one `/proc` dependency
  (`pidIsHydraDaemon` in `internal/daemon/upgrade.go`) has a documented safe
  fallback. The folder picker has a native `osascript` path.
- Hard-mode egress fails **closed**: `pasta`/`nft` do not exist on macOS, so
  `DetectHardMode` reports unavailable and `internal/heads/egress.go` disables
  the head's network entirely rather than running unfiltered.

What is broken or missing:

- **Config seeding is a silent no-op (the critical gap).**
  `internal/heads/seed.go` delivers per-head agent config via `Options.Binds`
  and `Options.ROOverlays` - the hydra binary at `/tmp/hydra-internal`, the
  gate policy JSON, the MCP catalog, merged `~/.claude.json`, Gemini / Copilot
  / Codex config files, and Claude's tamper-proof
  `/etc/claude-code/managed-settings.json` (hooks + gate wiring). `darwin.go`
  never reads `Binds`, `ROOverlays`, `TmpfsDirs`, `EgressWrap`, `TmpDir`, or
  `HardenGUI`, and returns no error. On a Mac a sandboxed head therefore runs
  with no decision gate, no status hooks, no MCP control server, and the
  user's real `~/.claude.json`.
- No per-head private `/tmp` (`Options.TmpDir` ignored; heads share host
  `/tmp`, the scratch-leak problem Linux fixed).
- No hard-mode network filtering (only global on/off; advisory mode works).
- No seccomp equivalent, no `HardenGUI`, writable CoW clones skipped.
- Latent nit: `paths.ComparePaths` is case-sensitive on darwin but APFS is
  case-insensitive by default.
- Stale comments in `darwin.go` and `defaults.go` reference a `sandbox-demo/`
  directory that is not in the repo or its history.
- Never validated on real hardware.

## Feasibility summary

| Feature | Verdict | macOS mechanism |
|---|---|---|
| FS sandbox (writable/masked/restore_ro) | done | Seatbelt allow/deny |
| Config seeding (Binds/ROOverlays) | feasible, biggest job | copy + env redirection |
| Hard network egress | feasible, simpler than Linux | Seatbelt loopback-only + existing CONNECT proxy |
| Per-head /tmp | ~90% | `TMPDIR` + optional Seatbelt deny on `/tmp` |
| Seccomp | not needed | threats are Linux-specific or Seatbelt-covered |
| HardenGUI | feasible, stronger than Linux | mach-service + signal rules |
| cow_paths | half done | clonefile; in-place overlays impossible |
| pkill self-kill protection | feasible | Seatbelt `signal` operation |

## Target runtime layout

macOS cannot give each unprivileged process a different mount at `/tmp`, but it
can enforce the same visibility and integrity boundaries with real host paths
and Seatbelt rules. Hydra uses three classes of runtime state:

```text
<hydra-state>/
  runtime/<build-id>/hydra-internal       shared, immutable
  projects/<project>/tmp/<head-id>/       per-head, writable
  projects/<project>/seed/<head-id>/      per-head, immutable inputs
```

- `runtime/<build-id>/hydra-internal` is staged once per Hydra build and shared
  by every head using that build. A build-addressed path is never replaced in
  place, so a head created by an older daemon keeps invoking the matching
  binary after an update. Seatbelt grants reads and explicitly denies writes.
- `tmp/<head-id>` is the existing mode-0700 head scratch directory. Darwin sets
  `TMPDIR`, `TMP`, and `TEMP` to its real path, grants that path read/write, and
  denies both reads and writes to shared `/tmp`, `/private/tmp`, and unrelated
  user temporary storage. The generated pre-prompt names `$TMPDIR` and its real
  path so agents do not assume `/tmp` is usable. Random path names are not the
  security boundary; the Seatbelt policy is.
- `seed/<head-id>` contains immutable inputs whose contents or paths vary by
  head: gate policy, MCP catalog, strict MCP configuration, provider settings,
  hooks, and instructions. Every file is readable but protected by a late
  `deny file-write*` rule.

Only byte-identical immutable inputs are shared. Gate policy, approvals, status,
provider configuration containing worktree/head details, pre-spawn environment,
conversation state, and scratch storage remain per-head. Other generated files
may later use content-addressed deduplication, but correctness does not depend on
that optimization. Credentials should be narrowly exposed read-only where a
provider permits it rather than copied into every head.

Linux keeps its existing view: the private host scratch directory is mounted at
`/tmp`, and the shared Hydra runtime is bound read-only at
`/tmp/hydra-internal`. Platform-neutral seeding therefore produces delivery
intents/roles; the Linux materializer turns them into binds and overlays, while
the Darwin materializer returns protected real paths plus provider redirects.

## Plan

### Phase 1: fail loudly + config seeding (the bulk of the work)

Goal: a sandboxed macOS head gets the same gate/hooks/MCP wiring as Linux, and
any option the darwin backend cannot honor is a spawn-time error instead of a
silent downgrade.

- [ ] `darwin.go`: return an explicit error for any populated option it does
      not implement (`Binds`, `ROOverlays`, `TmpfsDirs`) until each gains a
      darwin path. Silent security-relevant no-ops are the worst option.
- [ ] Introduce a per-OS delivery strategy in `internal/heads/seed.go`.
      Today it unconditionally emits `Bind`/`ROOverlay` structs (mount-over
      semantics). Refactor to an intent layer ("deliver file X for role Y with
      mutability Z") with two backends:
      - Linux: bind mounts, unchanged behavior.
      - Darwin: write head-specific inputs beneath `seed/<head-id>`, use the
        shared build-addressed Hydra binary, add explicit read-only Seatbelt
        rules, and redirect the agent to real paths:
        - `~/.claude.json` + `~/.claude` -> `CLAUDE_CONFIG_DIR`.
        - Gemini system prompt already uses `GEMINI_SYSTEM_MD` (a redirect,
          not a bind) - works today; Gemini `settings.json` needs the same
          treatment or a fallback.
        - Hydra binary: shared immutable `runtime/<build-id>/hydra-internal`
          instead of fixed `/tmp/hydra-internal`; the pre-prompt and every
          generated hook/MCP entry receive the materialized path.
        - Gate policy JSON + MCP catalog: per-head paths passed via the env
          vars / settings the hooks already read.
        - Codex: per-head `CODEX_HOME` containing merged `AGENTS.md`,
          `hooks.json`, and `config.toml`, with credential/session material
          exposed separately according to the CLI's supported path controls.
        - Copilot: use its supported config/instruction redirect, or fail the
          spawn explicitly until one is available.
- [ ] Managed settings substitute. The macOS managed-settings location is a
      root-owned system path, so per-head files there are impossible. Instead:
      seed the identical hooks/gate config as ordinary user settings inside
      the redirected `CLAUDE_CONFIG_DIR`, then add a Seatbelt
      `deny file-write*` rule on that file. Same tamper-proofing (the kernel
      refuses the write), delivered at a different settings-precedence layer.
      Copilot / Codex configs seed the same way (copy into redirected or real
      dot-dirs, Seatbelt-deny writes where tampering matters).
- [ ] Delete the stale `sandbox-demo/` comment references while in there.

### Phase 2: hard network egress

Goal: `network.mode = "hard"` works on macOS instead of degrading to
network-off.

- [ ] Seatbelt profile: `(deny network*)` plus allow rules for loopback to the
      egress proxy port only. The existing Go CONNECT proxy
      (`internal/egress/proxy.go`) runs unchanged; proxy env vars are injected
      as on Linux. Non-proxy-aware traffic fails at the kernel, exactly like
      the nft lock. Hostname filtering already lives in the proxy on both
      platforms.
- [ ] `network.allowed_loopback_ports` maps to additional loopback allow
      rules (simpler than pasta's `-T` splicing on Linux).
- [ ] Decide DNS posture: with CONNECT-by-hostname the sandbox needs no
      direct DNS, but macOS resolution flows through the `mDNSResponder` unix
      socket - allow it (resolution is not egress) or deny for strictness.
- [ ] `DetectHardMode` grows a darwin arm that reports available (no external
      tools needed); `internal/heads/egress.go` stops forcing `EgressOff`.
- [ ] Note the port-pinning invariant from Linux does not apply (no netns
      bakes a port), but keeping the pinned-port behavior is harmless and
      consistent.

### Phase 3: /tmp, hardening, CoW

- [ ] Per-head temporary storage: honor `Options.TmpDir` by setting `TMPDIR`,
      `TMP`, and `TEMP` to the real per-head directory. Deny both reads and
      writes to shared `/tmp`, `/private/tmp`, and unrelated user temporary
      storage, then grant the head directory read/write. Persist `$HYDRA_ENV`
      there so sibling sandboxed shells receive the pre-spawn environment.
      Add the resolved path to the generated pre-prompt. Programs that hardcode
      `/tmp` need a targeted redirect or an explicit unsupported diagnostic;
      unprivileged macOS has no mechanism that can give them a private mount at
      that literal path.
- [ ] `HardenGUI`: same env unsets as Linux; instead of hiding socket paths,
      deny mach-lookup on WindowServer / pasteboard services (how macOS GUI
      access actually flows).
- [ ] pkill self-kill: Seatbelt `signal` operation with target scoping gives a
      kernel-level fix that Linux only approximates via the decision gate.
- [ ] Writable CoW clones: enable the currently-skipped writable variant -
      APFS clones are block-level CoW and writable by nature, and cow writes
      are per-head and discarded, so no mirror-back is needed. In-place
      overlays over real host paths (`~/.gradle`) stay impossible without
      mounts: handle per-tool via env redirects (`GRADLE_USER_HOME`) or
      document the limitation.
- [ ] Seccomp: do **not** port. The Linux blocklist
      (`internal/sandbox/seccomp/seccomp-gen.c`) targets mount/userns escapes,
      `open_by_handle_at`, kernel modules, kexec, keyring, eBPF - all either
      Linux-only surface or already root/entitlement-gated on macOS. Seatbelt
      is itself the syscall-level MAC layer. Document the mapping instead.
- [ ] `paths.ComparePaths`: treat darwin as case-insensitive like Windows (or
      probe the filesystem), to match APFS defaults.

### Phase 4: validation

- [ ] End-to-end on real hardware: spawn a head, verify the Seatbelt profile
      compiles, hooks fire, gate blocks, MCP tools respond, status.json updates,
      merge works, and two simultaneous heads cannot read each other's temp or
      seed files.
- [ ] Verify hard egress permits allow-listed proxy traffic and configured
      loopback ports while direct sockets, DNS bypasses, and blocked hosts fail.
- [ ] Verify the staged Hydra binary and every seeded policy/config file remain
      readable but cannot be modified, renamed, or replaced by the head.
- [ ] Verify spawn/resume, sandboxed bash tabs, review agents, tests, artifacts,
      teardown, and daemon restart with both the current and one older staged
      runtime still referenced by a live head.
- [ ] CI: GitHub Actions macOS runners permit `sandbox-exec`, so an automated
      spawn-and-probe test is viable without dedicated hardware. At minimum,
      keep a `GOOS=darwin go build ./... && go vet` cross-compile check on
      Linux CI.

## Known can't-do list

Only two true "no" answers, both with substitutes:

1. A private filesystem at the literal path `/tmp`, and in-place mount-overlays
   (cow or otherwise) over real host paths - no unprivileged mounts. Substitute:
   a protected per-head `$TMPDIR` and env redirects per tool.
2. Per-head files at the literal managed-settings system path - root-owned.
   Substitute: user-level settings made read-only by Seatbelt.

## Rough sizing

Phase 1 is the bulk (days - it is a refactor of the seeding abstraction, not
research). Phases 2 and 3 are each small (hours to a day per item). Phase 4
needs a Mac for the first pass, then CI carries it.
