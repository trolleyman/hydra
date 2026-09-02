# Detailed contributor guide

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
    package management against `web/package-lock.json`. Package lifecycle scripts
    intentionally spell nested calls as `npm run`: npm executes them directly,
    while aube transparently redirects them to itself, keeping every script usable
    through either package manager. Build scripts under `web/scripts/` and
    `web/e2e/` run directly with `node` (Node 24+ strips the TS types), not a
    separate TS runner.

    **Expected `aube install` warnings (all benign - do not "fix" them):**
    - `WARN_AUBE_GVS_INCOMPATIBLE` for `vite`: vite can't use aube's global
      virtual store, so it installs per-project. Upstream vite limitation; install
      still succeeds.
    - `WARN_AUBE_IGNORED_BUILD_SCRIPTS` for `@swc/core` / `esbuild`: aube skips
      their postinstall build scripts by default. Both ship prebuilt binaries and
      work fine without them; run `aube approve-builds` only if you deliberately
      want to enable them.
3.  **API**: Define API changes in `api/openapi.yaml` and run `mage generate:go` to update server stubs.

### Commits and verification

When a logical change is coherent, run the smallest test that covers it and
commit promptly. A Go package or named test and a Vitest file are the normal
iteration units; do not repeatedly run a repository-wide suite after each
commit.

Run `mage tidy` before a Go commit. Run relevant Go package tests while
iterating, then run `go test ./...` once after the complete Go change. For web
work, run targeted Vitest and ESLint checks while iterating, then run `cd web &&
aube run lint` once after the complete web change. Before final handoff, run
`mage build` once for the complete change set.

### Keyed frontend collections

Repeated identity lookups use the cached indexes in the owning store. Agent
consumers use `selectAgent` / `selectLiveAgent`; project consumers use
`selectProject`. Other stable arrays that need repeated keyed access use
`createArrayIndex` from `web/src/lib/arrayIndex.ts`. The helper caches one `Map`
per array identity, which works with the stores' list reconciliation and avoids
duplicating synchronized array-and-map state. Keep `.find` for predicate searches
such as "the current branch" or "the first non-empty line", where there is no
stable lookup key.

### Composer textarea layers

`HighlightedTextarea` places a transparent native textarea over a visible
markdown backdrop. Their box metrics and scroll offsets stay identical: any
caret-editing path that changes the textarea scroll position also synchronizes
the backdrop immediately. Otherwise a visible word can sit over different
source text, so clicking or double-clicking it edits the wrong range.

Generic clipboard images use `image1`, `image2`, and so on within the current
attachment list. Upload queues reserve each filename synchronously, before a
React render, because desktop clipboard events can arrive back-to-back in one
batched turn.

## Conventions

### No compatibility layers by default

Hydra has a single user, and its client and server update together. Replace old
behavior outright instead of adding backward-compatibility shims, legacy aliases,
deprecation paths, or dual-format handling. Add compatibility behavior only when
the user explicitly asks for it.

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

### Chat code gutters

A multiline Bash command and its source-aware output share the widest line-number
gutter in the card. Source output often carries real file lines with more digits
than the command's own 1..N numbers; both dividing rules still form one vertical
line. When the code-line-number preference hides the command gutter, output keeps
its own intrinsic width.

Source-aware output groups each file beneath its shared, sans-serif file-path
label. Every text, file, and directory header wraps at the panel edge like an
ordinary output line and sticks to the top of the output scroller until the next
header replaces it. A header has an inset rule
immediately above and below its padded label, with no outer vertical margin; file
and directory labels use the shared path tooltip treatments. Search results are
grouped by each path their output names. A nonconsecutive jump between matches in
one file gets one full-width rule across the gutter and source at the omitted-line
boundary. The structural header and its rules carry `data-copy-skip`, leaving
copied source free of presentation chrome.

Agents introduce only a boundary the commands and output cannot otherwise prove
by printing one static marker: `printf '%s\n' '--- <text> ---'`, `--- [file]
<path> ---`, or `--- [dir] <path> ---`. The untyped form is a text heading; the
older explicit `[text]` form remains accepted for existing transcripts. In a
Bash call with several unbounded sections, the marker goes immediately before
every section-producing command, including the first: it introduces the output
that follows rather than terminating the output above it. Reads stay bounded
where possible so a provider cannot truncate away the evidence that identifies
their boundaries. File and directory marker values are exact paths, without
annotations such as `(continued)`. A constant `echo` is accepted, but `printf`
is the canonical cross-shell spelling. The parser correlates the marker with
that constant-printing command; a marker-shaped line read from a file is source,
and an ambiguous duplicate marker is left as ordinary output rather than
guessed. Adjacent bounded `sed` ranges, `rg -n`, and unified `git diff` output
already identify their output and need no marker.

### Test status wording: three layers, three vocabularies

A test status is shown at three different scopes, and each one has its own words.
This is deliberate - it is how the reader tells which scope they are looking at,
and it follows GitHub, which does exactly the same thing:

- **A whole run's verdict** (the runner chip in `TestsPanel`) is an **outcome
  noun**: `success` / `failure` / `error`, plus `running` for an in-flight one.
  These are GitHub's commit-status `state` values, which our four settled states
  map onto one-to-one.
- **A single case** (the case tree, the "group by result" section headings) is a
  **past participle**: `passed` / `failed` / `skipped`, plus `warnings` as a
  plural noun. This is what every test runner itself prints - Playwright, pytest,
  jest, `go test` - and the tree is rendering their output.
- **Prose** (tooltips, dialogs, config docs) uses **pass as a verb**: "Tests
  passing - 79 passed", "No passing test verdict for this commit", "merge when
  tests settle passing". GitHub's own "All checks have passed" is this layer.

Do **not** print a status enum value as UI copy - that is what put `passing` two
lines above `passed` and made them read as an inconsistency. `TestsPanel`'s
`STATUS_LABEL` and `TestVerdict`'s `verdictLabel` / `verdictTitle` are the maps;
add to them instead. The wire values (`tests.Status` in Go, `TestStatus` in
openapi) stay as they are: `Report.Status` is serialized into the on-disk verdict
cache, so renaming one silently invalidates every cached verdict, and `errored`
in particular cannot become `error` (it collides with Go's predeclared `error`
and makes oapi-codegen prefix the whole enum - see the enum-collision note).

### Tooltips: one selectable engine

All tooltips go through `web/src/components/Tooltip.tsx`. Short control labels
and longer explainers use the same content-sized surface, 600ms delay, fade and
generous maximum width. Their dark surface uses a neutral palette so it does not
take on a blue cast. Compact hints are centered by default, and shortcut
keycaps share the label's row. Longer explainers can provide a
`title`, which also selects prose-style left alignment; untitled path or list
content uses `align="left"`. `InfoTooltip` is the preset for the `i` trigger next
to a section heading. Diff file-list entries show their full paths with the
shared `FilePathLabel` treatment, while directory entries use
`DirectoryTooltip`.

Source-output file headers reveal their full path only when the visible label
wraps or clips. That tooltip keeps its vertical placement tied to the header and
points horizontally at the cursor, so a long wrapping path does not open a box
far away from the text being inspected.

Every tooltip can be entered: the short grace period between leaving the trigger
and entering the box keeps it open so text can be selected and links clicked.
Dragging a selection outside the box must not close it until the pointer is
released. Tooltips do not pin on click, and callers cannot customize the delay
or width: those shared details are what make the UI read as one tooltip system.

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
   source line; `CaseTree`'s copy/open buttons render per case. The source-aware
   chat output gutter is the narrow exception: its line numbers use `Tooltip`
   because the hidden path needs the shared file icon and lowlit-directory
   treatment rather than an unstyled path string.
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

Keep an explainer's body short enough to fit a phone screen. A roomy tooltip caps
its height against the viewport and scrolls, but one you have to scroll is a sign the
content belongs in `docs/` with a pointer from the tooltip.

### Labels beside icons: `.optical-center`

A label centred next to an icon with `items-center` reads visibly **high**:
flexbox centres the label's line box, which reserves room for ascenders and
descenders the word may not use, so "Rename" is centred as if it had a descender
it doesn't have (~1.7px high at top-bar size). Put `.optical-center`
(`web/src/index.css` - `text-box: trim-both cap alphabetic`) on the label span so
what gets centred is the cap-to-baseline box you actually see. Browsers without
`text-box` support ignore it and render as before, so it can't regress anything.

The trimmed box is **smaller than the ink**: a `y`/`p`/`j` hangs below it, a tall
`l`/`d` pokes above. The class already handles the consequence that bites -
`truncate` is `overflow: hidden`, which sliced descenders clean off ("project"
rendered as "proiect") - by padding the box and taking the same amount straight
back out with a negative margin, so the glyphs have room inside the clip while
the layout still sees the trimmed height. So it is safe on a truncating label.

**What it does not undo: a row whose height comes only from its label gets a
couple of px shorter**, because shrinking that box is the whole point. That is
usually fine (the file trees just read a touch denser); give the row its own
height (`h-7`/`h-8`, as the top-bar buttons do) if it isn't. It also means a
**sibling's** margin may need adjusting: on the agent toast, trimming the title
closed the gap to the status line under it, which now carries a compensating
`mt`.

**It is fine on a block that wraps.** `text-box-trim: trim-both` trims the
block's FIRST line at the top and its LAST line at the bottom; the leading
*between* lines is untouched. (An earlier version of this note claimed the
opposite - "trimming a multi-line block collapses the leading between its
lines" - and that is wrong. A two-line toast message keeps its leading exactly,
verified in the browser.) So it is the right tool whenever a text block, of any
number of lines, has to sit optically centred against something - which is why
the toast bodies use it to centre against their icon tile.

What it is still **not** for is a block whose top and bottom spacing you want to
read as prose margins: trimming pulls the block's outer edges in to the ink, so
a paragraph in a column of paragraphs will sit tighter than its neighbours.

Applied at: the top-bar action buttons, the repository + diff file trees, the
sidebar project path, the collapsible card headers (previews / services / tests),
the Settings section headings, the chat rows beside a `WorkSpark`, and the toast
bodies (title, status line and plain message - see `Toaster` /
`AgentTransitionRow` / `AgentNameLink`).

**Correct the label, never the icon.** Both work - trimming the text down and
nudging the mark up land in the same place - but the trim derives the offset from
the font's own cap height, where a `-mt-px` / `relative top-[Npx]` on the icon is
a constant tuned to one size in whichever font happened to load when it was
measured, and this UI's stack resolves differently per OS. So the icon stays
honestly centred and the label carries the class. Note the trim needs LINE BOXES
to act on: a flex container has none, so a label wrapper that is itself
`flex items-center gap-*` must become an inline span (with the gap moved onto its
separator) before the class does anything - see the chat result footer.

The rule bans the magic CONSTANT, not touching the icon. When a mark has to ride
inside the text flow - `AgentNameLink`'s Bot is inline so a wrapped title wraps
back under it instead of being indented past it - size it in `em` and offset it
in `cap`: `h-[1em] w-[1em] align-[calc(0.5cap_-_0.5em)]` puts the glyph's centre
on the cap-box centre for any font at any size, and stays honest.

### Baseline alignment in flex rows (CSS Flexbox 8.3)

A row that mixes type sizes - a 10px hint, an 11px percentage, a 12px chip - and
uses `items-center` puts three different baselines on screen, because centring
aligns each item's LINE BOX and a bigger line box reserves more room above the
cap. Two ways out, and they are not interchangeable:

- **`items-baseline`** when the row is text and chips. Correct, but see the trap
  below.
- **`items-center` with `.optical-center` on every label** when the row also
  holds icon buttons. Once each item's box IS its ink, centring aligns the ink,
  and the buttons centre on the same thing the text does. This is what the chat
  composer's footer uses.

**The trap: a flex container only exposes a baseline to its parent if one of its
own items takes part in baseline alignment.** With `align-items: center` none do,
so the container synthesizes a baseline from its border box and lands several px
off - and no amount of alignment on the PARENT can fix it. This bit three
different components before it was understood:

- the chat model-picker button (`flex items-center`) sat 4px above the labels
  beside it;
- `BranchPill` was an `inline-flex items-center` carrying `align-baseline`, which
  therefore did nothing - it rode 2.8px high in every sentence naming a branch.
  It is an `inline-block` now: one text child, nothing to lay out, and its
  baseline is its text's baseline;
- giving an icon button `self-center` inside an `items-baseline` row centres it
  in the line's cross size (max-ascent over max-descent), whose midpoint sits
  ABOVE the text's ink - so it reads ~1px high.

`Badge`'s text-only variant is a plain span, so it cooperates; its icon-bearing
and `xs` variants are flex containers and will not.

When judging any of this, measure - do not squint. Drop a zero-height
`inline-block` probe into the text (it sits exactly on the baseline, so its
`getBoundingClientRect().top` IS the baseline) and take cap height from a canvas
`measureText('H').actualBoundingBoxAscent`. Deriving a baseline from an element's
own box does NOT work once `.optical-center` is on it: the class's 0.35em padding
inflates the reported rect, and two measurements in a row wrongly concluded the
class did nothing.

### Hostnames and URLs: `HostName` / `UrlText`

A host or URL shown to the user goes through `web/src/components/HostName.tsx`,
which lowlights everything but the registrable domain - `registry.` fades,
`npmjs.org` stays - the way a browser's address bar does. Which part is the
domain comes from the Public Suffix List (`tldts`, wrapped in
`web/src/lib/publicSuffix.ts`), so `bbc.co.uk` keeps both of its final labels
and, more to the point, `npmjs.org.evil.com` highlights `evil.com`. That last
case is why these exist: the main caller is the network / web-fetch approval
card, where the part naming who you are really talking to has to be the part
that reads loudest.

Two rules the module holds to, both worth preserving in anything built on it:
it never guesses (the list is a ~46KB lazy chunk, and hosts render undimmed
until it lands, so the failure mode is "no dimming" and never "the wrong part
dimmed"), and it never drops characters (`prefix + domain` is always exactly
the input). The lowlight is `opacity`, not a colour, so the components compose
into a neutral chip, a muted caption and a blue link alike.

An *editable* host (the network allow/block lists in Settings) goes through
`HighlightedInput` - the single-line sibling of `HighlightedTextarea`, same
transparent-input-over-a-backdrop trick. Its two layers only line up if they
share their box model exactly, so the padding/font classes go in
`textClassName` (both layers) and the border, background and focus ring on the
wrapper as `focus-within:` - the input is on top, and a ring drawn there frames
the text from above.

### `rg -r` is not "recursive"

`rg` walks the tree already: `rg pat internal/` and a bare `rg pat` are both
recursive, and there is no flag to ask for it. `-r` is `--replace`, so
`rg -rn "pat" dir` replaces every match with `n` (the `n` you meant as
`--line-number`) and prints the rewritten lines with no numbers - output that
reads like a search with strange results rather than like a mistake, which is
how it survives review.

The flags you actually want when the defaults are hiding files: `--hidden`,
`--no-ignore`, or `-u`/`-uu` for both. `-r`/`-R` for recursion belongs to
`grep`.

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

- **Adding a `text-*` class, or touching a font / type size** (the four font
  roles, the size steps, the named interface type ladder - `text-4xs` ...
  `text-3xl` - and what is deliberately off it) -> [docs/typography.md](typography.md).
  Read it before writing `text-[13px]`: the only arbitrary px sizes left in
  `web/src` are an avatar's monogram, and `text-xs` is 13px here, not Tailwind's 12
- **Touching the agent page / diff viewer** (`AgentDetail.tsx`, `DiffViewer.tsx`,
  sticky headers, per-agent view state, preview proxy) -> [docs/web-agent-page.md](web-agent-page.md)
- **Touching the test gate** (`internal/tests`, tests panel, `[tests.<name>]`
  runners, JUnit / Hydra-JSON / streaming markers, warnings) -> [docs/testing.md](testing.md)
- **Adding a screenshot or artifact** (or working on `take-screenshots.ts` /
  `internal/artifacts`) -> [docs/screenshots.md](screenshots.md); the
  user-facing artifacts feature is [docs/artifacts.md](artifacts.md)
- **Working on live previews** (`[previews.<name>]`, `internal/preview`, the
  Previews row / `PreviewPanel.tsx`) -> the Previews section of
  [docs/artifacts.md](artifacts.md). Previews are their OWN config section,
  not an artifact type; the legacy `[artifacts.<name>] type = "server"` spelling
  is upgraded on read by `upgradeServerArtifacts`
- **Working on macOS/darwin support** (`internal/sandbox/darwin.go`, Seatbelt
  profile, config seeding on macOS) -> [docs/macos-support.md](macos-support.md)
  (audit of the darwin backend + phased implementation plan)
- **Working on Windows support** (`internal/sandbox/windows.go` and the other
  `*_windows.go` stubs, ConPTY, AppContainer, WSL2) ->
  [docs/windows-support.md](windows-support.md) (audit of the Windows
  stubs + phased implementation plan)
- **Improving the diff review workflow** (per-file "viewed" state, "reviewed up
  to" marker) -> [docs/diff-review-state.md](diff-review-state.md) (proposed,
  unbuilt design + build order)
- **Improving the diff viewer rendering** (word/intra-line diff, moved-block
  detection, histogram algorithm, function-context headers, semantic/AST diff) ->
  [docs/diff-viewer-improvements.md](diff-viewer-improvements.md) (survey +
  ranked plan; character-level word diff, histogram, funcname headers,
  similarity pairing and edit-boundary sliding are built; moved-block detection
  and whitespace-row dimming were tried and reverted - see the doc). A proper
  boxes+jump redesign of moved-block viz is specced in
  [docs/diff-moved-blocks.md](diff-moved-blocks.md) (unbuilt)
- **Working on an existing PR/MR** (adopting someone else's PR as a head,
  fetching a PR head, pushing back to a fork, `internal/forge` enumeration) ->
  [docs/pr-adoption.md](pr-adoption.md) (BUILT; `forge.ListMRs`/`GetMR`,
  `git.PRHeadRefspec`/`FetchRefspec`, `heads.SpawnHeadOptions.Adopt`, the
  `adopt_mr` spawn field + `GET .../reviews`, `web/.../PRPicker.tsx`; the
  outbound publish flow is docs/non-local-integration.md)
- **Publishing a head to a forge** (the `[review]` config, Create MR / Push to
  MR / Pull from MR, the ahead/behind sync chips, the MR lifecycle watcher,
  sticky publish/sync-when-green, forge auth, the agent's review AND self-status
  tools) -> [docs/non-local-integration.md](non-local-integration.md)
  (BUILT; `internal/forge`, `internal/http/publish.go` + `review_watcher.go` +
  `head_status.go`, `internal/reviewq` on-demand refresh,
  `mcp__hydra__get_review_*` / `get_head_status` / `get_test_logs` /
  `retry_tests` / `retry_artifacts`; also lists what is deliberately NOT built)
- **Review threads in the diff** (forge PR comments inline, replying, local-only
  notes, the origin badges) -> [docs/review-threads.md](review-threads.md)
- **Review agent + a real comment system** (the "Review" tab: a session slot
  modelled on the shell tabs - no DB row, no branch, own detached checkout,
  read-only git + blocked git tools - plus the *unbuilt* server-side comment
  store agents would read/append via tools, notified by id rather than injected
  as text) -> [docs/review-agent.md](review-agent.md) (BOTH halves BUILT:
  `internal/heads/reviewslot.go` + `reviewsync.go`, `?review=true` on the
  terminal WS, `TabKind` in `AgentTerminal.tsx`; and the comment store -
  `internal/reviewstore/comments.go`, `internal/http/review_comments.go`,
  `reviewq.OpComments`/`OpAddComment`, `web/src/lib/reviewComments.ts`. Two
  constraints worth knowing before touching either: Claude's transcript dir is
  keyed by WORKTREE PATH, so a second agent in the head's own worktree can poison
  its `--continue`/`--resume` - which is why the reviewer gets its own tree, and
  why that tree must not be a recycled pool slot; and everything a review pane
  touches is keyed by the SLOT id `<head>@review`, not the head, or it replays
  the head's conversation)
- **Restructuring the agent page** (should it be GitHub/GitLab-shaped? inspector
  tabs vs the current five-panel stack, activity as chat rows vs an Activity tab,
  URL sub-view state) -> [docs/agent-page-tabs.md](agent-page-tabs.md)
  (proposed, unbuilt; argues against tabbing chat away from the diff on a live
  head, for tabs *inside* the inspector pane)
- **Sandbox scope cgroup limits** (CPU/IO weight, CPU quota, memory max, tasks
  max via the `[resources]` config table + the Settings "Resource limits" section)
  -> [docs/sandbox-resource-limits.md](sandbox-resource-limits.md) (BUILT;
  `sandbox.ScopeLimits` + `WrapScope(unit, spec, limits)`, per-controller
  delegation probe, `config.ResolveResourceLimits`)
- **The built-in chat project** (the always-present "just chatting" project,
  `_chat`, project selection on boot, `ProjectInfo.Builtin`) ->
  [docs/chat-project.md](chat-project.md) (BUILT;
  `projects.EnsureChatProject` + `HasUserProjects`, the reserved-ID rule, why a
  worktree-less head does not work, the project-icon traps)
- **Working on the security gate / egress / MCP governance** (`internal/gate`,
  `internal/egress`, MCP stripping, the `--dangerously-skip-permissions` posture)
  -> [docs/security-audit.md](security-audit.md) (the original sandbox audit;
  its three main recommendations - gate, MCP allow-list, filtering egress proxy -
  are now BUILT for Claude). Changes to which daemon environment variables a
  head receives are covered by
  [docs/head-environment-isolation.md](head-environment-isolation.md).
- **User-checkoutable head branches** (the `hydra/<id>` vs `hydra-wt/<id>`
  branch-split + ff-only mirror design) ->
  [docs/user-branch-mirror.md](user-branch-mirror.md) (proposed, unbuilt
  design; only the `internal/git/branch.go` naming step is done)
- **Remote access / HTTPS / secure context** (reaching Hydra from other devices,
  the localhost-trust auth model, `mage deploy:tailscale` / `deploy:ngrok`,
  serving previews over TLS) -> [docs/remote-access.md](remote-access.md)
  (BUILT; plain-HTTP + auth-key, ngrok, Tailscale serve/Funnel, reverse-proxy;
  `previewURL` protocol-relative so preview links follow the page scheme)
- **Deploying Hydra, or changing how it is built/restarted** (`mage
  deploy:service`, the systemd unit, the in-app update, minify vs source maps,
  response compression) -> [docs/deployment.md](deployment.md) (BUILT: ONE
  build flavour - minified *with* source maps, precompressed to `.br`+`.gz` at
  build time by `web/scripts/precompress.ts` (original deleted, so the binary
  shrinks) and served by `internal/cli.serveAsset`;
  `internal/http.CompressionMiddleware` now covers only dynamic responses;
  `HYDRA_DEV_BUILD` gone. `POST
  /api/server/update` builds while still serving, streams the log over
  `/ws/server/update`, verifies, swaps atomically and re-execs via
  `internal/selfupdate` - `syscall.Exec` keeps the PID and carries the web
  listener across, so no supervisor and no exit-code protocol. `Dev`/`DevExpose`/
  `Prod`/`Preview`/`DevAutoReload` deleted. NOT built: carrying agent PTYs across
  the restart, so a restart still stops running heads - a spike showed it needs
  `Pdeathsig`/`--die-with-parent` dropped first, trading away the
  crashed-daemon-can't-orphan guarantee)
The open backlog (ideas/gaps not yet built) lives in
[docs/roadmap.md](roadmap.md).
