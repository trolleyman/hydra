# Git isolation modes

How much of the repository's `.git` a head can write, per head. The goal is to
bound the blast radius of an agent's git activity - from "accidentally commits to
the wrong branch" up to "a rogue/confused agent physically cannot damage the real
repo" - while keeping the normal edit -> commit loop working.

This is opt-in and per-head, so it can be rolled out gradually and tested one head
at a time. Default stays `off` (today's behaviour) until the stricter modes prove
out.

## Background: why this is not a one-liner

A Hydra head works in a **linked git worktree** (`git worktree add`). A linked
worktree keeps *all* of its git state - index, HEAD, refs, objects, logs - in the
**main repo's shared common dir** (`<main>/.git`), not in the worktree. To let an
agent `git commit` at all, Hydra binds that whole common dir **writable** into the
sandbox (`internal/sandbox/linux.go`, `addRWDir(opts.GitCommonDir)`). That is the
root of the danger: a writable common dir means the agent can write refs for *any*
branch (including `main` and sibling heads), and can delete/rewrite the shared
object store.

Two empirical facts drive the design (both verified against real `git`):

1. **`objects/` is shared-fate.** Every branch - `main`, every head, all history -
   dedupes into the same object files. Content-addressing prevents *undetected
   substitution* (a tampered object fails its sha check on read) but does nothing
   against **deletion or truncation**. So with `objects/` writable, an agent can
   `rm -rf .git/objects/...`, `git gc --prune=now`, or truncate an object and brick
   `main` *and* every sibling branch - the refs still point at shas whose data is
   gone. Read-only *refs* does not save you here.

2. **Git's lock discipline is directory-granular.** Git creates `<thing>.lock` in
   the *containing* directory, so `chmod a-w .git/config` does nothing (git writes
   `config.lock` in the still-writable `.git/`). Protection must lock the
   *directory* (`refs/` read-only blocks ref creation; `packed-refs.lock` lives in
   the top common dir). So a "surgical" per-subpath lock is done with layered
   read-only binds, not file permissions.

## The modes

Ordered by threat model, not just by what is locked:

| Mode | What is read-only in the sandbox | Stops | Does **not** stop | Agent loses | Commit path |
|------|----------------------------------|-------|-------------------|-------------|-------------|
| `off` (default) | nothing | (heuristic gate only) | wrong-branch commit, destruction | nothing | in-sandbox (raw `git commit` gate-denied; `mcp__hydra__git_commit` commits in-sandbox) |
| `refs` | `refs/` + `packed-refs` | off-branch / wrong-branch commits, branch switch, reset/rebase | **`rm`/`gc` of `objects/` still bricks the repo** | commit, reset, rebase, tag (blocked, or host-mediated) | host-mediated |
| `readonly` | whole common dir (`refs/` + `objects/` + ...) | above **+ rogue destruction of the object store** | - | native `git add`/`stash`/history-editing | host-mediated |
| `clone` | (agent has a private object store; the real repo is unreachable) | above, with **full native git** | - | *nothing* | native, in the head's own repo; daemon mirrors the branch back |

Read the ladder as: **`off` = nothing, `refs` = anti-accident, `readonly` =
anti-rogue, `clone` = anti-rogue + full git.**

### `off`

Today's behaviour. The whole common dir is writable; the only guardrails are the
decision gate (raw `git commit` denied, `git push` denied) and the
`mcp__hydra__git_commit` tool, which commits in-sandbox onto the head's own branch.
A determined or buggy agent can still reach other branches / the object store. This
is a heuristic guard, not a boundary.

### `refs` (anti-accident)

Bind `refs/` + `packed-refs` read-only; keep `objects/` and the per-worktree gitdir
writable. Effect (verified):

- Works natively in-sandbox: `git status/diff/log`, `git add`, `git rm --cached`,
  unstage, `git restore <file>`.
- Blocked by the OS: any ref update - `git commit`'s ref move, `git branch`,
  `git switch -c`, `reset <commit>`, `rebase`, `tag`, `update-ref`. So a commit can
  never land on `main` or a sibling, and the head cannot leave its branch.
- **Not protected:** the writable `objects/` still lets a rogue agent destroy the
  shared object store (see Background #1). `refs` is therefore an *accident* guard
  (a confused agent committing to the wrong place), **not** a defence against a
  malicious one. Do not file it under "security boundary".

The only normal-loop casualty is the commit's ref update, which is **host-mediated**
(see below).

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
  operations (writable) and `git add -A` picks up the deletions/renames.

Casualties to accept (things that legitimately write `.git`): in-sandbox
`git add -p` (hunk staging), `stash`, history-editing (`reset --soft`, squash,
`rebase -i`, `--fixup`), and setup-time writers - **husky hook installs, `git-lfs`,
submodule checkout**. For repos that need those, use `clone`.

### `clone` (anti-rogue + full git)

Each head is its own repo that **borrows the main repo's objects read-only via git
alternates** (`git clone --shared`, i.e. `objects/info/alternates` ->
`<main>/.git/objects`). The agent gets 100% native git on its branch; a rogue agent
can only trash its *own* private store (discarded on kill - `main` and siblings are
physically unreachable). Properties:

- The head borrows `main`'s history read-only and writes only *new* objects into its
  private store; a `rm -rf` / `git gc` in the head cannot touch the borrowed objects.
- Concurrency is safe because git objects are **immutable and append-only**: the
  host adding commits to `main` (another head merging) never invalidates a
  borrower's reads (head stays `fsck`-clean). The one hazard is the host *deleting*
  base objects a head still borrows - i.e. `git gc --prune` on `main` while heads
  are live - which Hydra does not do automatically (note it if you add manual gc).

There is *no* host-side commit - the agent commits natively. Instead the daemon
**mirrors** the head's branch back into the main repo so the rest of Hydra keeps
working (see below).

Implementation:
- **Sandbox** (`internal/heads` `commonDirForSandbox`): clone mode binds no shared
  common dir (`GitCommonDir=""`); the head's own `.git` is inside the writable
  worktree, and `<main>/.git/objects` is reachable read-only via the sandbox's root
  bind for the clone's alternate (`.git` is not masked).
- **Create** (`git.CreateCloneWorktree`): `git clone --shared --no-checkout <main>
  <worktree>` + `checkout -b hydra/<id> <baseSHA>`, then an initial mirror so the
  branch exists in `main` immediately (existence/diff checks).
- **Mirror-back** (`git.MirrorCloneBranch`): force-updates `refs/heads/hydra/<id>` in
  `main` from the head's repo (fetching its new objects), a no-op for linked
  worktrees and already-current tips. Driven by `RunCloneMirrorWatcher` (~1s, keeps
  diffs/tests/artifacts within a tick) and called synchronously before a merge
  (`heads.MirrorCloneHead`, since merge can't tolerate the poll lag). Because `main`
  always mirrors the branch, diff/merge/tests/conflict/artifact reads that run
  against the main repo work unchanged.
- **Teardown** (`git.RemoveWorktreeTree`): a standalone clone is `os.RemoveAll`'d
  (`git worktree remove` would reject it); layout is detected by whether
  `<worktree>/.git` is a dir (clone) or a file (linked worktree), so no mode needs
  threading. The mirror ref in `main` is deleted like any head branch.
- **Update-from-base**: a clone head's local base is a clone-time snapshot, so the
  handler `git fetch origin` + merges `origin/<base>` instead of the stale local ref.

Residual: committed diffs/tests/artifacts can lag the head by up to one mirror tick
(~1s) - the uncommitted overlay is always live from the worktree, and merge mirrors
synchronously, so nothing incorrect merges.

> Note: an overlayfs copy-on-write of `.git` was considered and rejected. The kernel
> documents modifying an overlay's lower dir while it is mounted as *undefined
> behaviour*, and Hydra's real `.git` does change during a head's life (merges, gc,
> other heads), so the lower mutates underneath the overlay. The **alternates**
> mechanism above avoids this entirely by never sharing a mutable directory.

## Host-mediated commit path (`refs` and `readonly`)

When refs are read-only, an in-sandbox `git commit` fails at the ref update, so the
commit must run on the host. The sandbox cannot reach the daemon socket, so it uses
the same **file-channel** the gate approval flow uses (a writable per-head request
dir + polling), not the socket.

- **Channel dir:** `paths.GetCommitDirFromProjectRoot(projectRoot, id)` ->
  `.hydra/local/commits/<id>`, bound writable into the sandbox and pointed at by
  `HYDRA_COMMIT_DIR`.
- **In-sandbox side** (`mcp__hydra__git_commit`, `internal/cli/mcp.go`): when
  `HYDRA_COMMIT_DIR` is set (i.e. a host-mediated mode), the tool writes a request
  file `<reqid>.req.json` (`{message, paths, amend}`) and polls for
  `<reqid>.result.json` instead of running git itself. When it is unset (`off`), it
  commits in-sandbox as today.
- **Host side** (`internal/http/commit_watcher.go`, modelled on
  `review_watcher.go`): a ticker loop iterates heads across all projects, and for
  each pending request resolves the head's worktree + branch, re-validates the
  guardrails host-side (worktree is on the head's own `hydra/<id>` branch), runs
  `git -C <worktree> add ... && git commit ...` with the real (writable) `.git`, and
  writes back `<reqid>.result.json`. Registered via
  `go server.RunCommitWatcher(ctx)` in `internal/cli/runtime.go`.

The guardrails (own-branch-only, inside-worktree) that today live in the in-sandbox
`gitCommit` helper move host-side for these modes - same checks, trusted location.

## Config + surface

- **Per-agent config:** `[<agent>.policy] git_isolation = "off" | "refs" | "readonly" | "clone"`
  (nil -> `off`). Resolved per agent type like other policy fields
  (`config.PolicyConfig`, `ResolvePolicy`), normalized/validated with a
  `sandbox.GitIsolationMode` enum mirroring `NetworkMode`.
- **Per-spawn override:** `SpawnAgentRequest.git_isolation` (openapi) ->
  `heads.SpawnHeadOptions.GitIsolation` -> persisted on `db.Agent` -> drives the
  sandbox binds. Falls back to the config default when omitted.
- **Sandbox:** `sandbox.Options.GitIsolation` selects the bind: `off` = writable
  common dir (today); `refs` = writable common dir with `refs/` + `packed-refs`
  re-bound read-only on top; `readonly` = `--ro-bind` the whole common dir; `clone`
  binds no common dir (the head is a standalone clone - see the `clone` section).
- **Web:** a git-isolation dropdown on the spawn box, grouped with the chat-mode and
  base-branch controls under a kebab/overflow menu; a matching selector in project
  Settings for the config default.

## Rollout / status

1. `off` stays the default.
2. `refs` + `readonly` ship together (one bind knob + the host-commit watcher).
   Dogfood per head.
3. `clone` is the end state for repos that need full native git (hunk staging,
   history cleanup, husky/LFS/submodules): a standalone `git clone --shared` per
   head with a mirror-back into the main repo (see the `clone` section).
