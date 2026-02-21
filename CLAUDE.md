# Hydra - Technical Specification

This document describes the intended design of Hydra for both human contributors and AI coding assistants. It covers architecture, data model, API surface, frontend structure, and outstanding TODOs.

---

## Overview

Hydra is a locally-hosted web app that manages AI coding agents. Each agent runs inside a Docker AI Sandbox microVM with an isolated git worktree. The user provides a plain-English prompt; Hydra boots the container, runs the agent, tracks progress, and lets the user merge or discard the result.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 19, TypeScript, Vite, TanStack Router, Tailwind CSS 4, Zustand |
| Backend | Go (standard `net/http`), SQLite (via `mattn/go-sqlite3` or `modernc.org/sqlite`) |
| API contract | OpenAPI 3.0.3 (`api/openapi.yaml`) |
| Code generation | oapi-codegen (Go), openapi-typescript-codegen (TS) |
| Build system | Mage (`magefiles/magefile.go`) |
| Containerisation | Docker AI Sandboxes |

---

## Repository Layout

```
hydra/
├── api/
│   └── openapi.yaml              # API source of truth - edit this, then regenerate
├── internal/
│   └── api/
│       ├── config.yaml           # oapi-codegen configuration
│       ├── server.go             # hand-written helpers (WriteJSON, ReadJSON, …)
│       └── server.gen.go         # GENERATED - do not edit by hand
├── internal/
│   ├── db/                       # SQLite database layer (migrations, queries)
│   ├── agent/                    # Agent lifecycle (spawn, poll, commit, teardown)
│   └── project/                  # Project management helpers
├── magefiles/
│   └── magefile.go               # Mage tasks: Build, Generate, Run, Tidy
├── web/
│   ├── src/
│   │   ├── api/                  # GENERATED TypeScript client - do not edit
│   │   ├── components/           # Shared React components
│   │   ├── routes/               # TanStack Router pages
│   │   │   ├── __root.tsx        # Root layout (top bar, project picker, sidebar)
│   │   │   ├── index.tsx         # Redirect to last project or project-picker
│   │   │   ├── $projectId/
│   │   │   │   ├── index.tsx     # Project overview (info cards)
│   │   │   │   └── agents/
│   │   │   │       ├── index.tsx # Agents list
│   │   │   │       └── $agentId.tsx # Single agent detail / log stream
│   │   │   └── new-project.tsx   # New-project wizard
│   │   ├── stores/               # Zustand stores (project, agent state)
│   │   ├── index.tsx             # React entry point
│   │   └── index.css             # Tailwind CSS entry
│   ├── embed.go                  # Embeds web/dist into the Go binary
│   └── package.json
└── main.go                       # HTTP server entry point
```

> `internal/db/`, `internal/agent/`, `internal/project/` do not exist yet - they need to be created.

---

## Database

**Decision: SQLite.**

Rationale: single-file, zero-configuration, works well for a locally-hosted single-user tool. Use `modernc.org/sqlite` (pure Go, no cgo required) unless CGO is acceptable, in which case `mattn/go-sqlite3` is fine.

The database file lives at `~/.hydra/hydra.db` (or a path configurable via `--db` flag / env var `HYDRA_DB`).

Worktrees and agent scratch directories also live under `~/.hydra/` by default:

```
~/.hydra/
├── hydra.db                    # SQLite state database
└── worktrees/
    └── <agentId>/              # git worktree for each agent
```

### Schema (initial)

```sql
CREATE TABLE projects (
    id          TEXT PRIMARY KEY, -- last element of path slugified by default (with 2,3,4,etc. added for uniqueness if id is already taken)
    name        TEXT NOT NULL, -- last element of path (with (2), (3), added for uniqueness if name is already taken)
    path        TEXT NOT NULL UNIQUE,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_opened DATETIME
);

CREATE TABLE agents (
    id              TEXT PRIMARY KEY,   -- 11 length a-z A-Z 0-9 ID
    project_id      TEXT NOT NULL REFERENCES projects(id),
    name            TEXT NOT NULL,      -- human-readable label (from prompt - maybe update with an AI-generated name if possible)
    prompt          TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending',
        -- pending | running | committing | done | failed | deleted
    branch          TEXT NOT NULL,      -- git branch name (hydra/<prompt slug>) if already taken, adds 2,3,4, etc. to the name until unique
    worktree_path   TEXT NOT NULL,
    sandbox_id    TEXT,               -- Docker sandbox ID (e.g. gemini-sandbox-2026-02-21-152141)
    sandbox_template TEXT,              -- can be null in which case the default is used
    ai_provider     TEXT NOT NULL,
        -- claude | codex | copilot | gemini | cagent | kiro | opencode | other (matches docker sandbox types, with other being == shell)
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at     DATETIME,
    log_tail        TEXT,                -- last N lines of agent stdout/stderr
    UNIQUE (project_id, branch)
);
```

---

## API Design

All routes are under `/api/`. The OpenAPI spec (`api/openapi.yaml`) is the authoritative definition; the table below is a planning guide.

### Projects

| Method | Path | Description |
|---|---|---|
| GET | `/api/projects` | List all known projects |
| POST | `/api/projects` | Create a new project (`{path}`) |
| GET | `/api/projects/:id` | Get a single project |
| DELETE | `/api/projects/:id` | Remove a project (does not delete files) |

### Agents

| Method | Path | Description |
|---|---|---|
| GET | `/api/projects/:id/agents` | List agents for a project |
| POST | `/api/projects/:id/agents` | Create + start an agent (prompt + AI provider + sandbox template (if any)), returns `{"agent_id": <agent ID>}` |
| GET | `/api/projects/:id/agents/:agentId` | Get agent detail + status |
| DELETE | `/api/projects/:id/agents/:agentId` | Stop + delete agent and worktree |
| POST | `/api/projects/:id/agents/:agentId/merge` | Merge branch, clean up worktree |
| GET | `/api/projects/:id/agents/:agentId/logs` | Stream logs (from start and then stream) (SSE or long-poll) |
| GET | `/api/projects/:id/repository/directory/:path*` | Get info about directory (relative to path root - forbid `../../`ing outside project root) - list of files essentially, plus other directory info |
| GET | `/api/projects/:id/repository/filemeta/:path*` | Get metadata about file |
| GET | `/api/projects/:id/repository/file/:path*` | Get file contents. Bytes stream |

### System

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Health check (already defined) |
| GET | `/api/status` | System status (already defined) |
| GET | `/api/agent-types` | List built-in agent types |

### Folder Picker

When running on localhost, the backend can open a native folder-picker dialog. On non-localhost origins, the frontend falls back to a text input.

| Method | Path | Description |
|---|---|---|
| POST | `/api/pick-folder` | Opens a native OS folder picker; returns `{path}` - checks that the source of the request is localhost (or 127.0.0.1, or ipv6 equivalents) |

---

## Frontend Routes & Components

### Routes

| URL | Component | Purpose |
|---|---|---|
| `/` | `routes/index.tsx` | Redirect to last project, or to `/new-project` |
| `/new-project` | `routes/new-project.tsx` | Project creation wizard |
| `/:projectId` | `routes/$projectId/index.tsx` | Project overview (info cards + text box to spawn new agent with prompt) |
| `/:projectId/agents` | `routes/$projectId/agents/index.tsx` | Agent list, sidebar nav |
| `/:projectId/agents/:agentId` | `routes/$projectId/agents/$agentId.tsx` | Agent detail + log stream |
| `/:projectId/repository` | `routes/$projectId/repository/index.tsx` | GitHub/GitLab style repository viewer (README.md or README.txt shown at the bottom) |
| `/:projectId/repository/blob/:branch/:path*` | `routes/$projectId/repository/blob.$branch.$path*.tsx` | Basically as above if a folder, but if a file then show that instead of a directory listing - with raw, copy, download buttons |
| `/:projectId/repository/raw/:branch/:path*` | `routes/$projectId/repository/raw.$branch.$path*.tsx` | Raw file, 404 if a directory or not found |

### Key Shared Components (`web/src/components/`)

| Component | Description |
|---|---|
| `ProjectPicker` | Top-left dropdown - lists known projects + "New project…" option |
| `Sidebar` | Left sidebar - links to Overview, Agents (with status badges) |
| `AgentCard` | Card on the agents list - name, status pill, prompt excerpt, actions |
| `AgentStatusBadge` | Coloured pill: pending / running / done / failed |
| `LogViewer` | Scrollable log tail for a running or finished agent |
| `FolderPicker` | Text input + "Browse…" button; calls `/api/pick-folder` on localhost |
| `CreateAgentDialog` | Modal/drawer - prompt textarea, AI provider selector, template selector |
| `ConfirmDialog` | Generic confirmation dialog (used for Delete and Merge) |
| <more> | ... |

---

## Agent Lifecycle

### 1. Creation

POST `/api/projects/:id/agents` with `{prompt, aiProvider, sandboxTemplate}`.

Backend:
1. Generates an agent ID and branch name (`hydra/<prompt slug>`). (see CREATE TABLE above for details)
2. Creates a git worktree at `~/.hydra/worktrees/<prompt slug>` on the new branch.
3. Writes the agent row to SQLite with `status = 'pending'`. The sandbox ID can be the agent ID for now.
4. Creates the Docker sandbox (see below) asynchronously, and starts it. (`docker sandbox create --name <sandbox ID> [-t <template> if set] <ai_provider ("shell" if it is "other")>`)
5. Updates `status = 'starting'` after creating, and `status = 'running'` after starting.

### 2. Running

The Docker sandbox mounts (or syncs) the worktree directory. The backend polls the container every few seconds (e.g. via `docker inspect` or sandbox API) and appends stdout/stderr to `log_tail`.

### 3. Commit

When the agent process exits, the backend:
1. Asks the agent to commit in readable chunks (as a prompt prefix) (if the AI provider supports it), or auto-commits all remaining changes:
   ```sh
   git add -A && git commit -m "chore: auto-commit agent changes"
   ```
2. Any leftover uncommitted changes are staged and committed automatically.
3. Sets `status = 'done'` (or `'failed'` if exit code != 0 (or if there was another error at some other point)).

### 4. Merge

POST `/api/projects/:id/agents/:agentId/merge`:
1. Merges `hydra/<agentId>` into the project's current default branch (or a branch the user specifies).
2. Stops and removes the Docker sandbox.
3. Removes the git worktree: `git worktree remove --force <path>`.
4. Deletes the branch: `git branch -D hydra/<agentId>`.
5. Sets `status = 'deleted'` (or removes the row).

### 5. Delete

DELETE `/api/projects/:id/agents/:agentId`:
- Same cleanup as Merge but without merging the branch.
- Prompts user to confirm since this discards all agent work.

---

## Docker Sandbox Integration

Hydra uses [Docker AI Sandboxes](https://docs.docker.com/ai/sandboxes/) - each sandbox is a microVM with its own Docker daemon.

### Container Labels

Running sandbox containers are labelled so Hydra can find them:

```
org.trolleyman.hydra=true
org.trolleyman.hydra.metadata=<JSON>
```

Where `<JSON>` contains:
```json
{
  "agentId": "...",
  "projectId": "...",
  "aiProvider": "..."
  // (and any other metadata)
}
```

### Built-in Sandbox Templates

| Template | Description |
|---|---|
| `docker/sandbox-templates:claude-code` | Ubuntu 25.10 base + Docker CLI + Git + Node.js + Python + Go + Claude Code binary |
| `docker/sandbox-templates:gemini` | Same base + Gemini CLI |

Users can also enter any custom template image tag in the UI.

### Credential Injection

API keys (e.g. `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, other) are injected at sandbox creation time via Docker's credential-proxy mechanism. The auth should be left for the user to do manually.

---

## Project Picker Flow

On first load (`/`):
1. Frontend calls `GET /api/projects`.
2. If one or more projects exist, redirect to `/:lastProjectId` (stored in `localStorage`).
3. If no projects exist, show the **new-project** screen.

The **new-project** screen offers:
- A text input for typing a folder path directly.
- A "Browse…" button that calls `POST /api/pick-folder` (only enabled when `window.location.hostname === 'localhost' (or 127.0.0.1, or ipv6 equivalents)`).

Once the project is created, navigate to `/:newProjectId`.

The **ProjectPicker** dropdown (top-left, visible on all project pages) lists all projects and has a "+ New project…" item at the bottom.

---

## Polling / Real-time Updates

Use **Server-Sent Events (SSE)** for the agent log stream (`GET /api/.../logs`). For agent status updates on the agents list page, poll `GET /api/projects/:id/agents` every 5 seconds while any agents are `running`.

---

## Build Tasks (Mage)

| Task | Description |
|---|---|
| `mage build:all` | Build TypeScript then Go |
| `mage build:go` | Build Go binary (depends on TypeScript + Go codegen) |
| `mage build:typeScript` | Run `bun run build` in `web/` |
| `mage generate:go` | Run `go generate ./...` (oapi-codegen) |
| `mage run` | Build + start the server on `:8080` |
| `mage tidy` | `go mod tidy` + `go fmt` + errtrace |

---

## Decisions Still Open

- **Folder-picker on non-localhost**: fall back to plain text input; do not implement a web-based tree browser for now.
- **Default branch detection**: use `git symbolic-ref refs/remotes/origin/HEAD` or fall back to `main`/`master`.
- **Merge strategy**: default to regular merge (not rebase/squash) to preserve agent commit history.
- **Multi-user**: out of scope - Hydra is single-user, localhost only.
- **Agent logs retention**: store only the last 10 000 characters in `log_tail`; full logs are available via SSE while the container is running.
- **Database migrations**: Use https://github.com/pressly/goose for migrations, and integrate this into main.go startup, to automatically create the database correctly.
- **Paths**: Where `~/.hydra` has been used, instead use `XDG_*_DIR/hydra/` where it makes sense (and use e.g. AppData or other paths on macOS). Centralize this path access in internal/paths.go

---

## Immediate TODOs

- [ ] Add SQLite dependency + migrations (`internal/db/`) (Goose)
- [ ] Expand `api/openapi.yaml` with all project/agent routes listed above
- [ ] Regenerate `internal/api/server.gen.go` and implement handlers
- [ ] Implement `internal/agent/` - Docker sandbox lifecycle
- [ ] Implement git worktree management in `internal/agent/`
- [ ] Build frontend routes: `/$projectId`, `/$projectId/agents`, new-project wizard
- [ ] Build shared components: ProjectPicker, Sidebar, AgentCard, CreateAgentDialog, LogViewer
- [ ] Implement SSE log streaming endpoint + LogViewer component
- [ ] Add `POST /api/pick-folder` (OS native dialog via `golang.org/x/sys` or a small helper)
- [ ] Add `GET /api/sandbox-templates` returning the built-in template list
- [ ] Wire up Mage tasks for database migrations

## Misc.
Ignore `unsupported OS: MINGW64_NT-10.0-26200` when running, this is just an artifact of Windows.