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
  there (`command`, `timeout_sec`, `unsafe_host`) and the `HYDRA_ARTIFACT_*`
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

The generator emits a `::hydra:artifact:: <name>.png` marker after writing each
shot, so its tiles **stream** into the diff viewer as they render rather than
appearing all at once at the end (see the streaming section in
[artifacts.md](artifacts.md#streaming-outputs-hydraartifact)). The `--simulation`
server also demos this: its in-flight `components` set trickles tiles in over the
artifacts WebSocket (`internal/http/simulation.go`, `HandleArtifactsWS`).
