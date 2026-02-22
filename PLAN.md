# Hydra Refactor Plan

## Core Concepts

### Hydra Head
A **Head** is the unit of work managed by Hydra. It has:
- **ID** - user-supplied string (valid git branch component characters)
- **Branch** - `hydra/<id>` (always present once spawned)
- **Worktree** - `<projectRoot>/.hydra/worktrees/<id>` (optional, may be removed)
- **Container** - Docker container named `hydra-<id>` (optional, may be stopped/killed)

### Agent Types
- `claude` - uses `claude.Dockerfile`, binds `~/.claude/settings.json` and `~/.claude/.credentials.json`
- `gemini` - uses `gemini.Dockerfile`, binds `~/.gemini/oauth_creds.json`, `~/.gemini/google_accounts.json`, `~/.gemini/settings.json`

## Naming Scheme
| Resource      | Pattern                          |
|--------------|-----------------------------------|
| Branch        | `hydra/<id>`                     |
| Container name| `hydra-<id>`                     |
| Worktree path | `<projectRoot>/.hydra/worktrees/<id>` |

## Spawn Command
```
hydra spawn [--id <id>] [--agent <claude|gemini>] [--base-branch <branch>] <prompt...>
```
- `--id`: optional; if omitted, generate a short random ID (8 hex chars)
- `--agent`: optional; defaults to `claude`
- `--base-branch`: optional; defaults to current git branch
- `<prompt...>`: required; multi-word prompt joined into one string

## List Command
Primary key: git branches matching `hydra/*`
Also shows containers without a corresponding branch (orphaned containers).

Columns: ID | AGENT | BRANCH | WORKTREE | CONTAINER | STATUS | PROMPT

## Remove / Kill Order
To avoid partial state:
1. Stop + remove Docker container (if any)
2. Remove git worktree (if any)
3. Delete git branch

## Packages

### `internal/docker`
- `AgentType` string type + constants (`AgentTypeClaude`, `AgentTypeGemini`)
- `AgentMetadata`: add `Prompt`, `AgentType` fields
- `SpawnOptions`: remove `DockerfilePath`/`Args`; add `AgentType`
- `SpawnAgent`: derive Dockerfile from `AgentType`, set container name `hydra-<id>`, add agent-specific binds/envs
- `ensureImage`: accept content directly (not file path)

### `internal/git`
- `FindProjectRoot(cwd)` - find git root from arbitrary dir
- `DeleteBranch(projectRoot, branchName)` - `git branch -D <name>`
- `ListHydraBranches(projectRoot)` - `git branch --list 'hydra/*'`

### `internal/paths`
- Fix `GetProjectRoot`: trim trailing newline from `git rev-parse --git-dir` output

### `internal/heads`
New package combining git + docker + filesystem:
```go
type Head struct {
    ID              string
    BranchName      string
    HasBranch       bool
    WorktreePath    string
    HasWorktree     bool
    ProjectPath     string
    ContainerID     string
    ContainerStatus string
    AgentType       docker.AgentType
    Prompt          string
    BaseBranch      string
}
func ListHeads(ctx, cli, projectRoot) ([]Head, error)
func KillHead(ctx, cli, projectRoot, head) error  // container -> worktree -> branch
```

### `internal/tui`
- Fix `git.InferProjectRoot` -> use `head.ProjectPath` from metadata
- Fix `a.Meta.Prompt` - now present in AgentMetadata
- Update to use `heads.ListHeads` instead of `docker.ListAgents`
- Add spawn form (keys: `n` to open, Tab between fields, Enter to submit, Esc to cancel)
  - Fields: ID (textinput), Agent type (select), Prompt (textinput)

### `internal/config`
- Add `_ "embed"` import for Dockerfile embeds
- `DefaultDockerfileClaude` and `DefaultDockerfileGemini` remain as embedded strings

### `internal/api`
- `handlers.go`: remove unused imports, remove/define `sseOverride`

### `cmd/hydra/server.go`
- Fix `paths.GetProjectDirFromCwd()` -> `paths.GetProjectRootFromCwd()`
- Fix undefined `projectRoot` variable
- Add `paths` import

## Implementation Order
1. `internal/config/config.go` - add embed import
2. `internal/api/handlers.go` - fix unused imports, sseOverride
3. `internal/paths/paths.go` - fix newline trim
4. `internal/docker/labels.go` - add AgentType, Prompt to AgentMetadata
5. `internal/docker/container.go` - AgentType, SpawnOptions, container naming, agent binds
6. `internal/git/worktree.go` - add FindProjectRoot, DeleteBranch, ListHydraBranches
7. `internal/heads/heads.go` - new package
8. `cmd/hydra/spawn.go` - rewrite
9. `cmd/hydra/list.go` - rewrite
10. `cmd/hydra/server.go` - fix
11. `internal/tui/model.go` - fix + spawn form
12. `cmd/hydra/tui.go` - pass project root
