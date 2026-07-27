# Git isolation modes

How much of the repository's `.git` a head can write, per head. The goal is to
bound the blast radius of an agent's git activity - from "accidentally commits to
the wrong branch" up to "a rogue/confused agent physically cannot damage the real
repo" - while keeping the normal edit -> commit loop working.

Two modes ship: **`off`** (default, today's behaviour) and **`readonly`** (a hard
anti-rogue boundary). Both are opt-in per head, so `readonly` can be dogfooded one
head at a time. Two earlier modes - `refs` and `clone` - were built and then
removed; see [History](#history-removed-modes-refs-and-clone) for why.

## Background: why this is not a one-liner

A Hydra head works in a **linked git worktree** (`git worktree add`). A linked
worktree keeps *all* of its git state - index, HEAD, refs, objects, logs - in the
**main repo's shared common dir** (`<main>/.git`), not in the worktree. To let an
agent `git commit` at all, Hydra binds that whole common dir **writable** into the
sandbox (`internal/sandbox/linux.go`, `addRWDir(opts.GitCommonDir)`). That is the
root of the danger: a writable common dir means the agent can write refs for *any*
branch (including `main` and sibling heads), and can delete/rewrite the shared
object store.

Two empirical facts shape the design (both verified against real `git`):

1. **`objects/` is shared-fate.** Every branch - `main`, every head, all history -
   dedupes into the same object files. Content-addressing prevents *undetected
   substitution* (a tampered object fails its sha check on read) but does nothing
   against **deletion or truncation**. So with `objects/` writable, an agent can
   `rm -rf .git/objects/...`, `git gc --prune=now`, or truncate an object and brick
   `main` *and* every sibling branch - the refs still point at shas whose data is
   gone. This is why the only real boundary locks the *whole* common dir, objects
   included (a refs-only lock does not save you).

2. **Git's lock discipline is directory-granular.** Git creates `<thing>.lock` in
   the *containing* directory, so `chmod a-w .git/config` does nothing (git writes
   `config.lock` in the still-writable `.git/`). Protection must lock the
   *directory*, done with a read-only bind of the whole common dir, not file
   permissions.

## The two modes

| Mode | What is read-only in the sandbox | Stops | Agent loses | Commit path |
|------|----------------------------------|-------|-------------|-------------|
| `off` (default) | nothing | (heuristic gate only) | nothing | in-sandbox (raw `git commit` gate-denied; `mcp__hydra__git_commit` commits in-sandbox) |
| `readonly` | the whole common dir (`refs/` + `objects/` + config + ...) | wrong-branch commits **and** rogue destruction of the object store | native in-sandbox `git add`/`stash`/history-editing | host-mediated |

Read it as: **`off` = heuristic guard (the gate), `readonly` = hard OS boundary.**

### `off`

Today's behaviour. The whole common dir is writable; the only guardrails are the
decision gate (raw `git commit` denied, `git push` denied) and the
`mcp__hydra__git_commit` tool, which commits in-sandbox onto the head's own branch.
A determined or buggy agent can still reach other branches / the object store. This
is a heuristic guard, not a boundary - but it already turns "commits to the wrong
branch" from a live risk into a caught one, which covers the common case.

### `readonly` (anti-rogue)

Bind the **whole** common dir read-only; keep only the worktree writable. Effect
(verified):

- Works natively: `git status/diff/log/show` (pure reads).
- Blocked by the OS: everything that writes `.git` - `git add` (writes objects +
  index), `commit`, `stash`, `reset`, `checkout -b`, `config --local`, hook
  installs, and object destruction. A rogue agent *cannot write `.git` at all*.
- Staging **and** commit are host-mediated. The agent edits files in the writable
  worktree; the `mcp__hydra__git_commit` tool stages (`add -A` or `paths`) and
  commits host-side. No separate add/rm/mv tool is needed: `rm`/`mv` are worktree
  operations (writable) and `git add -A` picks up the deletions/renames. So the
  common loop - edit files, commit everything - works out of the box.

The casualties are in-sandbox operations that legitimately write `.git`: `git add -p`
(hunk staging), `stash`, and history-editing (`reset --soft`, squash, `rebase -i`,
`--fixup`). These are *advanced* ops; add host-mediated tools for them lazily, only
when a real workflow needs one. Setup-time `.git` writers (husky, git-lfs,
submodules) are handled separately - see [the long tail](#the-readonly-long-tail-husky--git-lfs--submodules).

## Host-mediated commit path (`readonly`)

When `.git` is read-only, an in-sandbox `git commit` fails writing the object/ref, so
the commit must run on the host. The sandbox cannot reach the daemon socket, so it
uses the same **file-channel** the gate approval flow uses (a writable per-head
request dir + polling), not the socket.

- **Channel dir:** `paths.GetCommitDirFromProjectRoot(projectRoot, id)` ->
  `.hydra/local/commits/<id>`, bound writable into the sandbox and pointed at by
  `HYDRA_COMMIT_DIR`.
- **In-sandbox side** (`mcp__hydra__git_commit`, `internal/cli/mcp.go`): when
  `HYDRA_COMMIT_DIR` is set (i.e. `readonly`), the tool writes a request file
  `<reqid>.req.json` (`{message, paths, amend}`) and polls for `<reqid>.result.json`
  instead of running git itself. When it is unset (`off`), it commits in-sandbox as
  today.
- **Host side** (`internal/http/commit_watcher.go`, modelled on
  `review_watcher.go`): a ticker loop iterates heads across all projects, and for
  each pending request resolves the head's worktree + branch, re-validates the
  guardrails host-side (`git.GuardedCommit`: the worktree is on the head's own
  `hydra/<id>` branch), runs `git -C <worktree> add ... && git commit ...` with the
  real (writable) `.git`, and writes back `<reqid>.result.json`. Registered via
  `go server.RunCommitWatcher(ctx, roots)` in `internal/cli/runtime.go`.

The own-branch-only / inside-worktree guardrails run in the same `git.GuardedCommit`
helper whether the commit is in-sandbox (`off`) or host-side (`readonly`) - same
checks, trusted location.

## The readonly long tail: husky / git-lfs / submodules

`readonly` blocks *all* in-sandbox `.git` writes, including config, the index,
`modules/`, and `lfs/`. These three tools write `.git` as part of setup that the
**agent** triggers in-sandbox, so they hit the read-only mount:

- **husky** - the `prepare` script (`"prepare": "husky"`) runs during dep install and
  writes `core.hooksPath` into `.git/config`. Usually skippable: an agent rarely
  needs commit hooks (`bun install --ignore-scripts`, commit `--no-verify`), so this
  mostly evaporates.
- **git-lfs** - `git lfs install` writes filter config; smudge/clean filters read and
  write `.git/lfs`; `git add` on an LFS file writes the index and object store.
- **submodules** - `git submodule update --init` writes `.git/modules/<name>` and the
  nested worktrees.

lfs and submodules need the actual file/submodule *content* to build and run, so they
can't just be skipped. The intended escape valve is the existing **host-run** hatch
(`/tmp/hydra-internal host-run -- <cmd>`): `host-run -- git submodule update --init`
runs host-side against the real writable `.git`, approval-gated. That covers the
once-per-head setup without building submodule/lfs-specific tooling. Caveats: it is
approval-gated (a click per op, fine for setup, wrong for a hot loop), and it runs
**unsandboxed** - so avoid `host-run -- bun install` (that runs all npm postinstall
scripts on the host, a supply-chain vector); prefer narrow git-only commands.

Do **not** try to fix this by carving `.git/config` read-write out of the readonly
bind. `.git/config` is a code-execution surface (`core.hooksPath`, `core.fsmonitor`,
aliases); a writable config lets the agent point a hook at an arbitrary script, and
since commits are host-mediated that hook then runs **on the host, outside the
sandbox** - a straight escape. It also lives in the shared common dir, so it is not
even per-head. Piecemeal RW holes erode the boundary exactly where it is most
dangerous.

## Config + surface

- **Per-agent config:** `[<agent>.policy] git_isolation = "off" | "readonly"`
  (nil -> `off`). Resolved per agent type like other policy fields
  (`config.PolicyConfig`, `ResolveGitIsolation`), normalized/validated with a
  `sandbox.GitIsolationMode` enum mirroring `NetworkMode`. Unknown values (including
  the removed `refs`/`clone`) fall back to `off`.
- **Per-spawn override:** `SpawnAgentRequest.git_isolation` (openapi) ->
  `heads.SpawnHeadOptions.GitIsolation` -> persisted on `db.Agent` -> drives the
  sandbox binds. Falls back to the config default when omitted.
- **Sandbox:** `sandbox.Options.GitIsolation` selects the bind: `off` = writable
  common dir (`addRWDir`); `readonly` = `--ro-bind` the whole common dir (Linux) /
  omit the write grant (darwin Seatbelt).
- **Web:** a git-isolation dropdown on the spawn box (`SpawnForm.tsx`'s
  `SpawnOptionsMenu`), grouped with the chat-mode and base-branch controls under a
  kebab/overflow menu. The per-agent config default can also be set through
  `.hydra/config.toml` (`[<agent>.policy] git_isolation`) directly.

## Tracking an agent's branch from the main repo

Goal: from the user's own checkout, follow a head's branch with a plain `git pull`
as the agent commits. This is independent of the isolation mode - it works today
against a plain linked worktree - and needs no changes to how Hydra names or manages
branches.

The obstacle: a head works in a *linked worktree*, so `refs/heads/hydra/<id>`
physically lives in the main repo's `.git` (shared common dir) and the agent's
commits land there live - but the branch is **worktree-locked**, so
`git checkout hydra/<id>` in the main repo is refused ("already checked out at ...").

The clean model is **Hydra as a git remote**: expose the `hydra/*` branches through
a remote namespace and let git's remote-tracking machinery do the work. A
remote-tracking ref is exactly "a ref someone else keeps force-moving that I follow
at my own pace" - your working branch only moves when *you* pull, and history
rewrites show up as a harmless "forced update" on fetch instead of a wall:

```bash
git remote add agents .          # the repo is its own remote (url ".")
git config remote.agents.fetch '+refs/heads/hydra/*:refs/remotes/agents/*'
git fetch agents
git checkout -t agents/<id>       # local branch tracking agents/<id>
                                  # or: git switch -c review --track agents/<id>
git pull                          # fast-forwards as the agent commits
```

`git checkout -t <ref>` (`--track`) creates a local branch - named after the part
after the remote, i.e. `<id>` - whose *upstream* is the remote-tracking ref, which
is what makes a bare `git pull` and the `git status` ahead/behind counts work.

**Do not name the remote `hydra`.** The agent branches are real local branches at
`refs/heads/hydra/<id>`; a remote named `hydra` puts remote-tracking refs at
`refs/remotes/hydra/<id>`, and the shorthand `hydra/<id>` then matches both.
Verified behaviour of that collision:

- commands resolving to a commit (`git merge hydra/<id>`, `git rev-parse
  hydra/<id>`) print `warning: refname 'hydra/<id>' is ambiguous` and silently pick
  the **local** branch - gitrevisions precedence is `refs/` -> `refs/tags/` ->
  `refs/heads/` -> `refs/remotes/`, so `refs/heads` wins;
- commands needing a symbolic ref (`git rev-parse --symbolic-full-name`) hard-**error**
  with `refname ... is ambiguous`;
- worst, `git checkout -t hydra/<id>` resolves to the *local* branch and tracks
  that, silently defeating the point.

Naming the remote anything else (`agents`, or `hydra-agents` for branding) keeps
`agents/<id>` unambiguous and leaves plain `hydra/<id>` meaning the local branch, so
everything Hydra does internally is untouched. (The pre-existing `origin/hydra/*`
remote-tracking refs are fine for the same reason - the `origin/` prefix avoids the
collision.)

## Open questions / not yet built

- **Track affordance:** a "Track branch" button on the agent page that ensures the
  `agents` remote + refspec exist and copies `git checkout -t agents/<id>` for the
  head in view, so nobody has to remember the incantation. A copy button also hides
  the remote name, which is why the branch-split below isn't worth its cost.
- **Settings selector + explanation:** a git-isolation control (off/readonly) in
  project Settings for the config default, alongside the network-mode selector, with
  a one-line explanation. Today the default is only settable via `config.toml`.
- **Header indicator:** a git-isolation indicator to the right of the network-sandbox
  shield in the agent header, matching the "egress locked" affordance - a small badge
  + tooltip so a `readonly` head is visible at rest.
- **Branch-split alternative (considered, not preferred):** move the worktree onto
  `hydra-internal/<id>` and leave `hydra/<id>` as a plain, non-worktree-locked branch
  the user checks out directly - optionally with `branch.hydra/<id>.remote = .` and
  `.merge = refs/heads/hydra-internal/<id>` so `git pull` fast-forwards it locally
  with no remote configured. This gives a stable, user-owned `hydra/<id>` that only
  the user moves, but at the cost of a medium refactor (every internal use of
  `hydra/<id>` moves to the internal name). The `agents/` remote prefix delivers the
  same separation for free, so the remote is preferred unless a bare
  `git checkout hydra/<id>` is judged worth the churn.

## History: removed modes (`refs` and `clone`)

Two intermediate modes were built and then removed as more surface than the threat
model justified:

- **`refs`** (anti-accident) bound `refs/` + `packed-refs` read-only while leaving
  `objects/` writable, blocking wrong-branch commits and branch switches but **not**
  object-store destruction (Background #1). It was an accident guard, not a boundary
  - a marginal step over `off`'s gate, which already catches the accident case.
- **`clone`** gave each head a standalone `git clone --shared` (borrowing `main`'s
  objects via alternates) with the branch mirrored back into the main repo. It was
  the only mode with full native git (husky/LFS/submodules) and a non-worktree-locked
  branch, but it was the hacky one: a per-head mirror watcher on the critical path,
  standalone-clone teardown special-casing, and a "`git gc --prune` on `main` while
  heads are live" hazard. Its niche wins are better served by `readonly` plus
  host-run for the rare setup op.

Both removals kept `off` + `readonly` and the host-mediated commit machinery (which
`readonly` uses). The git history has the full implementations if either is ever
wanted back.
