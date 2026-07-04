---
name: verify
description: Verify web UI changes end-to-end by booting hydra's simulation server and driving pages with Playwright. Use after changing web/src code to observe the real rendered app (console errors, DOM state, interactions), not just tests.
---

# Verifying Hydra web UI changes

## Build + launch (no daemon, no real project needed)

```bash
cd web && bun run build          # tsc -b && vite build; dist/ is embedded by go
HYDRA_API_ADDR=localhost:<port> go run ./ server --simulation   # from repo root
```

- Pick a random high port; 8080 is the default and may be taken.
- The binary embeds `web/dist` at compile time: after a frontend rebuild you
  must restart `go run` for the new assets to serve.
- Simulation serves mock data from `internal/http/simulation.go` plus all four
  WS endpoints (events/terminal/tests/artifacts). Useful pages:
  - `/project/sim-project/agent/agent-1` - 8-file diff (largest; good for diff
    viewer work; includes a >1000-changed-lines hidden "Load diff" file)
  - `/project/sim-project/agent/agent-2` - small diff incl. a `.txt`
    (plaintext-highlighted) file, tests panel data
  - `/project/sim-project/agent/agent-md` - markdown/running-tests states

## Driving with Playwright

- Scripts importing playwright MUST live under `web/` (bun resolves
  node_modules from the script's dir). Write throwaway drivers to
  `web/scripts/`, delete before committing.
- Browsers: `cd web && bun x playwright install chromium` (never bare
  `bun x playwright install` outside web/ - it GCs the pinned revision).
- The agent page scrolls in an inner pane: `[data-main-scroll]` (not the
  window). Scroll via `pane.scrollTop`.
- Diff file cards: `div.border.rounded-lg.mb-4`; lazily-unmounted bodies
  contain `[data-lazy-placeholder]`; code rows match
  `span.font-mono.text-xs.leading-5` (~4 spans per diff line).
- Capture `page.on('console')` + `page.on('pageerror')` - console cleanliness
  is often the thing being verified.

## Known noise

The simulation server 404s on `/uploads/projects/*/blob`,
`/folder-picker/available`, `/api/auth/status` - pre-existing, ignore.
