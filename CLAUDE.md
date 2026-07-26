# Guidelines for Hydra

Hydra is an AI orchestration platform for managing autonomous agents (Heads).

## Project Structure

- `main.go`: Entry point for the CLI.
- `internal/`: Core logic (OS sandboxing, Git, heads management, daemon).
- `api/`: OpenAPI definitions.
- `web/`: React + TypeScript frontend.
- `magefiles/`: Build automation scripts.

## Building and Running

Use `mage` for development tasks.

- `mage build`: Build both Go backend and TypeScript frontend.
- `mage buildGoDeps && go run ./`: Build + run hydra (add commands after ./ as needed)
- `mage run`: Build dependencies and run the server.
- `mage tidy`: Run `go mod tidy`, `go fmt`, and `errtrace`.

## Development Workflow

1.  **Backend**: Go 1.22+ is used. Follow standard Go idioms.
2.  **Frontend**: React + TypeScript + Vite. Uses `npm` (or `aube`, if on PATH) for
    package management against `web/package-lock.json`. Build scripts under
    `web/scripts/` and `web/e2e/` run directly with `node` (Node 24+ strips the TS
    types), not a separate TS runner.

    **Expected `aube install` warnings (all benign - do not "fix" them):**
    - `WARN_AUBE_GVS_INCOMPATIBLE` for `vite`: vite can't use aube's global
      virtual store, so it installs per-project. Upstream vite limitation; install
      still succeeds.
    - `WARN_AUBE_IGNORED_BUILD_SCRIPTS` for `@swc/core` / `esbuild`: aube skips
      their postinstall build scripts by default. Both ship prebuilt binaries and
      work fine without them; run `aube approve-builds` only if you deliberately
      want to enable them.
3.  **API**: Define API changes in `api/openapi.yaml` and run `mage generate:go` to update server stubs.

## Conventions

### ASCII punctuation only

Do **not** use fancy Unicode punctuation in source, UI strings, or comments. Use
plain ASCII: a hyphen `-` instead of an em dash `—` or en dash `–`, and three dots
`...` instead of the ellipsis character `…`. This applies everywhere: rendered
user-facing text (JSX / string literals) *and* code comments. Decorative status
glyphs already in use (`✓ ⚠ ✗ ▸ │`) are fine; this rule is specifically about dashes
and ellipses.

### No UPPERCASE headings in the UI

Do **not** render headings, section labels, or titles in the web UI as all-caps.
Write them in normal sentence/title case (e.g. "Review controls", not "REVIEW
CONTROLS"). This covers both capitalised string literals *and* CSS - do not reach
for `text-transform: uppercase` to get the uppercase look either.

### No raw control bytes in source

Never embed raw control characters (NUL etc.) in source files - a single raw NUL
makes `grep` treat the whole file as binary and silently match nothing. Use escape
sequences instead (e.g. `'\0'` as a collision-proof string-key separator, as in
`web/src/lib/testCases.ts` and `ArtifactsPanel.tsx`).

## Testing

Run tests using standard Go tools:
```bash
go test ./...
```

## Deeper docs - read on demand

These cover subsystem internals. Read the relevant one **before** working in that
area; do not re-derive it by reading source. Skip them otherwise.

- **Touching the agent page / diff viewer** (`AgentDetail.tsx`, `DiffViewer.tsx`,
  sticky headers, per-agent view state, preview proxy) -> [docs/web-agent-page.md](docs/web-agent-page.md)
- **Touching the test gate** (`internal/tests`, tests panel, `[tests.<name>]`
  runners, JUnit / Hydra-JSON / streaming markers, warnings) -> [docs/testing.md](docs/testing.md)
- **Adding a screenshot or artifact** (or working on `take-screenshots.ts` /
  `internal/artifacts`) -> [docs/screenshots.md](docs/screenshots.md); the
  user-facing artifacts feature is [docs/artifacts.md](docs/artifacts.md)
- **Working on macOS/darwin support** (`internal/sandbox/darwin.go`, Seatbelt
  profile, config seeding on macOS) -> [docs/macos-support.md](docs/macos-support.md)
  (audit of the darwin backend + phased implementation plan)
- **Working on Windows support** (`internal/sandbox/windows.go` and the other
  `*_windows.go` stubs, ConPTY, AppContainer, WSL2) ->
  [docs/windows-support.md](docs/windows-support.md) (audit of the Windows
  stubs + phased implementation plan)
- **Improving the diff review workflow** (per-file "viewed" state, "reviewed up
  to" marker) -> [docs/diff-review-state.md](docs/diff-review-state.md) (proposed,
  unbuilt design + build order)
- **Working on an existing PR/MR** (adopting someone else's PR as a head,
  fetching a PR head, pushing back to a fork, `internal/forge` enumeration) ->
  [docs/pr-adoption.md](docs/pr-adoption.md) (proposed, unbuilt design + build
  order; the built outbound publish flow is NON_LOCAL_INTEGRATION.md)
- **Sandbox scope cgroup limits** (CPU/IO weight, CPU quota, memory max, tasks
  max via the `[resources]` config table + the Settings "Resource limits" section)
  -> [docs/sandbox-resource-limits.md](docs/sandbox-resource-limits.md) (BUILT;
  `sandbox.ScopeLimits` + `WrapScope(unit, spec, limits)`, per-controller
  delegation probe, `config.ResolveResourceLimits`)
- **The built-in chat project** (the always-present "just chatting" project,
  `_chat`, project selection on boot, `ProjectInfo.Builtin`) ->
  [docs/chat-project.md](docs/chat-project.md) (BUILT;
  `projects.EnsureChatProject` + `HasUserProjects`, the reserved-ID rule, why a
  worktree-less head does not work, the project-icon traps)
