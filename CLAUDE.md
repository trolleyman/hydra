# Guidelines for Hydra

Hydra is an AI orchestration platform for managing autonomous agents (Heads).

## Project Structure

- `main.go`: Entry point for the CLI.
- `internal/`: Core logic (Docker, Git, heads management).
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

## Testing

Run tests using standard Go tools:
```bash
go test ./...
```

## Visual Artifacts & Screenshots

The diff viewer can run per-project "artifact" commands against both sides of a
comparison and surface the rendered images/videos that differ. Hydra's own UI is
exercised this way: a `[[artifacts]]` entry named `screenshots` in
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
  `[[artifacts]]` section to `.hydra/config.toml`. See the documented fields there
  (`name`, `command`, `timeout_sec`, `unsafe_host`) and the `HYDRA_ARTIFACT_*`
  env contract the command is given.

Run the screenshot generator locally with: `cd web && bun install
&& bun scripts/screenshots/take-screenshots.ts` (it needs `HYDRA_ARTIFACT_OUTPUT` set
to a directory to write into). Playwright + ffmpeg-static are devDependencies of `web`. Renders do **not** need to be byte-identical: hydra compares the
**decoded pixels** (PNG/JPEG/GIF), and for `.webm` it compares per-frame pixel
hashes via ffmpeg (see `internal/artifacts` `Manager.Compare`), so cosmetic
encoder/metadata differences are ignored and only real visual changes surface.
The script still pins the clock and freezes timers/animation (see its header) to
keep diffs clean, but minor encoding nondeterminism is tolerated.
