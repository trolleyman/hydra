# Sandbox resource limits (configurable cgroup limits + Settings UI)

Status: **proposed, unbuilt**. This is the design + build order for making the
per-workload systemd-scope cgroup limits configurable per project and editable
from the web Settings UI. The scope-wrapping machinery it builds on is already
shipped (see "What exists today"); this doc is only about making its limits
configurable.

## Motivation

An ungraceful daemon death used to orphan every sandbox (agent, preview, service,
artifact) to `systemd` - they kept running and, in one incident, ~20 orphaned
sandboxes plus a runaway headless Chrome from artifact generation pinned the host
to load 106. We fixed the orphaning (Pdeathsig + process-group kill + transient
systemd scopes + a boot-time scope sweep). Each workload now runs in its own
`hydra[-<kind>]-<id>.scope` cgroup, which also gives us a place to hang CPU/IO/
memory limits so a single runaway workload yields to the daemon and interactive
work instead of starving the box.

Today those limits are two hardcoded package vars. This feature makes the full
set configurable per project, with a Settings UI section.

## Decisions (agreed)

- **Granularity: per-project, one section.** A single "Resource limits" section
  (Project / Local / User layers) applies to *all* of that project's scoped
  workloads - agents, previews, services, artifacts. Not per-agent-type. This
  matches the actual failure mode (total machine load), and keeps the config +
  UI small.
- **Knobs exposed:** CPU weight, IO weight (already applied, currently hardcoded),
  CPU quota (hard cap), memory max (hard cap), tasks max (hard cap).

## What exists today (do not rebuild)

- `internal/sandbox/scope_common.go`
  - `ScopeCPUWeight = 50`, `ScopeIOWeight = 50` - process-global package vars,
    the values this feature replaces with per-project config.
  - `ScopeUnit(kind, id)`, `ScopeHash(s)`, `sanitizeUnit`, `scopeUnitPrefix`.
- `internal/sandbox/scope_linux.go`
  - `ScopesAvailable()` - cached probe. Runs a throwaway scope once *with* the
    weight properties, then *without*, so an undelegated cpu/io controller
    degrades to a bare (reaping-only) scope instead of failing a spawn. Sets
    `scopeOK` and `weightsOK`.
  - `weightProps()` -> `--property=CPUWeight=..`, `--property=IOWeight=..`.
  - `WrapScope(unit string, spec *Spec) bool` - rewrites `spec.Path`/`spec.Args`
    to run under `systemd-run --user --scope --unit=<unit> [props] -- <argv>`.
  - `StopScope(unit)`, `SweepOrphanScopes()`.
- `scope_other.go` - no-op stubs for non-linux.
- Call sites (each already has the workload's project config in scope):
  - agent: `internal/session/registry.go` `Registry.Start` (with an unwrap-and-
    retry fallback if the scoped spawn fails to exec).
  - preview: `internal/preview/spawn.go` `run()` (wrap) + `stopChild()` (StopScope).
  - service: `internal/services/services.go` `buildCmd()` (wrap) + the ctx.Done
    goroutine in `supervise()` (StopScope). Helper `serviceScopeUnit`.
  - artifact: `internal/artifacts/artifacts.go` `generate()` (wrap + `defer StopScope`).
- boot sweep: `internal/cli/runtime.go` `setupRuntime` calls `sandbox.SweepOrphanScopes()`.

## Key tension to resolve first

`WrapScope` takes no project/config context and reads the *global* weight vars,
but **one daemon serves all projects** and the four call sites each belong to a
*different* project's workload. So "per-project limits" cannot be done by setting
global package vars at boot - the limits must be **threaded per call site**.

Resolution: add a `ScopeLimits` value type and change the signature to
`WrapScope(unit string, spec *Spec, limits ScopeLimits) bool`. Each call site
resolves its project's limits from config and passes them. The global
`ScopeCPUWeight`/`ScopeIOWeight` vars become the *defaults* used when a field is
unset, not the source of truth.

## Systemd property mapping + semantics

| Config field | systemd `--property` | Type / format | Default | Notes |
|---|---|---|---|---|
| `cpu_weight` | `CPUWeight=<n>` | int 1-10000 | 50 | Soft; only bites under contention. Below the daemon's 100 so it yields. |
| `io_weight` | `IOWeight=<n>` | int 1-10000 | 50 | Soft, like cpu_weight. Needs a weight-capable IO scheduler. |
| `cpu_quota` | `CPUQuota=<n>%` | int percent (200 = 2 cores) | unset (no cap) | Hard cap even when the box is idle. |
| `memory_max` | `MemoryMax=<n>M` | int MB | unset (no cap) | Hard ceiling; cgroup is OOM-killed past it. |
| `tasks_max` | `TasksMax=<n>` | int | unset (no cap) | Caps processes/threads; guards fork-bomb / PID exhaustion. |

Recommended defaults: **weights on (50/50), hard caps off (unset)**. Hard caps can
break legitimate workloads (an OOM-kill mid-render, a quota that starves a build),
so they should be opt-in. `0`/unset/empty on a field = "don't emit that property".

### Controller-delegation gotcha (important)

`--property` only works if the relevant cgroup v2 controller is delegated to the
user manager:
- `memory` and `pids` are usually delegated by default (so `MemoryMax`/`TasksMax`
  tend to work);
- `cpu` and `io` are frequently **not** delegated by default (so
  `CPUWeight`/`IOWeight`/`CPUQuota` may be rejected).

If `systemd-run` rejects any property, the whole spawn fails. The agent path
retries unscoped, but **previews/services/artifacts currently do not**. So before
emitting hard-cap properties we must not emit a property that will fail.

Fix: extend the probe from a single `weightsOK` bool to **per-property-group
detection**. Probe (once, cached) which of these are accepted, each via a
throwaway `systemd-run ... --property=X -- true`:
- cpu group (`CPUWeight`, `CPUQuota`),
- io group (`IOWeight`),
- memory group (`MemoryMax`),
- pids group (`TasksMax`).

`WrapScope` then emits only the properties whose group probed OK, and logs once
what was dropped. This keeps a missing controller from ever failing a spawn and
avoids needing an unwrap fallback on the three non-agent call sites (though adding
that fallback is still worthwhile defense-in-depth - see "Also worth doing").

## Config schema (backend)

Follow the **top-level scalar precedent**, not the per-agent `SandboxConfig`
(which uses union-merge - wrong for scalars). Precedent to copy: `ArtifactConcurrency`
in `internal/config/config.go` (`Default...` const, `Resolve...()` method,
overwrite-merge in `Config.Merge`, a field in the `rawConfig` decode struct, and
an `emit...` in the TOML renderer).

Add a top-level TOML table `[resources]` -> `Config.Resources *ResourceLimits`:

```toml
[resources]
cpu_weight = 50
io_weight  = 50
cpu_quota  = 200   # percent; 2 cores. omit = no cap
memory_max = 2048  # MB. omit = no cap
tasks_max  = 512   # omit = no cap
```

- New struct `ResourceLimits` with `*int` fields (nil = inherit/unset), so a layer
  can override one field without clobbering the rest.
- `func (c ResourceLimits) Merge(other ResourceLimits)` - per-field last-wins
  (`if other.X != nil { c.X = other.X }`), NOT union. Wire into `Config.Merge`.
- `func (c Config) ResolveResourceLimits() sandbox.ScopeLimits` - fills unset
  fields from the `Default*` consts (weights) / leaves hard caps unset. This is
  the single seam the four call sites use.
- Mirror the fields in the `rawConfig` decode struct and add an `emitResources`
  in the TOML renderer.
- Layering is free: `config.Load` already merges user -> project -> local, so you
  get "user default, project override, local override" with no new machinery.

`sandbox.ScopeLimits` (new, in `internal/sandbox`): plain struct of the five
values (weights as int with the 50 default baked in, caps as `int` where 0 = unset).
Keep `internal/sandbox` free of any `internal/config` import - config resolves
*into* `ScopeLimits`, sandbox never reads config.

## API (openapi + handlers)

- `api/openapi.yaml`: add a `ResourceLimits` object schema and a top-level
  `resources` field on `ConfigResponse` (next to `artifact_concurrency` /
  `test_concurrency`, the existing top-level-scalar precedent).
- Regenerate: `mage generate:go` (`go generate ./internal/api/`) for the Go
  server types, then the openapi-typescript-codegen step from `web/` for the TS
  client (per CLAUDE.md). Produces `web/src/api/models/ResourceLimits.ts` and a
  field on `ConfigResponse.ts`.
- `internal/http/handlers.go`: map the field in `GetConfig` (read) and
  `SaveConfig` (write) bodies, mirroring how `ArtifactConcurrency` is mapped there
  (top-level scalars are handled inline in those two functions, not in
  `toAPIAgentConfig`/`fromAPIAgentConfig`).

## Web Settings UI

- Add a `ResourceLimitsSection` component under `web/src/components/settings/`,
  modelled on `ReviewSection.tsx` (collapsible `SettingSection`, `Row`/`Text`
  layout, an `onChange(next | null)` prop that bubbles up; emit `null` for the
  whole table when every field is empty so an empty `[resources]` isn't written).
- Insert it in `web/src/components/settings/SettingsContent.tsx` as a sibling of
  `ReviewSection` (a per-project section, not per-agent), wired like:
  `onChange={(resources) => setConfig({ ...config, resources: resources ?? undefined })}`.
  Persistence is the existing route-level Save button
  (`api.default.saveConfig(projectId, config, scope)`); there is no per-section save.
- Fields: use the established numeric-input pattern (see `ArtifactsEditor.tsx` /
  `TestsEditor.tsx` / `ConfigForm.tsx`) - `type="number"`, empty string ->
  `undefined` (falls through to default, shown via a `placeholder` like
  `"default (50)"`), clamp with `Math.max`. Add an `InfoTooltip` per field
  explaining weight-vs-quota-vs-max semantics and the "hard caps are opt-in / may
  be ignored if the controller isn't delegated" caveat.
- Show an "effective: X" hint where a value is inherited/unset, matching how
  `ReviewSection` surfaces the resolved config (via the project store's
  resolved-config cache) if we want parity - optional for a first cut.

### UI conventions (must follow)

- No UPPERCASE headings and no `text-transform: uppercase`. Title is
  "Resource limits", field labels sentence-case ("CPU quota", "Memory max").
- ASCII punctuation only - `-` not em/en dashes, `...` not the ellipsis char, in
  both JSX strings and comments.

## Build order

1. **Backend limits plumbing (no UI yet).**
   - Add `sandbox.ScopeLimits` + change `WrapScope(unit, spec, limits)`; update
     `weightProps` -> `allProps(limits)`; extend the probe to per-property-group
     detection; update the four call sites to pass resolved limits (a zero
     `ScopeLimits` = today's behaviour so this step is safe standalone).
   - Add `[resources]` config: struct, `Default*` consts, `Merge`, `Resolve`,
     `rawConfig` decode, `emitResources`. Resolve at each call site.
   - `go build ./...`, `go vet`, `go test ./...`. Verify on the host that a scoped
     workload lands in its cgroup with the expected properties
     (`systemctl --user show hydra-*.scope -p CPUWeight -p MemoryMax ...`).
2. **API surface.** openapi schema + regen + handler mapping. `go build`, confirm
   the TS client has the new model.
3. **Settings UI.** `ResourceLimitsSection` + wire into `SettingsContent`. Confirm
   get/save round-trips and that clearing a field writes no property.

## Also worth doing (adjacent, optional)

- Add the unwrap-and-retry fallback (as the agent path has) to the
  preview/service/artifact call sites, so a scope/property failure never kills a
  workload even if the per-property probe missed an edge case.
- Consider surfacing the resolved effective limits somewhere read-only (e.g. the
  agent page) so it's visible what a workload is actually capped at.

## Testing notes

- Unit-test `ResourceLimits.Merge` (per-field last-wins across layers) and
  `ResolveResourceLimits` (defaults filled, caps left unset) - pure functions, no
  sandbox needed.
- Unit-test `allProps(limits)` (correct `--property` strings, omitted when unset).
- The systemd behaviour (properties actually applied, controller-delegation
  fallback) needs host verification - it can't be exercised from CI or a nested
  sandbox (bwrap needs an unprivileged userns; scopes need a user systemd manager).
