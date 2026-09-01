# macOS support: current state and implementation plan

Status: **partially implemented**. The core Seatbelt backend, shared
build-addressed Hydra runtime, private temporary storage, mount-free Claude and
Codex configuration delivery, and Seatbelt hard egress described under "What
works" are present. Codex passes its first real-hardware head spawn;
Claude still needs the same end-to-end validation. Gemini and Copilot need
provider-specific redirects and fail explicitly at sandbox construction instead
of running without their seeded policy. The phases below track the remaining
provider-config, hardcoded-`/tmp` compatibility, and validation work.

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

## Current state (audited 2026-09)

What works:

- The whole tree cross-compiles and vets cleanly for `darwin` (arm64 + amd64).
- `internal/sandbox/darwin.go` + `internal/sandbox/profiles/sandbox.sb`
  implement the core FS policy: `writable_paths` / `masked_paths` /
  `restore_ro`, the git common-dir write grant, coarse network on/off,
  `NoSandbox`, and read-only `cow_paths` via APFS clonefile (`cp -c`).
- The running Hydra executable is content-addressed and staged once beneath
  `<hydra-state>/runtime/<sha256>/hydra-internal`. Supervisors, generated hooks,
  and MCP entries use that real path on Darwin; an explicit immutable-path
  Seatbelt rule denies writes. Linux retains its read-only bind at
  `/tmp/hydra-internal`.
- Each head has private temporary storage. Darwin points `TMPDIR`, `TMP`, and
  `TEMP` at the head's real scratch path, tells the agent that path in its
  pre-prompt, persists the pre-spawn environment there for sibling shells, and
  denies the shared `/tmp` and user temp roots. A narrow later rule exposes the
  head's own scratch directory and its random Hydra supervisor socket directory.
  Literal ancestors receive metadata-only access so path-canonicalizing tools
  such as Git and SQLite work without exposing directory listings or sibling
  scratch data.
- Codex uses a persistent per-head `CODEX_HOME` beneath the project state. Hydra
  writes merged `AGENTS.md`, `hooks.json`, and `config.toml` there atomically and
  Seatbelt makes those exact files immutable while leaving provider-owned state
  writable. Gate policy and MCP catalog inputs use real immutable paths beneath
  `seed/<head-id>`. A file-based `auth.json` is copied once with mode 0600 so
  Codex can refresh it per head; macOS keychain authentication remains available.
  Static `skills`, `plugins`, `prompts`, and `rules` directories are shared by
  read-only links to the user's original `CODEX_HOME`.
- Claude uses a persistent per-head `CLAUDE_CONFIG_DIR` beneath the same provider
  state root. Its process working directory remains the head worktree; only its
  configuration, cache, and transcript root is redirected. Hydra merges the
  user's settings into an immutable generated `settings.json`, limits Claude to
  that user settings scope so project-local `disableAllHooks` cannot suppress
  the gate, and always launches with a separate immutable strict MCP config.
  The writable `.claude.json` is re-sanitized before each launch so Claude can
  preserve its own state without retaining an unapproved MCP server. File auth
  is copied once, macOS Keychain auth remains available, static user extensions
  are linked read-only, and an existing worktree transcript is APFS-cloned into
  the per-head directory on first launch. Spawn, resume, chat transcript import,
  shell-cwd tracking, review slots, and purge all resolve the redirected path.
- Daemon, PTY sessions, unix sockets, autostart, and socket paths are all
  portable (`creack/pty`, `//go:build !windows`). The one `/proc` dependency
  (`pidIsHydraDaemon` in `internal/daemon/upgrade.go`) has a documented safe
  fallback. The folder picker has a native `osascript` path.
- Hard-mode egress uses the existing host-side filtering CONNECT proxy plus a
  Seatbelt rule that denies all IP egress except TCP to that one random
  loopback proxy port and `allowed_loopback_ports`. The sandbox needs no direct
  DNS route because CONNECT hostnames are resolved by the host-side proxy;
  access to the local `mDNSResponder` Unix socket is harmless and remains
  available. IP listeners are restricted to loopback, except a one-shot
  runner's explicit inbound service port. The proxy port stays pinned for a
  supervisor's lifetime because its Seatbelt profile is baked at first launch,
  matching Linux's invariant.

What is broken or missing:

- **Gemini and Copilot config seeding is not implemented.**
  `internal/heads/seed.go` still delivers their settings, hooks, instructions,
  and related generated inputs through `Options.Binds` or files inside the
  writable worktree. The mount inputs still need path redirects and the
  worktree-owned inputs need immutable native substitutes. The Darwin backend
  rejects remaining
  `Binds`, `ROOverlays`, and `TmpfsDirs`, so these providers stop with a clear
  mount-input error instead of running with no decision gate, status hooks, or
  MCP control server. Claude and Codex emit no mount inputs on Darwin. GUI
  hardening is implemented independently of the remaining
  provider redirects and still needs the real-hardware probes described below.
- Programs that open the literal `/tmp` instead of honoring `TMPDIR` cannot use
  the private scratch path; shared `/tmp` is deliberately inaccessible.
- Hard-mode network filtering passes its real-hardware loopback enforcement
  probe: the pinned proxy port succeeds while another live loopback port is
  denied. Direct non-loopback and full provider traffic remain part of the
  end-to-end head validation.
- Provider-specific GUI automation is blocked by Mach-service denies and GUI
  environment removal, but still needs a real `pbpaste` / AppleScript probe.
- Writable APFS CoW clones work when the destination can be populated as a
  private directory; in-place overlays over existing absolute/home paths remain
  impossible. Seccomp deliberately has no macOS port because its blocked syscall
  surface is Linux-specific.
- The immutable-input and hard-egress Seatbelt probes pass on real macOS
  hardware (2026-09-02). Full head lifecycle validation remains.

## Feasibility summary

| Feature | Verdict | macOS mechanism |
|---|---|---|
| FS sandbox (writable/masked/restore_ro) | done | Seatbelt allow/deny |
| Codex config seeding | implemented, first spawn validated | per-head `CODEX_HOME` + immutable files |
| Claude config seeding | implemented, needs E2E validation | per-head `CLAUDE_CONFIG_DIR` + immutable settings/MCP |
| Other provider seeding | feasible, biggest remaining provider job | copy + env redirection |
| Hard network egress | implemented, needs E2E validation | Seatbelt loopback-only + existing CONNECT proxy |
| Per-head temporary storage | done for standard temp APIs | `TMPDIR` + Seatbelt deny on shared temp roots |
| Seccomp | not needed | threats are Linux-specific or Seatbelt-covered |
| HardenGUI | implemented, needs E2E validation | mach-service denies + env removal |
| cow_paths | partial by platform limit | writable clonefile copy; in-place overlays impossible |
| pkill self-kill protection | implemented, needs E2E validation | Seatbelt target-scoped `signal` rules |

## Target runtime layout

macOS cannot give each unprivileged process a different mount at `/tmp`, but it
can enforce the same visibility and integrity boundaries with real host paths
and Seatbelt rules. Hydra uses three classes of runtime state:

```text
<hydra-state>/
  runtime/<build-id>/hydra-internal       shared, immutable
  projects/<project>/tmp/<head-id>/       per-head, writable
  projects/<project>/seed/<head-id>/      per-head, immutable inputs
  projects/<project>/providers/<head-id>/ per-head, persistent Claude/Codex state
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
- `providers/<head-id>` contains provider-owned state that must survive a
  stop/resume. Claude and Codex each receive a redirected provider home beneath
  it: session/auth state is writable, while generated policy-bearing files
  receive later immutable-path denies. The provider root changes; the agent's
  process cwd does not and remains its worktree. State survives archive and is
  removed on permanent purge.

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

- [x] `darwin.go`: return an explicit error for any populated option it does
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
        - [x] Claude: per-head `CLAUDE_CONFIG_DIR`; immutable merged user
          settings and strict MCP input; writable re-sanitized `.claude.json`;
          one-time file-auth copy; Keychain auth; shared static extensions;
          legacy transcript clone; redirected transcript consumers. Project and
          local settings scopes are excluded because macOS has no unprivileged
          managed-settings tier that they cannot override.
        - Gemini system prompt already uses `GEMINI_SYSTEM_MD` (a redirect,
          not a bind) - works today; Gemini `settings.json` needs the same
          treatment or a fallback.
        - Hydra binary: shared immutable `runtime/<build-id>/hydra-internal`
          instead of fixed `/tmp/hydra-internal`; the pre-prompt and every
          generated hook/MCP entry receive the materialized path.
        - Gate policy JSON + MCP catalog: per-head paths passed via the env
          vars / settings the hooks already read.
        - [x] Codex: per-head `CODEX_HOME` containing merged `AGENTS.md`,
          `hooks.json`, and `config.toml`; persistent writable provider state;
          one-time file-auth copy; shared static extension links; original
          `CODEX_HOME` read-only.
        - Copilot: use its supported config/instruction redirect, or fail the
          spawn explicitly until one is available.
- [x] Stage the running Hydra executable once per content hash under the runtime
      state directory; pass its materialized path through supervisor options,
      generated hooks, and MCP configs; protect it with a Darwin immutable-path
      rule. Canonicalize `/tmp` and `/var` aliases before emitting Seatbelt path
      rules so the kernel-visible `/private/...` path is actually matched.
- [x] Claude managed settings substitute. The macOS managed-settings location is a
      root-owned system path, so per-head files there are impossible. Instead:
      seed the identical hooks/gate config as ordinary user settings inside
      the redirected `CLAUDE_CONFIG_DIR`, then add a Seatbelt
      `deny file-write*` rule on that file and launch with only the generated
      user settings source. The kernel refuses writes and no lower project/local
      settings scope is loaded, so `disableAllHooks` cannot override it. Codex
      uses the equivalent immutable redirected config. Copilot still needs its
      provider-specific substitute.
- [x] Delete the stale `sandbox-demo/` comment references.

### Phase 2: hard network egress

Goal: `network.mode = "hard"` works on macOS instead of degrading to
network-off.

- [x] Seatbelt profile: deny IP egress plus allow rules for loopback to the
      egress proxy port only. The existing Go CONNECT proxy
      (`internal/egress/proxy.go`) runs unchanged; proxy env vars are injected
      as on Linux. Non-proxy-aware traffic fails at the kernel, exactly like
      the nft lock. Hostname filtering already lives in the proxy on both
      platforms.
- [x] `network.allowed_loopback_ports` maps to additional loopback allow
      rules (simpler than pasta's `-T` splicing on Linux).
- [x] DNS posture: deny every direct IP route but leave the local
      `mDNSResponder` Unix socket available. Resolution is not egress, and the
      proxy independently resolves CONNECT hostnames.
- [x] The platform boundary abstraction reports Darwin hard mode available
      without external tools; heads and one-shot runner commands use it instead
      of forcing `EgressOff`.
- [x] Keep the proxy port pinned for the supervisor lifetime. Darwin's Seatbelt
      profile bakes that port just as Linux's nft rule does.
- [x] Run the real-hardware enforcement probe: allowed proxy port succeeds,
      another listening loopback port fails, and direct non-loopback sockets
      have no matching allow rule. The executable probe covers both live
      loopback ports; full provider traffic is checked during end-to-end spawn.

### Phase 3: /tmp, hardening, CoW

- [x] Per-head temporary storage: honor `Options.TmpDir` by setting `TMPDIR`,
      `TMP`, and `TEMP` to the real per-head directory. Deny both reads and
      writes to shared `/tmp`, `/private/tmp`, and unrelated user temporary
      storage, then grant the head directory read/write. Persist `$HYDRA_ENV`
      there so sibling sandboxed shells receive the pre-spawn environment. Add
      the resolved path to the generated pre-prompt. Hydra's random supervisor
      socket directory is the only narrow exception beneath the denied host
      temp root.
- [ ] Programs that hardcode `/tmp` need a targeted redirect or an explicit
      unsupported diagnostic; unprivileged macOS has no mechanism that can give
      them a private mount at that literal path.
- [x] `HardenGUI`: same env unsets as Linux; instead of hiding socket paths,
      deny mach-lookup on WindowServer / pasteboard services (how macOS GUI
      access actually flows).
- [x] pkill self-kill: Seatbelt `signal` operation with target scoping gives a
      kernel-level fix that Linux only approximates via the decision gate.
- [x] Writable CoW clones: APFS clonefile copies are writable, private, retained
      across resume, and never mirrored back when Hydra can populate a distinct
      destination directory.
- [ ] In-place overlays over real host paths (`~/.gradle`) remain impossible
      without mounts: handle per-tool via env redirects (`GRADLE_USER_HOME`) or
      document the limitation.
- [ ] Seccomp: do **not** port. The Linux blocklist
      (`internal/sandbox/seccomp/seccomp-gen.c`) targets mount/userns escapes,
      `open_by_handle_at`, kernel modules, kexec, keyring, eBPF - all either
      Linux-only surface or already root/entitlement-gated on macOS. Seatbelt
      is itself the syscall-level MAC layer. Document the mapping instead.
- [x] `paths.ComparePaths`: treat darwin as case-insensitive like Windows (or
      probe the filesystem), to match APFS defaults.

### Phase 4: validation

- [ ] End-to-end on real hardware: spawn a head, verify the Seatbelt profile
      compiles, hooks fire, gate blocks, MCP tools respond, status.json updates,
      merge works, and two simultaneous heads cannot read each other's temp or
      seed files.
- [ ] Verify hard egress permits allow-listed proxy traffic and configured
      loopback ports while direct sockets, DNS bypasses, and blocked hosts fail.
- [ ] Verify the staged Hydra binary and every seeded policy/config file remain
      readable but cannot be modified, renamed, or replaced by the head. The
      standalone immutable-file Seatbelt probe passes; the full seeded set still
      needs an in-head check.
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
