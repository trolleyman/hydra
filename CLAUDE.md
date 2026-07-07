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
2.  **Frontend**: React + TypeScript + Vite. Uses `bun` for package management.
3.  **API**: Define API changes in `api/openapi.yaml` and run `mage generate:go` to update server stubs.

## Conventions

### ASCII punctuation only

Do **not** use fancy Unicode punctuation in source, UI strings, or comments. Use
plain ASCII: a hyphen `-` instead of an em dash `—` or en dash `–`, and three dots
`...` instead of the ellipsis character `…`. This applies everywhere: rendered
user-facing text (JSX / string literals) *and* code comments. Decorative status
glyphs already in use (`✓ ⚠ ✗ ▸ │`) are fine; this rule is specifically about dashes
and ellipses.

### No raw control bytes in source

Never embed raw control characters (NUL etc.) in source files - a single raw NUL
makes `grep` treat the whole file as binary and silently match nothing. Use escape
sequences instead (e.g. `'\0'` as a collision-proof string-key separator, as in
`web/src/lib/testCases.ts` and `ArtifactsPanel.tsx`).

## Web UI internals - agent page layout

Facts that matter when touching the agent page (`web/src/components/AgentDetail.tsx`
and `web/src/DiffViewer.tsx`):

- `AgentDetail.tsx` has **two render paths**, each with its own `[data-main-scroll]`
  scroll container: the active-agent page (metadata `SeparatedRow` -> `PromptBlock` ->
  `AgentTerminal` -> `DiffViewer`, with `AgentTopBar` as a non-scrolling header above)
  and a simpler archived-agent view. Layout changes must handle both.
- `DiffViewer.tsx` renders, in order: the sticky "Changes" toolbar (`LeftSelector` =
  base ref, `RightSelector` = head/target ref - both component-local `useState`,
  never lifted; stats, refresh, settings cog), then `TestsPanel` -> `PreviewPanel` ->
  `ArtifactsPanel`, then the file-list column + file diffs. Tests and previews wrap
  in `CollapsibleCard` (which fully unmounts its body ~200ms after collapse);
  `ArtifactsPanel` has no outer card but renders one `CollapsibleCard` per artifact
  set (each set's files in a masonry grid). The agent-page
  `ArtifactsPanel` is two-sided (base+head refs); `RepositoryArtifactsView` is the
  single-ref sibling used by the repository browser.
- Sticky-header coordination: `DiffViewer` publishes `--sticky-changes-h` via a
  ResizeObserver; `--sticky-section-h`, `FILE_STICKY_TOP` (DiffViewer) and
  `STICKY_CARD_TOP` (CollapsibleCard) dock section headers under it. The file-list
  column is `position: sticky` with hard-coded `max-h-[calc(100vh-140px)]` viewport
  math, and the Changes bar's `z-[25]` is deliberately below the sidebar scrim's
  `z-30` in `__root.tsx` (comment at the JSX explains why).
- Per-agent view state lives in `web/src/lib/agentViewPrefs.ts`: a sharded
  localStorage store keyed per project+agent, 30-day TTL (terminal height, page
  scrollTop, collapsed diff files, bash tabs, tests-panel view toggles).
- `web/src/lib/storage.ts` is the `StorageKeys` registry. The left sidebar's
  *collapsed* state persists via the zustand `useSidebarStore`
  (`web/src/lib/sidebar.ts`), but its *width* does not - width is plain `useState`
  in `__root.tsx` persisted with `readLocal`/`writeLocal(StorageKeys.sidebarWidth)`.
  `forwardSidebarWheelToMain` (`__root.tsx`) forwards leftover sidebar wheel delta
  into `[data-main-scroll]`.
- All resizing is hand-rolled pointer/mouse drag - no split-pane library: sidebar
  width (`__root.tsx`), diff file-list width (`DiffViewer.tsx`), terminal height
  (`AgentTerminal.tsx`).
- The preview reverse proxy (`internal/preview/spawn.go` + `proxy.go`) passes
  upstream responses through untouched: no `ModifyResponse`, no body rewriting, no
  gzip handling. `prefersHTML()` sniffs only the *request* Accept header, to decide
  whether to serve Hydra's own loading page while the server boots. `PreviewPanel`'s
  Open button is a `window.open` of the proxy URL; nothing in `web/src` embeds an
  iframe today.

## Testing

Run tests using standard Go tools:
```bash
go test ./...
```

### Agent test gate — warnings

A project's `[tests.<name>]` runners write a JUnit-XML or Hydra-native-JSON report into
`$HYDRA_TEST_OUTPUT`, which Hydra parses into passed/failed/skipped **and warnings**
counts (`internal/tests`). A *warning* is a non-failing diagnostic (an eslint warning,
a deprecation, a lint nit): it is surfaced but **never** flips the verdict to failing or
gates the merge. The verdict chip shows warnings only in its *long* form (agent header /
tests panel) as an amber `⚠ N`; the *short* sidebar chip stays `✓ N` (passed only).

Two ways to feed warnings in:

- **eslint's JUnit formatter** — warning-severity messages are emitted as
  `<failure type="warning">`, which Hydra maps to a warning (errors stay failures):
  ```bash
  eslint -f junit -o "$HYDRA_TEST_OUTPUT/eslint.xml" .
  ```
- **Hydra-native JSON** (the general path, reliable for any tool) — emit cases with
  `"status": "warning"`:
  ```json
  { "cases": [ { "name": "no-unused-vars", "path": "src/x.ts", "line": 12, "status": "warning", "message": "'y' is defined but never used" } ] }
  ```

### Structured case locations

A `TestCase` carries a two-axis location besides its leaf `name`: `path` (repo-relative
file, or package dir for Go) with optional `line`/`col`/`end_line`/`end_col`, and
`scope` (a string array: class chain / describe chain / subtest parent). The JUnit
parser fills these itself — file-like classnames → `path`, dotted classnames
(`com.example.FooTest`, pytest) → `scope`, Go package classnames get the go.mod module
prefix stripped *and* are then resolved to the declaring `*_test.go` file + line by
scanning the package dir in the checkout (`locContext.resolveGoTestFile`; streamed
markers locating a package dir resolve the same way), pytest's native `file`/`line`
attrs are read (0-based line bumped) — and Hydra-JSON reports can set them directly.
The tests panel renders cases as a collapsible path tree with lowlit indent-guide
lines showing each row's parent; node tallies (`✓ ⚠ ✗`) always count everything under
a node, filters only hide rows. Default-hidden statuses depend on the view mode:
passed + skipped in the unified tree, nothing when "Group by result" is on (its
per-status sections render as root tree nodes; skipped/passing start collapsed).
Filter/search live in the Tests header; "Group by result" / "Group by scope"
checkboxes in the changes cog.

### Streaming results (`type = "stdout"`)

A `[tests.<name>]` runner with `type = "stdout"` skips report files entirely: Hydra parses
`::hydra:test:*::` markers live from the command's stdout, counts tick in the panel
and the sidebar chip while the run is in flight, and the accumulated cases become the
report at exit (no markers → exit-code fallback). One line per case — location
(`path[:line[:col]]` or dotted class) `›` optional scope levels `›` name, `|` message:

```bash
echo "::hydra:test:total:: 4556"                    # optional denominator
echo "::hydra:test:pass:: internal/artifacts › TestGenerateAndCache"
echo "::hydra:test:warn:: web/src/x.ts:12:5 › no-console | Unexpected console statement"
echo "::hydra:test:fail:: auth/rotation.test.ts:48:24 › grace window | expected kid-2 to be kid-3"
echo "::hydra:test:skip:: heads/resume_test.go › TestResumeOnBoot | needs daemon"
```

## Visual Artifacts & Screenshots

The diff viewer can run per-project "artifact" commands against both sides of a
comparison and surface the rendered images/videos that differ. Hydra's own UI is
exercised this way: an `[artifacts.screenshots]` entry in
`.hydra/config.toml` runs `web/scripts/screenshots/take-screenshots.ts`, which builds
the frontend, boots `hydra server --simulation` (mock data, no daemon needed) and
screenshots a list of pages with headless Chromium.

**If a user asks to "add a screenshot" or "add an artifact", they mean add an
entry here — not attach an image file.** Concretely:

- **A new screenshot of the existing UI** → add an entry to the `pages` array in
  `web/scripts/screenshots/take-screenshots.ts`. Each entry is a `{ name, path, … }`
  object with optional knobs (viewport, `scrollTo`, `click`/`clicks`,
  `imageDiffMode`, `showArtifacts`, etc. — all documented inline on the page
  type). Every page is captured in both light and dark themes and written as
  `<name>-<theme>.png` (+ a `.png.meta` JSON sidecar of `{ tags, dpi }`). Mock data
  the shots rely on lives in `internal/http/simulation.go`. No config change is
  needed — the script auto-surfaces every file it writes. The `.meta` `dpi` is the
  device-scale factor the shot was captured at (phone shots use 2 for crispness);
  the diff grid sizes a tile by its *logical* width (physical px ÷ dpi), so a 2x
  shot lays out the same as a 1x one, only sharper. Absent ⇒ 1.
- **A whole new artifact command** (e.g. a different generator/script) → add a new
  `[artifacts.<name>]` table to `.hydra/config.toml` (the table key is the name;
  the legacy `[[artifacts]]` array form still parses). See the documented fields
  there (`command`, `timeout_sec`, `unsafe_host`) and the `HYDRA_ARTIFACT_*`
  env contract the command is given. Named entries merge by name across the
  user/project/config.local.toml layers; a legacy-array file replaces the list
  wholesale.

Run the screenshot generator locally with: `cd web && bun install
&& bun scripts/screenshots/take-screenshots.ts` (it needs `HYDRA_ARTIFACT_OUTPUT` set
to a directory to write into). Playwright + ffmpeg-static are devDependencies of `web`. Renders do **not** need to be byte-identical: hydra compares the
**decoded pixels** (PNG/JPEG/GIF), and for `.webm` it compares per-frame pixel
hashes via ffmpeg (see `internal/artifacts` `Manager.Compare`), so cosmetic
encoder/metadata differences are ignored and only real visual changes surface.
The script still pins the clock and freezes timers/animation (see its header) to
keep diffs clean, but minor encoding nondeterminism is tolerated.
