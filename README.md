# Hydra

An AI agent management platform. Hydra lets you spin up isolated AI coding agents (running in Docker sandboxes) against a local project, track their progress, and merge their work back into your codebase.

## Features

- **Project management** - open any local folder as a project; quickly switch between known projects via a top-left dropdown
- **Agent orchestration** - create agents with a natural-language prompt; each agent runs inside an isolated Docker microVM sandbox with its own git worktree
- **Multi-agent support** - run several agents in parallel against the same project, each on its own branch
- **Agent lifecycle** - monitor status, stream logs, merge branches, or cleanly delete agents and their worktrees
- **Sandbox templates** - choose from built-in Docker AI Sandbox templates or supply a custom one
- **AI provider support** - Gemini (primary), with Claude Code also supported

## Architecture

```
web/          React + TypeScript frontend (TanStack Router, Tailwind CSS)
internal/     Go backend packages
  api/        OpenAPI-generated server types + helpers
api/          Openapi spec (api/openapi.yaml) - source of truth for the API
main.go       HTTP server: serves the SPA and API routes
magefiles/    Mage build tasks (build, generate, run, tidy)
```

The API spec in `api/openapi.yaml` is the single source of truth. Changes there regenerate:
- `internal/api/server.gen.go` (Go server stubs via oapi-codegen)
- `web/src/api/` (TypeScript client via openapi-typescript-codegen)

State is persisted in a SQLite database stored alongside the centralized worktree directory.

## Getting Started

Prerequisites: Go, Bun, Docker (with AI Sandboxes support), Mage.

```sh
# Install mage
go install github.com/magefile/mage@latest

# Generate code + build everything
mage build:all

# Run the dev server (builds TypeScript first)
mage run
# → http://localhost:8080
```

For frontend hot-reload during development:

```sh
cd web && bun run dev
```

## Usage

1. Open `http://localhost:8080` in your browser
2. Choose an existing project or create a new one by selecting a local folder
3. Navigate to **Agents** to create a new agent - provide a prompt and choose a sandbox template
4. The agent runs `gemini -yp "<prompt>"` (or the equivalent for Claude Code) inside a Docker sandbox, with the project mounted as a git worktree
5. When the agent finishes, its changes are committed on its branch
6. From the UI, **Merge** the agent's branch into the project, or **Delete** it to discard

See [CLAUDE.md](CLAUDE.md) for the full technical specification.
