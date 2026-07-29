# Screenshots & visual artifacts - dev guide

This is the **developer** view: how to add a screenshot/artifact when working on
Hydra's own UI. For the user-facing artifacts feature (config fields, comparison
rules, `.webm` video, tags), see [artifacts.md](artifacts.md).

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
  there (`script`, `timeout_sec`, `unsafe_host`) and the `HYDRA_ARTIFACT_*`
  env contract the command is given. Named entries merge by name across the
  user/project/config.local.toml layers; a legacy-array file replaces the list
  wholesale.

Run the screenshot generator locally with: `cd web && npm install
&& node scripts/screenshots/take-screenshots.ts` (it needs `HYDRA_ARTIFACT_OUTPUT` set
to a directory to write into). Playwright + ffmpeg-static are devDependencies of `web`. Renders do **not** need to be byte-identical: hydra compares the
**decoded pixels** (PNG/JPEG/GIF), and for `.webm` it compares per-frame pixel
hashes via ffmpeg (see `internal/artifacts` `Manager.Compare`), so cosmetic
encoder/metadata differences are ignored and only real visual changes surface.
The script still pins the clock and freezes timers/animation (see its header) to
keep diffs clean, but minor encoding nondeterminism is tolerated.

**A shot's `click`/`hover` selector must key on something stable.** These are the
only part of the generator that silently rots: a UI change moves a control, the
selector matches nothing, Playwright waits its full 30s, and the shot is dropped
with one `✗` line in a log nobody reads. Two selector styles have broken this
way already, both from legitimate UI changes weeks apart:

- **`button[title="..."]`** - the tooltip convention (see CLAUDE.md) moved native
  `title=` off interactive controls, so every title-keyed selector stopped
  matching. Took out `repository-branches` and both `spawn-branch-selector` shots.
- **`svg.lucide-<icon>`** - swapping `GitCompare` for `GitCompareArrows` renames
  the class, and a CSS class selector matches whole tokens, so `.lucide-git-compare`
  no longer matches `lucide-git-compare-arrows`. Took out every `repository-diff*`
  shot. `.lucide-settings` vs `Settings2` is the same trap.

Prefer, in order: **`aria-label`** (it is the control's accessible name, so the
a11y rule keeps it honest), a **`data-*` hook** added for the purpose
(`data-branch-selector`, like `data-main-scroll`), then visible text. Never a
native `title`, never a lucide class.

A failed shot does NOT fail the run, and should not: the generator reports `✗`
and carries on, because `internal/artifacts` returns before `scanOutputs` on a
non-zero exit, so failing hard would throw away every shot that DID render. The
cost is that the failure is quiet - it shows up as a removed tile on the diff's
right-hand side, hours later.

So the shot list is **checked at test time instead**. It lives in
`web/scripts/screenshots/pages.ts` as pure data, and
`web/e2e/screenshot-selectors.spec.ts` imports it and walks every
`click`/`clicks`/`hover` selector against the same simulation server - one test
per shot, so a failure names the shot and which selector in its chain broke. It
runs in about a minute, against ~15 for the artifact, and it caught all 12 shots
that were silently broken when it was written.

Two things it has to honour, because both change *which controls exist* - get
either wrong and it cries wolf every run:

- the shot's own **`viewport`** (a mobile hamburger has no desktop equivalent);
- selectors are a **chain** - the second only resolves once the first has been
  clicked - so it walks them in order rather than checking them against the
  initial page.

The selector list is imported, never copied: a duplicate in the spec would rot
exactly the same way, one step removed. Shots whose setup the spec cannot cheaply
reproduce (a seeded localStorage flag, say) are the known gap - if one of those
starts failing here, fix the spec rather than loosening the selector.

**Chromium needs the egress proxy handed to it explicitly.** Every browser launch
here spreads `proxyLaunchOptions()` (`web/scripts/lib/browserProxy.ts`) into its
options, and it must. curl, node and git read `HTTPS_PROXY` from the environment;
Chromium does not, so inside a sandboxed head it resolves names itself in a
network namespace with no resolver and every external request dies with
`ERR_NAME_NOT_RESOLVED`. That silently cost the shots their webfonts - Merriweather
and Roboto Flex come from `fonts.googleapis.com`, which was on the allow-list and
reachable all along - so a screenshot generated in a head rendered in fallback
fonts while the same script on the host rendered correctly. The helper's loopback
bypass is equally load-bearing: Playwright appends Chromium's `<-loopback>` when a
proxy is set, undoing its built-in "never proxy loopback" rule, which would
otherwise send the simulation server's own traffic to the proxy.

**A missing webfont is now an error, not a quieter shot.** `settle()` explicitly
requests each family in `REQUIRED_FONTS` and then *checks* it arrived, because
`document.fonts.ready` answers neither question on its own: it settles only the
faces the page has already asked for (a font used by a panel that mounts later -
an xterm - may not be among them), and it resolves exactly the same way when the
request FAILED. So a fallback render was indistinguishable from a good one, and
the difference is visible: Fira Code measures 6.769px per character cell against
the fallback's 6.601px, so every xterm row in a shot shifts and the terminal
panels flap between runs. Failing the run is the right trade - a silent fallback
produces a diff that looks like a real UI change and sends you hunting for one.

The durable fix would be to self-host those families the way `build-fonts.ts`
already does for Iosevka and the Nerd Symbols subset, removing the network from
the capture path entirely. Until then the check is what keeps a flap from being
mistaken for a change.

The generator emits a `::hydra:artifact:: <name>.png` marker after writing each
shot, so its tiles **stream** into the diff viewer as they render rather than
appearing all at once at the end (see the streaming section in
[artifacts.md](artifacts.md#streaming-outputs-hydraartifact)). The `--simulation`
server also demos this: its in-flight `components` set trickles tiles in over the
artifacts WebSocket (`internal/http/simulation.go`, `HandleArtifactsWS`).
