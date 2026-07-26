# Plan: adopt an existing PR/MR as a head

Status: **BUILT.** Steps 1-5 below are implemented: `forge.ListMRs`/`GetMR`,
`git.PRHeadRefspec`/`FetchRefspec`, `heads.SpawnHeadOptions.Adopt`, the
`adopt_mr` spawn field + `GET .../reviews` endpoint, the push-back path with the
foreign-MR guards, and the web PR picker (`PRPicker.tsx`) + adopted-head
labelling. This document is kept as the rationale/design record; the sections
below describe how it works.

Known follow-ups (not blockers): the `gh --json` fork-detection field names want
a live-auth verification pass (see the CAVEAT in step 4); token/REST forge auth
is still CLI-only; and the fetch-fresh spawn base (NON_LOCAL_INTEGRATION.md 3.6)
that keeps an adopted head's diff crisp remains unbuilt.

## Problem

Hydra's forge integration is **outbound only**. Every head begins life as a fresh
`hydra/<id>` branch cut from a *local* base branch (`heads.SpawnHead` ->
`git.CreateWorktree`, which always runs `git worktree add -b`,
`internal/git/worktree.go:70`), and the only thing the forge layer does with it is
push that branch and open a *new* MR (`publishHead`, `internal/http/publish.go:152`).

Consequently there is no way to:

- browse the open PRs on the repo - `forge.Provider` (`internal/forge/forge.go:99`)
  can only look an MR up by its source branch or by ID, and has no enumeration;
- start a head **on** an existing PR - nothing in `internal/git` or `internal/heads`
  fetches a remote PR head, and `CreateWorktree`'s base must be a local ref;
- push back to anything other than the single configured `review.remote`
  (`pushHeadToMR` hardcodes it, `publish.go:295`), so a fork PR is unreachable.

The gap matters most for the case Hydra is otherwise well suited to: *"here is a
PR someone opened, address the review comments on it."* The agent-side half of
that already works - the review watcher writes a per-head review file that the
in-sandbox MCP server exposes as `get_review_comments`
(`internal/mcpserver/server.go:183`) - it just has no way to be pointed at a PR
Hydra didn't itself create.

## Key insight: an adopted PR is a pre-linked head

The publish flow **already** models exactly the relationship we need: *a local
branch that pushes to a named remote branch which is attached to an MR.* That link
is persisted on the agent row as `DownstreamBranch` + `ReviewURL` / `ReviewID` /
`ReviewProvider` / `ReviewTargetBranch` (`internal/db/model_unix.go:100-115`, written
by `Store.SetReviewLink`, `internal/db/queries.go:360`), and `pushToMr` / `pullFromMr`
already move commits across it in both directions.

So adoption is not a new subsystem. It is **populating that link at spawn time
instead of at publish time**:

| | published head (today) | adopted head (proposed) |
|---|---|---|
| local branch | `hydra/<id>` | `hydra/<id>` (unchanged) |
| based on | local `BaseBranch` | the fetched **PR head** |
| `DownstreamBranch` | from `push_branch_template` | the PR's `headRefName` |
| link written | after `EnsureMR` | at spawn, from `GetMR` |
| push target | `review.remote` | the PR **head repo** (may be a fork) |
| `BaseBranch` | where work merges back | the PR's **target** branch |

Everything downstream of the link - the review watcher's status/discussion polling,
the MCP review file, `MRStateChip`, the tests panel, the diff viewer - then works on
an adopted head with no changes at all.

Setting `BaseBranch` to the PR's target branch is what makes the diff viewer show
**the whole PR** (target...`hydra/<id>`), your edits included, which is the right
default for reviewing-and-fixing. It relies on the local target branch being
reasonably fresh; the pre-existing "fetch-fresh spawn base" gap
(NON_LOCAL_INTEGRATION.md 3.6) applies here too and is worth doing first or at the
same time.

## Design

### 1. Fetching the PR head without touching the user's git config

Both forges expose a **pseudo-ref on the target repo** that resolves to the PR
head, *including for PRs raised from a fork*:

- GitHub: `refs/pull/<number>/head`
- GitLab: `refs/merge-requests/<iid>/head`

This is the load-bearing trick of the whole design: it means the read path is a
plain `git fetch origin` with an explicit refspec and **never needs a remote added
for the fork**. Fetch into a private namespace so the ref never shows up in branch
pickers or `hydra/*` globs:

```
git fetch <review.remote> refs/pull/<n>/head:refs/hydra/pr/<provider>/<n>
```

New in `internal/git`: `PRHeadRefspec(provider, id) (remoteRef, localRef string)`
and a `FetchRefspec(ctx, projectRoot, remote, refspec) error` alongside the existing
`Fetch` (`internal/git/push.go:141`) - same `nonInteractiveGitEnv` + AuthError
classification, which we get for free by reusing `classifyGitNetworkError`.

`git.CreateWorktree` needs **no change**: it passes its base straight to
`worktree add -b`, and `ValidateRef` (`internal/git/worktree.go:22`) only rejects
empty/leading-dash, so `refs/hydra/pr/github/123` is already a legal base.

The **push** path cannot use the pseudo-ref (it is read-only on both forges). It
needs the head repo's clone URL plus `headRefName`, which is why `GetMR` below
returns them.

### 2. The head's "upstream review ref"

Several existing call sites compare the head branch against its remote counterpart -
`git.AheadBehind` / `TrackingRef` for the Push-to-MR / Pull-from-MR affordances, and
`pullFromMr` itself. Today they assume `<remote>/<downstream>`, which does not exist
locally for a fork PR.

Introduce one derived concept, `reviewTrackingRef(head) string`:

- published head -> `<remote>/<DownstreamBranch>` (exactly today's behaviour)
- adopted head -> `refs/hydra/pr/<provider>/<id>` (refreshed by the watcher's fetch)

Every existing consumer then keeps working through a single helper. `pullFromMr`
becomes "re-fetch the pseudo-ref, then merge it" for adopted heads.

### 3. New persisted state

Two new columns on `db.Agent`, both defaulting to today's behaviour when empty:

- **`ReviewPushURL string`** - where `pushHeadToMR` sends the refspec. Empty = the
  configured `review.remote` (all existing heads). For an adopted PR it is the head
  repo's clone URL, which handles the fork case without a remote. `PushRefspec`
  (`push.go:299`) passes its `remote` argument straight to `git push`, which accepts
  a URL there, and `ValidateRef` lets a URL through - so this is a one-line change at
  the call site, not a new push primitive. Validate it looks like a URL/remote name
  before storing, not at push time.
- **`ReviewAdopted bool`** - "Hydra did not create this MR." Not derivable from the
  other fields, and load-bearing for the guards under Traps below.

`SetReviewLink` gains the two parameters (or a small options struct - it already
takes six positional strings, which is at the limit).

### 4. Forge: two new Provider methods

```go
// MRRef is everything needed to check a PR out and push back to it.
type MRRef struct {
    ID           string // PR number / MR iid
    URL          string
    Title        string
    Author       string
    State        string // reuse the normalized State* consts
    Draft        bool
    HeadRef      string // source branch name ON THE HEAD REPO
    HeadRepoURL  string // clone URL of the repo hosting HeadRef
    TargetBranch string
    CrossRepo    bool   // head repo != base repo (a fork)
    CanPush      bool   // "allow edits by maintainers" / allow_collaboration
}

ListMRs(ctx, repoDir, remote string, o ListOptions) ([]MRRef, error)
GetMR(ctx, repoDir, remote, id string) (MRRef, error)
```

`ListOptions` wants at least `State`, `Author` ("mine" / "@me"), `Search`, `Limit`.

GitHub via `gh pr list --json ...` / `gh pr view <id> --json ...`. The fields we need
beyond the ones already fetched (`ghViewFields`, `internal/forge/github.go:77`) are
`headRefName`, `headRepository`, `headRepositoryOwner`, `isCrossRepository`,
`maintainerCanModify`, `baseRefName`, `author`. **These names are unverified** - `gh`
is on PATH here but unauthenticated, and it refuses to list valid `--json` fields
without auth. Confirm with `gh pr list --json bogus` (which prints the valid set)
before writing the structs; `maintainerCanModify` in particular may be `pr view`-only
and not available on `pr list`, in which case the picker shows it lazily on selection
rather than in the list.

GitLab is cheaper: `glab mr list -F json` is **already** used
(`internal/forge/gitlab.go:77`), and the MR object carries `source_branch`,
`source_project_id`, `target_branch`, `allow_collaboration`. Resolving
`source_project_id` -> clone URL needs one extra `glab api projects/<id>` call.

Both are testable against the existing fake `runner` seam (`forge.go:115`) with no
network.

### 5. Wiring

**Spawn.** `SpawnHeadOptions` gains `AdoptMR *AdoptMROptions` carrying the resolved
`MRRef`. `SpawnHead` then: resolve provider -> `GetMR` -> fetch the pseudo-ref ->
`CreateWorktree(root, path, "hydra/<id>", localPRRef)` -> write the review link and
the two new fields. The MR is resolved **before** the DB row is created so a bad PR
number fails the spawn cleanly rather than leaving a head pointed at nothing.

**API.** `GET /projects/{id}/reviews` for the picker; an `adopt_mr` field on
`SpawnAgentRequest` (`api/openapi.yaml:2676`). Remember `mage generate:go` +
the `openapi-typescript-codegen` regen from `web/`.

**Web.** A "From a pull request" mode in the spawn box (`web/src/components/SpawnForm.tsx`)
listing open PRs with author, target, draft state, and - importantly - a **"can't push"
badge** when `CanPush` is false. `ReviewControls.tsx` should label an adopted head as
adopted rather than showing "Create MR", and hide `DownstreamBranchEditor` (the branch
name is the PR's, not ours).

## Rejected alternatives

- **Check out the PR's real branch name instead of `hydra/<id>`.** Rejected: it
  collides with git's one-worktree-per-branch rule, breaks every `hydra/*` glob and
  `git.IsAgentBranch` / `AgentIDFromBranch` (which assume one public branch per head),
  and buys nothing - the push *refspec* already decouples the local branch name from
  the remote one, which is the entire reason `DownstreamBranch` exists.
- **Shell out to `gh pr checkout`.** Rejected: it mutates the main repo's checkout and
  writes `remote.origin.fetch` refspecs into the user's config. Hydra needs a worktree
  and must not touch the user's checkout. The two useful things it does (fetch the
  pseudo-ref, work out the push target) are ~30 lines here.
- **Add a git remote per fork.** Rejected: litters the user's `git remote` config -
  which `CreateMRDialog` surfaces to them as a dropdown - and needs teardown on head
  kill. The pseudo-ref removes the need for the fetch path, and pushing to a URL
  removes it for the push path.
- **A separate "PR" object / head kind.** Rejected: an adopted PR *is* a head with a
  pre-populated review link. A parallel type would duplicate the watcher, the MCP
  review file, the test gate and the diff viewer.

## Traps

- **`maintainerCanModify` is false by default** on most fork PRs unless the author
  ticked "Allow edits by maintainers". Spawning a head you cannot push from is the
  worst possible outcome, so surface it **in the picker, before spawn**, and let such
  a head spawn explicitly read-only rather than discovering it at push time.
- **Never force-push an adopted head.** The `--force-with-lease` path in `PushRefspec`
  is safe for a branch we own; on someone else's PR it must be opt-in and loud. Plain
  FF push only by default.
- **`publish_when_green` must default off** for adopted heads. `autoPublish`
  (`review_watcher.go:244`) currently auto-pushes any linked armed head - auto-pushing
  into someone else's PR is rude, and the arming UI should refuse it or warn.
- **`publishHead` must never run for an adopted head** - `EnsureMR` on a PR we did not
  create is at best a no-op and at worst opens a duplicate. Guard on `ReviewAdopted`.
- **Creation-time `[review]` settings must not leak onto an adopted MR**: `squash`,
  `draft`, `push_branch_template` and especially `delete_remote_branch` describe MRs we
  own. `RemoveSourceBranch` on someone else's fork branch is destructive.
- **`handleRemoteMerge`** (`review_watcher.go:139`) fast-forwards the local target
  branch then archives the head. Fetch-and-ff is still correct for an adopted PR (same
  repo, the code really did land), but the teardown should not offer to close the MR or
  delete its remote branch. Same for the linked-head kill/detach dialog (3.3c, still
  unbuilt).
- **A force-push by the PR author** while your head has local commits makes the next
  plain push non-ff. That failure is *correct*; surface it as "the PR moved" with
  Pull-from-MR as the remedy, and do not paper over it with a force.
- **Auth** stays CLI-only (`gh`/`glab`); `auth = "token"` is still a
  `NotConfiguredError` (`forge.go:164`). Pushing to a fork additionally needs your own
  git credential to reach that repo - the daemon runs git non-interactively, so this
  already surfaces cleanly as `*git.AuthError` rather than hanging.
- **In-sandbox `git push` stays gate-denied** (`internal/gate/decide.go`). Unchanged
  and correct: all pushes remain host-side in the daemon.

## Build order

Each step is independently useful and independently shippable.

1. **`internal/forge`: `MRRef`, `GetMR`, `ListMRs`** for both providers. No wiring, no
   API change; fully unit-testable against the fake `runner`. Verify the `gh --json`
   field names here (see §4).
2. **`internal/git`: `PRHeadRefspec` + `FetchRefspec`.** Small, no callers yet.
3. **DB + spawn, read-only adoption.** New columns, `SpawnHeadOptions.AdoptMR`, link
   written at spawn. **This is the first shippable milestone**: you can spawn a head on
   any PR, the diff viewer shows the whole PR, and the agent can already read its review
   comments over MCP. No push-back yet.
4. **Push-back, same-repo PRs.** `reviewTrackingRef`, `ReviewPushURL` threaded through
   `pushHeadToMR` / `pullFromMr`, plus the Traps guards. Fork support is then almost free
   because the URL push target was designed in from the start - it is mostly picker UX
   and the `CanPush` check.
5. **Web: PR picker + adopted-head labelling** in `SpawnForm.tsx` / `ReviewControls.tsx`.

Steps 1-4 are roughly a day; step 5 is a modest component. Worth folding in the
pre-existing **fetch-fresh spawn base** gap (NON_LOCAL_INTEGRATION.md 3.6) around step
3, since an adopted head's diff quality depends directly on the local target branch not
being stale.
