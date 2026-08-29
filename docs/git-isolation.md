# Git isolation modes

How much of the repository's `.git` a head can write, per head. The goal is to
bound the blast radius of an agent's git activity - from "accidentally commits to
the wrong branch" up to "a rogue/confused agent physically cannot damage the real
repo" - while keeping the normal edit -> commit loop working.

Two modes ship: **`readonly`** (the default - a hard anti-rogue boundary) and
**`off`** (the historical behaviour: a writable `.git` guarded only by the gate).
Either can be chosen per head, so a head that needs native in-sandbox git can drop
back to `off` one head at a time. Two earlier modes - `refs` and `clone` - were
built and then removed; see
[History](#history-removed-modes-refs-and-clone) for why.

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
| `off` | nothing | (heuristic gate only) | nothing | in-sandbox (raw `git commit` gate-denied; `mcp__hydra__git_commit` commits in-sandbox) |
| `readonly` (default) | the whole common dir (`refs/` + `objects/` + config + ...) | wrong-branch commits **and** rogue destruction of the object store | native in-sandbox `git add`/`stash`/history-editing | host-mediated |

Read it as: **`off` = heuristic guard (the gate), `readonly` = hard OS boundary.**

### `off`

The historical behaviour, still available per head. The whole common dir is
writable; the only guardrails are the
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

History and staging operations that write `.git` are provided as host-mediated
**git tools** (below), so the common loop plus reset/revert/rebase/partial-staging
all work. The remaining casualties are setup-time `.git` writers (husky, git-lfs,
submodules) - handled separately, see
[the long tail](#the-readonly-long-tail-husky--git-lfs--submodules).

## Host-mediated git path (`readonly`)

When `.git` is read-only, any git write (commit, reset, rebase, ...) must run on the
host. The sandbox cannot reach the daemon socket, so it uses the same **file-channel**
the gate approval flow uses (a writable per-head request dir + polling), not the socket.

- **Channel** (`internal/gitq`): `paths.GetGitopsDir(projectRoot, id)` ->
  `.hydra/local/gitops/<id>`, bound writable into the sandbox and pointed at by
  `HYDRA_GITOPS_DIR`. Each request is a `gitq.Request` with an `Op` tag
  (`commit`/`reset`/`revert`/`add`/`rebase`/`cherry_pick`/...) plus op-specific
  fields, one `<reqid>.req.json` / `<reqid>.result.json` pair.
- **In-sandbox side** (`internal/cli/mcp.go`): the `git_*` tools build a
  `gitq.Request`; when `HYDRA_GITOPS_DIR` is set (`readonly`) they write it to the
  channel and poll for the result, otherwise (`off`) they run it in-process via
  `git.RunGuardedOp`.
- **Host side** (`internal/http/gitops_watcher.go`, `RunGitopsWatcher`): a ~1s ticker
  iterates heads across projects and dispatches each pending request through
  `git.RunGuardedOp(worktree, hydra/<id>, req)` against the real writable `.git`,
  writing back the result. Registered in `internal/cli/runtime.go`.

**Same guard, every op, both paths.** `git.RunGuardedOp` fans out to a `Guarded*`
helper per op (`internal/git/guarded_ops.go`), and each re-checks that HEAD is the
head's own `hydra/<id>` branch (the `GuardedCommit` check) before touching git - so a
sandboxed agent can never rewrite `main` or a sibling through these tools, whether
in-sandbox (`off`) or host-mediated (`readonly`).

### The git tools

Exposed on the `hydra` MCP server, seeded for claude/codex/gemini
(`sandbox.AgentSupportsGitTools`) and advertised whenever the git path is wired.
Reads (`status`/`diff`/`log`/`show`) still run in the shell. Agents without the
tools (copilot, bash) can't do host-mediated git, so `readonly` falls back to `off`
for them (`heads.resolveGitIsolation`; the spawn dropdown disables the option too).
The decision gate - the wrong-branch heuristic and the readonly raw-git redirect -
is still Claude-only (its deny-hook wiring differs per agent); the tools carry their
own own-branch guard, so they're safe on codex/gemini without it.

- **`git_commit`** - stage (`add -A` or `paths`) + commit, or `amend`.
- **`git_add`** - stage whole files, or specific new-file line ranges (a filtered
  `-U0` patch applied with `git apply --cached`), for splitting one file across commits.
- **`git_reset`** - move HEAD (`soft`/`mixed`/`hard`; `hard` needs `confirm`) or
  unstage paths. The uncommit primitive.
- **`git_revert`** / **`git_cherry_pick`** - new commit; abort on conflict.
- **`git_rebase`** - plan-based non-interactive history edit (`pick`/`reword`/`squash`/
  `fixup`/`drop`, translated to a todo + `exec git commit --amend`). Optional `onto`
  transplants that exact plan onto a different ref (`git rebase --onto` semantics)
  while the own-branch guard still pins the operation to this head's branch. It does
  not change Hydra's stored base-branch metadata; that needs a future atomic
  `change_base_branch` operation rather than making raw history editing mutate UI
  state as a side effect. Leaves the rebase
  in progress on conflict; **`git_rebase_continue`** / **`git_rebase_abort`** drive it
  from there (they validate the in-progress rebase's `head-name` is the head's branch,
  since HEAD is detached mid-rebase).
- **`git_merge`** - merge a ref INTO the head's branch (typically its base, to update
  the head). The own-branch guard fixes the direction: HEAD is pinned to the head's
  branch, so a merge can only ever move that branch, never main or a sibling.
  Fast-forwards by default, `no_ff` forces a merge commit, `message` overrides the
  `Merge branch '<ref>'` subject. Unlike revert/cherry-pick this **leaves a conflict in
  progress** - updating from base is precisely the case the agent is meant to resolve -
  and **`git_merge_continue`** / **`git_merge_abort`** finish it. `continue` stages the
  still-unmerged paths itself (git won't conclude a merge while any remain) but refuses
  if any of them still contain `<<<<<<<` markers, so a conflict can't be committed raw.
- **`git_stash`** (`op`: push / pop / apply / list / drop) - park uncommitted work and
  bring it back; the way out of "your local changes would be overwritten by merge"
  without discarding them or committing something half-done. **Entries are per-head.**
  git's own `refs/stash` lives in the *common* dir, so every worktree shares one stash -
  head A could push and head B pop, silently handing over the work and losing it for A
  (verified: a stash pushed in one linked worktree is listed by another). These entries
  hang off `refs/worktree/hydra-stash`, one of the few namespaces git keeps per-worktree,
  so a sibling can't see or pop them. The mechanism is otherwise git's own: `git stash
  create` builds the same commit, the ref's reflog is the same stack (addressed as the
  familiar `stash@{N}`), and `git stash apply` reads it back. `include_untracked` stages
  the untracked files rather than passing `-u` to `create`, which bails out entirely when
  the tracked side is clean - so an untracked-only worktree would otherwise stash nothing;
  they come back staged. Refused mid-merge/rebase, where the captured conflict state
  would not restore cleanly.

### Readonly gate redirect

In `readonly`, a raw `git reset`/`add`/`revert`/`rebase`/`cherry-pick`/`merge`/`stash`/`commit` would
fail at the OS with a cryptic read-only-filesystem error. The gate (seeded with
`HostMediatedGit`, from `gitIso.HostMediatedCommit`) instead **denies those
subcommands with a message pointing at the matching `mcp__hydra__git_*` tool**. This
is UX, not a boundary - it's the same porous string match as the commit gate, but the
bypasses just hit the OS wall (readonly is the boundary).

## The readonly long tail: husky / git-lfs / submodules

`readonly` blocks *all* in-sandbox `.git` writes, including config, the index,
`modules/`, and `lfs/`. These three tools write `.git` as part of setup that the
**agent** triggers in-sandbox, so they hit the read-only mount. Since `readonly`
is the default, a repo that leans on any of them meets this on the first spawn -
either route the setup through host-run (below) or set
`[<agent>.policy] git_isolation = "off"` for that project:

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
(the `mcp__hydra__host_run` tool, or `/tmp/hydra-internal host-run` for agents without
it): `git submodule update --init` runs host-side against the real writable `.git`,
approval-gated. That covers the once-per-head setup without building submodule/lfs
-specific tooling. Caveats: it is approval-gated (a click per op, fine for setup, wrong
for a hot loop), and it runs **unsandboxed** - so avoid asking for `bun install` (that
runs all npm postinstall scripts on the host, a supply-chain vector); prefer narrow
git-only commands.

Do **not** try to fix this by carving `.git/config` read-write out of the readonly
bind. `.git/config` is a code-execution surface (`core.hooksPath`, `core.fsmonitor`,
aliases); a writable config lets the agent point a hook at an arbitrary script, and
since commits are host-mediated that hook then runs **on the host, outside the
sandbox** - a straight escape. It also lives in the shared common dir, so it is not
even per-head. Piecemeal RW holes erode the boundary exactly where it is most
dangerous.

## Config + surface

- **Per-agent config:** `[<agent>.policy] git_isolation = "readonly" | "off"`
  (nil -> `readonly`). Resolved per agent type like other policy fields
  (`config.PolicyConfig`, `ResolveGitIsolation`), normalized/validated with a
  `sandbox.GitIsolationMode` enum mirroring `NetworkMode`. Unknown values (including
  the removed `refs`/`clone`) fall back to the default, `readonly` - the protective
  posture, not the permissive one. An agent type without the hydra git tools
  (copilot, bash) is downgraded to `off` at spawn (`heads.resolveGitIsolation`), so
  the default never leaves a head unable to commit.
- **Per-spawn override:** `SpawnAgentRequest.git_isolation` (openapi) ->
  `heads.SpawnHeadOptions.GitIsolation` -> persisted on `db.Agent` -> drives the
  sandbox binds. Falls back to the config default when omitted.
- **Sandbox:** `sandbox.Options.GitIsolation` selects the bind: `off` = writable
  common dir (`addRWDir`); `readonly` = `--ro-bind` the whole common dir (Linux) /
  omit the write grant (darwin Seatbelt).
- **Web:** a git-isolation dropdown at the bottom of the spawn box's "Spawn
  options" popover (`SpawnForm.tsx` -> `SettingsPopover`'s `SettingsSelect`),
  below the chat-mode toggle and the base-branch selector. A dropdown rather than
  an inline list because the options carry two-line explanations that crowded out
  the other controls. The per-agent config default can also be set through
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

## Built surface

- **Settings selector:** an off/readonly control in project Settings (Sandbox
  Policy card, under Network Egress) for the per-agent config default, with an
  explanation tooltip. `ConfigForm.tsx`'s `SegmentedControl`. `readonly` being the
  default, it is `off` that is written explicitly - selecting readonly clears the
  key to keep the emitted config minimal.
- **Header indicator:** a lock badge to the right of the network-sandbox shield on
  the agent page (`AgentDetail.tsx` `GitIsolationBadge`), shown for `readonly` heads
  with a card tooltip. The effective mode is on the agent API response
  (`heads.EffectiveGitIsolation`).
- **Git tools + readonly gate redirect:** see
  [Host-mediated git path](#host-mediated-git-path-readonly).
- **Track affordance:** a "Check out locally" icon+chevron button on the agent page
  (`TrackBranchButton`) that opens a popover with `git checkout -t hydra-agents/<id>`
  (+ copy). On open it calls the `ensureTrackRemote` daemon action
  (`git.EnsureTrackRemote` -> `POST /api/projects/{id}/track-remote`), which
  idempotently configures the local `hydra-agents` remote, so the shown command
  stays short.

## Open questions / not yet built

- **Decision gate for codex/gemini (low priority):** the git_* tools are seeded for
  codex/gemini, but the decision gate (wrong-branch heuristic + readonly raw-git
  redirect) is still Claude-only. Extending it needs each agent's hook block-contract
  (gemini honours a non-zero hook exit + `systemMessage`; codex is a compiled binary
  whose contract we can't inspect) and, crucially, a live-head test to confirm the
  block actually enforces - which isn't reproducible in-sandbox. Low priority: the OS
  sandbox is the real boundary, the tools carry their own own-branch guard, and the
  gate is a bypassable heuristic anyway. Hold until it can be verified on a real head.
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
