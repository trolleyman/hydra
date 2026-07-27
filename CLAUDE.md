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

### Tooltips: two variants, one engine

All tooltips go through `web/src/components/Tooltip.tsx`. There are exactly two
variants, and the choice is about the *job*, not the look:

- `variant="hint"` (default) - a short label for a control that has no visible
  text. Compact, 600ms delay, non-interactive.
- `variant="card"` - an explainer you are meant to read. Roomy, opens instantly,
  you can put the pointer inside it, click pins it open. Reach for it via the
  `InfoTooltip` preset (the `i` trigger next to a section heading).

Both share one surface (light in light mode, dark in dark mode) so they read as
one family.

Do **not** add a native `title=` to an interactive control (`<button>`, `<a>`,
a control `<label>`, a clickable `<div>`/`<span>`) - use `<Tooltip>`. Native
`title` renders unstyled OS chrome with an uncontrollable delay and no dark
mode, and mixing it with `Tooltip` next to it is what made the UI look like it
had three tooltip systems.

Native `title=` is still correct for three cases:

1. **Revealing text that is visually truncated** on a plain, non-interactive
   `<span>`/`<div>` (file paths, branch names, messages). Those live in long
   lists, and a portal-mounting React component per row is a real perf
   regression - see the per-row memoisation work in `AgentChat.tsx` /
   `CaseTree.tsx`.
2. **Anything rendered once per row** of a long list, interactive or not - the
   same perf reason. The line-number gutter in `RepositoryView.tsx` renders per
   source line; `CaseTree`'s copy/open buttons render per case.
3. **Drag handles** (`lib/ResizeHandle.tsx` and its callers). `Tooltip` anchors
   the box when it opens and only recomputes on scroll / window-resize / box
   resize - none of which a drag fires - so a tip opened during the pre-drag
   hover detaches and hangs stranded over the content being resized. The browser
   suppresses a native `title` once a drag starts.

A native `title` is not only the `title=` attribute: an SVG `<title>` child is
the same OS tooltip. `@icons-pack/react-simple-icons` marks (`SiGithub`,
`SiGitlab`, via `ProviderIcon`) render one by DEFAULT, so an icon dropped inside
a `<Tooltip>` double-tips - pass `title=""` to suppress it (see `ProviderIcon`).
Grep for `title=` alone will miss these; check for brand-icon components too.

Keep a card's body short enough to fit a phone screen. The card caps its height
against the viewport and scrolls, but a card you have to scroll is a sign the
content belongs in `docs/` with a pointer from the tooltip.

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
- **Improving the diff viewer rendering** (word/intra-line diff, moved-block
  detection, histogram algorithm, function-context headers, semantic/AST diff) ->
  [docs/diff-viewer-improvements.md](docs/diff-viewer-improvements.md) (survey +
  ranked plan; character-level word diff, histogram, funcname headers,
  similarity pairing and edit-boundary sliding are built; moved-block detection
  and whitespace-row dimming were tried and reverted - see the doc)
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
- **Working on the security gate / egress / MCP governance** (`internal/gate`,
  `internal/egress`, MCP stripping, the `--dangerously-skip-permissions` posture)
  -> [docs/security-audit.md](docs/security-audit.md) (the original sandbox audit;
  its three main recommendations - gate, MCP allow-list, filtering egress proxy -
  are now BUILT for Claude)
- **User-checkoutable head branches** (the `hydra/<id>` vs `hydra-wt/<id>`
  branch-split + ff-only mirror design) ->
  [docs/user-branch-mirror.md](docs/user-branch-mirror.md) (proposed, unbuilt
  design; only the `internal/git/branch.go` naming step is done)

The open backlog (ideas/gaps not yet built) lives in
[docs/roadmap.md](docs/roadmap.md).
