# The built-in chat project

An always-present, Hydra-owned project that exists so you can start a
conversation without pointing Hydra at a repo first.

## Motivation

Every project in Hydra is a git repo the user registered. That is right for work,
but it means there is no way to just *ask something* - brainstorm, draft a note,
reason about several repos at once - without inventing a throwaway repo by hand.
Worse, a fresh install lands on `/`, which rendered a single dead-end line
("Select a project to get started"), so the first thing a new user saw was a
shrug.

The chat project fills that hole: a real project, owned and created by Hydra,
that always exists.

## Decisions (agreed)

- **It is a real git repo, not a worktree-less head.** See "Why not a
  worktree-less head" below - this is the load-bearing decision.
- **Its Git repository is stored at `~/.local/share/hydra/chat`**
  (`$XDG_DATA_HOME/hydra/chat`). It holds notes the user writes and may want
  backed up, so the repository is *data* (`share`), not generated state. Its
  registration lives in Hydra's SQLite database, and its worktrees, caches,
  uploads, and other generated files live under
  `<state-dir>/projects/_chat/`.
- **Its project ID is `_chat`** - collision-proof by construction, see below.
- **Created automatically at daemon boot**, never via the add-project flow, and
  it skips the trust modal: trust is a decision about unknown code the user
  points Hydra at, and Hydra created this repo itself.
- **`/` stops being a dead end**, falling back to `/project/_chat/` when there
  is nothing else to land on. In practice this is a rare last resort, not the
  everyday entry point - see below.
- **It is permanently listed** in the project dropdown, pinned above a divider,
  with its path suppressed (`~/.local/share/hydra/chat` is noise, not
  information). It must be listed: the dropdown button renders the *current*
  project's icon and name, so an unlisted chat project would leave the top bar
  with nothing to show while you were inside it.
- **The Ctrl+` switcher is deliberately left alone.** It is an alt-tab list
  ordered most-recently-visited first, so pinning anything to the front would
  break the "one tap = previous project" model it exists for. The chat project
  takes part in recency like any other project.
- **It is called "Chat", not "Scratch".** The earlier name implied something
  disposable, but nothing here is thrown away - conversations persist as
  branches. The ID (`_chat`) and directory (`hydra/chat`) were renamed to match,
  since a display name that disagrees with its ID is a lasting source of
  confusion. `upsertBuiltin` prunes a built-in left behind under an older ID, so
  the rename self-heals rather than leaving a second pinned row behind.
- **Its icon is seeded into its own `.hydra/config.toml`** at creation, using
  the ordinary project-icon mechanism (a top-level `icon = "MessageSquare"`).
  Written once, so changing it later via Settings is never clobbered. Two traps
  here, both hit during development:
  - An icon name missing from `LUCIDE_ICONS` (`web/src/lib/projectIconValue.ts`)
    does not fall back to a default - `ProjectIcon` renders the *literal string*
    into the row. Any icon shipped as a default must be registered there.
  - Without a seeded icon the default is a hashed-colour box containing the
    first character of the project ID, which for `_chat` is an underscore.
    `DefaultProjectIcon` now skips leading underscores as a backstop for when
    config seeding fails.

## Why not a worktree-less head (do not rebuild this)

The obvious design - a head with no branch and no worktree - does not work,
because three separate subsystems assume the worktree exists:

- **Chat transcripts are found by cwd.** Claude writes JSONL to
  `~/.claude/projects/<slug>`, where `<slug>` is a character substitution of the
  CLI's working directory. Hydra recomputes that slug from the worktree path
  (`paths.ClaudeProjectsSlug`, used by `claudeProjectDir` in
  `internal/http/chat_ws.go`). No worktree, no chat history - silently, with an
  empty transcript rather than an error.
- **The sandbox has nowhere to put the agent.** On Linux an empty
  `Options.WorktreePath` means no bind mount and no `--chdir`, so `exec.Cmd.Dir`
  falls back to whatever cwd `hydrad` happens to have
  (`internal/sandbox/linux.go`).
  On macOS the path is templated unconditionally into the Seatbelt profile
  (`internal/sandbox/darwin.go`), so an empty value produces a malformed or
  overly-broad profile.
- **Spawn is branch-and-worktree in one step.** `git.CreateWorktree` runs
  `git worktree add -b`, creating both atomically; there is no "branch only" or
  "neither" path. Even ephemeral test heads deliberately get a real throwaway
  worktree so the sandbox layout stays uniform (see the comment in
  `heads.SpawnHead`).

`Head.Worktree` being a `*string` is not evidence of designed-for optionality -
it is nil only for *archived* heads whose worktree was torn down.

So: give the chat project a real repo with a real initial commit (a worktree
cannot be created from a repo with no commits), and every one of these subsystems
works unmodified. Each conversation becomes a branch, which is a pleasant
accident: merging a chat head into the chat `main` archives that
conversation's files.

## Why the ID is `_chat`

`projects.sanitizeID` lowercases and maps every non-alphanumeric character to a
hyphen, then trims hyphens from both ends - so a generated ID always matches
`[a-z0-9-]` with no leading or trailing hyphen. **An underscore is unreachable by
the generator**, which makes `_chat` collision-proof by construction rather
than by a reserved-names list.

Plain `chat` would be actively worse, not merely risky. `generateID` builds
its `existing` set from the current project list, and the built-in is in that
list - so a user registering `~/code/chat` would be deduped to `chat2`
while the built-in kept the good name. The user's real project gets the ugly ID.

A leading hyphen is also unreachable, but `-chat` is miserable to pass as a
CLI argument. Underscore wins, and leaves `_`-prefixed IDs available as a
reserved namespace for any future built-ins.

## Why `/` redirects instead of rendering the composer

`RootLayout` derives the current project as:

```
const currentProjectId = routeParams.projectId ?? selectedProjectId
```

At `/` there is no route param, so this falls back to the persisted
`selectedProjectId` - the user's *last real project*. Rendering the chat
composer inline at `/` would therefore show a chat box in the main pane while
the sidebar listed a different project's agents and the dropdown showed a
different project's name. `ProjectLayout` would also never mount, so
`setSelectedProjectId` would never fire and the per-project view state and prompt
drafts (both keyed by project ID) would not bind.

Redirecting makes it a project you are genuinely *in*, so the sidebar,
dropdown, drafts and view state all work with no new chrome.

### ...but it is rarely the landing page, by design

It is tempting to describe the chat project as "where you land on first run".
It mostly is not, and that is deliberate. Project selection on boot is decided in
`useSystemStatus.ts`, in this order:

1. the project remembered in localStorage, if it still exists;
2. `status.default_project_id` - the project root `hydrad` was booted in;
3. the first registered project;
4. (new) the built-in chat project.

Because `hydrad` is always started *inside* a project, step 2 almost always
fires, so a user who runs Hydra in their repo keeps landing in their repo. That
is correct - overriding it to force the chat project to the front would be a
real regression, so the fallback deliberately sits at the bottom of the chain
and fires only when there is genuinely nothing else (no remembered project, no
default, no user projects).

The practical entry points are therefore the project dropdown and the Ctrl+`
switcher, not the URL. What matters is that it always *exists* and is one
click away - not that it greets you.

Note step 3 had to change too: it was a bare `ps[0]`, and since the built-in is
always in the list it could silently become the landing project for someone with
real work to open. It now prefers the first non-builtin project. The same
reasoning applies to the global Settings page, which uses the first project
merely as a carrier for a global config call.

The zero-state copy is deliberately *kept* rather than deleted. Chat-project
bootstrapping is best-effort (a broken git or unwritable HOME must not stop the
daemon booting), so if it fails there is no builtin project to redirect to and
`/` stays put. Deleting the message would turn that degraded path into a blank
white page; keeping it means the failure mode is merely the old behaviour.

## Gotchas

- **Bootstrap must complete before the server serves.** Every route and endpoint
  resolves a project through `Manager.GetByID` (server-side via
  `Server.resolveProjectRoot`, which 404s on a miss). If the chat project were
  created lazily on first visit, the first navigation to `/project/_chat/`
  would 404 against its own project.
- **`projects.length === 0` is never true again.** That check is load-bearing
  today - e.g. `ProjectDropdown` uses it to decide whether to render the project
  list section at all. Every "does the user have any projects?" test must become
  "any *non-builtin* projects". This is the class of bug that silently degrades
  first-run without failing a test, so grep for `projects.length` and
  `projects.some` when touching this.
- **Treat the built-in as empty for add-project affordances.** The project
  dropdown shows its add-folder actions when there are no user projects, then
  keeps them behind Edit list. Edit list can rename user projects, but the
  built-in keeps its system-defined name.
- **Project IDs are stable directory names, not arbitrary filesystem paths.**
  The SQLite catalogue maps each validated ID to `ProjectInfo.Path`, while
  generated project state lives under `projects/<id>`. So a bogus or hostile ID
  in a URL cannot
  traverse anywhere - it just 404s. No route guard is needed, and
  `/project/_chat/` *should* be visitable, since the dropdown, the Ctrl+`
  switcher and deep links all navigate by exactly that URL.
- **Only the branch picker is hidden, not the diff or merge.** It is tempting to
  strip all git chrome from the chat project, but chat heads write real
  files, so the diff is genuinely useful ("what did that conversation produce?")
  and merging into its default branch is how you keep a conversation's output.
  What *is* noise is `SpawnForm`'s base-branch picker - there is no work to
  stack on - so that is the only surface gated on `builtin`. Note this cannot
  be done by branch-gating: `DiffViewer` already no-ops when `branch_name` is
  null, but chat heads do have branches.

## Build order

1. `ProjectInfo.Builtin` + `EnsureChatProject` (git init, initial commit,
   register with the fixed ID), called from `runtime.go` right after
  `projects.NewManager(store)`.
2. `builtin` through the API (`api/openapi.yaml` -> `mage generate:go` + the web
   client).
3. `/` redirect; delete the two dead-end empty states.
4. Pin + path suppression in `ProjectDropdown` and `ProjectSwitcher`.
5. Audit `projects.length === 0`; hide `BranchSelector` in `SpawnForm` for the
   builtin project.

## Deliberately not built (yet)

- **Hydra control tools** (spawn a head in another project from a chat
  conversation).
  The `mcp__hydra__` server already has per-tool allow/block plumbing, so the
  tools themselves are small - but the pre-prompt forbids every head from
  operating Hydra, and relaxing that per-project is a trust-boundary decision
  worth taking on its own. The chat repo's own `.hydra/config.toml` is the
  natural home for the exception, since `policy.mcp_tools_allowed` and
  `pre_prompt` already live there and heads spawned *into* real projects would
  not inherit it.
- **Cross-project reads.** A chat head is sandboxed into its own worktree and
  cannot see `~/code`. Read-only binds of other project roots raise real
  questions about secret masking following those projects in. Spawning a head in
  the real project is the better answer.
