# Guidelines for Hydra

Hydra is an AI orchestration platform for managing autonomous agents (Heads).

## Start here

- Read [docs/agent-guide.md](docs/agent-guide.md) for detailed project, UI, and
  tooling conventions.
- Before working in a subsystem, follow the on-demand documentation map at the
  end of that guide. Do not re-derive documented architecture from source.
- Keep docs in present tense and update them with behavior changes.

## Project shape

- `main.go`: CLI entry point.
- `internal/`: sandboxing, Git, heads, daemon, and HTTP backend.
- `api/`: OpenAPI definitions.
- `web/`: React, TypeScript, and Vite frontend.
- `magefiles/`: build automation.

## Commands

- `mage build`: build the backend and frontend.
- `mage buildGoDeps && go run ./`: build dependencies and run Hydra.
- `mage run`: build dependencies and run the server.
- `mage tidy`: run `go mod tidy`, `go fmt`, and errtrace checks.
- `go test ./...`: run Go tests.
- `cd web && aube run lint`: typecheck and lint the frontend.

Use aube when available and npm otherwise. Run TypeScript scripts under
`web/scripts/` and `web/e2e/` with Node directly.

## Always-on rules

- Use ASCII punctuation in source, UI strings, and comments. Existing decorative
  status glyphs are allowed.
- UI headings use normal sentence/title case, never all caps or CSS uppercase.
- `rg` is recursive by default. Never use `-r` to mean recursive; in ripgrep it
  means `--replace`.
- Never put raw control bytes in source; use escape sequences.
- Hydra has a single user, and its client and server update together. Do not add
  backward-compatibility shims, legacy aliases, deprecation paths, or dual-format
  handling unless the user explicitly asks for them; replace the old behavior
  outright.
- Define API changes in `api/openapi.yaml`, then run `mage generate:go`.
- Use the shared tooltip, typography, file-path, and URL components described in
  [docs/agent-guide.md](docs/agent-guide.md) instead of recreating them.

## Verification

- While iterating, run only the tests that cover the changed package, file, or
  behavior. For example, use `go test ./internal/tests -run TestName` or
  `cd web && aube exec vitest run src/lib/example.test.ts` instead of a full
  repository suite.
- Before the final commit and handoff, run `mage build` once for the complete
  change set. Repeat it earlier only at a meaningful integration checkpoint.
- Before committing Go changes, run `mage tidy` and the relevant Go tests. Run
  `go test ./...` once after the complete Go change, not after every commit.
- After the complete web change, run `cd web && aube run lint` once and fix new
  errors or warnings. During iteration, lint or test only the touched files.
- Verify UI changes in the production simulation app with Playwright, including
  console and page errors. Show relevant light and dark 2x captures.
- Commit in logical chunks with explanatory messages for non-trivial changes.
