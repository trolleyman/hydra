# Plan: user-checkoutable head branches (branch split + mirror)

Status: design plan, not implemented. Discussed 2026-07-07/08.

## Problem

`hydra/<id>` is checked out by the head's worktree
(`.hydra/local/worktrees/<id>`), so git refuses to check it out in the main
repo. The user wants to `git checkout hydra/<id>` in their main checkout and
have it follow along as the agent commits, so they can build/run/edit next to
the agent's work.

Workarounds available today, no code changes:

- `git checkout --detach hydra/<id>` works even while the worktree holds the
  branch (point-in-time snapshot; re-run to refresh).
- The head worktree itself is a live checkout the user can open host-side.
  Fine for reading/building/running; hazardous for editing (the user's edits
  land in the agent's `git status` and can be swept into its next commit).

## Design overview

Split each head's branch in two:

- `hydra/worktree/<id>` (naming still open, see below) - the internal branch
  the head's worktree has checked out. The agent owns it exclusively and is
  NEVER blocked by anything the user does. All agent commits land here.
- `hydra/<id>` - the public, user-facing branch. Becomes a best-effort mirror
  that follows the worktree branch. The user may check it out, dirty it, and
  commit on it.

The mirror is SYMMETRIC and strictly fast-forward-only in both directions.
Anything force-y or auto-conflict-merge-y is ruled out (see "Verified git
semantics" and "Rejected alternatives").

## Verified git semantics (tested empirically in a scratch repo)

- `git branch -f` REFUSES to move a branch checked out in any worktree
  (including the main checkout). So a naive mirror stops working the moment
  the user checks the branch out - exactly when the feature matters.
- `git update-ref` (plumbing) bypasses that safety check, but moves only the
  ref: the user's index/working tree stay at the old commit, so their checkout
  then shows the agent's new work as STAGED DELETIONS (a reflexive
  `git commit -a` would revert the agent's commits). Disqualifying footgun -
  never move a checked-out ref directly.
- The safe in-checkout operation is `git merge --ff-only <src>` run INSIDE the
  checkout: moves ref + index + working tree together, succeeds when the
  user's uncommitted changes do not overlap the incoming ones, aborts cleanly
  ("local changes would be overwritten") on overlap, aborts on divergence.

## Sync state machine

A daemon-side tick compares the mirror tip M (`hydra/<id>`) with the worktree
branch tip W (`hydra/worktree/<id>`):

1. **M == W**: nothing to do.
2. **M behind W** (agent committed - the common case): advance the mirror.
   - If `hydra/<id>` is not checked out anywhere: move the ref with
     `git update-ref refs/heads/hydra/<id> <newTip> <expectedOldTip>` - the
     old-value form is an atomic compare-and-swap, closing the TOCTOU race
     where the user commits between our ancestry check and the ref move
     (`branch -f` would silently discard that commit). Run our own
     "is it checked out" check first (`git worktree list --porcelain`), since
     update-ref skips git's safety.
   - If checked out (e.g. in the main repo): run `git merge --ff-only
     hydra/worktree/<id>` inside that checkout. Succeeds under non-overlapping
     dirty changes; on abort, just retry next tick (self-healing) and surface
     a badge if it stays stuck.
3. **M ahead of W** (user committed on `hydra/<id>`, agent has not since):
   NOT divergence. Fast-forward DOWN: `git merge --ff-only hydra/<id>` inside
   the head's worktree, gated on:
   - head status is settled (finished/waiting - the status.json poller already
     knows this; never change files under an agent mid-turn), and
   - the ff does not conflict with the agent's dirty files (the merge aborts
     on its own if so; wait for the next tick).
   This covers "agent is idle, user drops a quick fix on its branch" with zero
   conflict machinery, and the fix becomes part of the head's work.
4. **Diverged** (both committed within one tick window - should be rare):
   pause the sync and badge the head ("diverged: hydra/<id> has your
   commits"). Resolution ladder:
   1. Reconcile: `git merge hydra/<id>` in the head's worktree. Auto-run when
      the merge is clean and the head is settled (intent is unambiguous - the
      user committed on the agent's branch). W then contains both lines and
      the mirror fast-forwards again.
   2. On conflict: hand the agent a turn - "merge hydra/<id> into your branch
      and resolve the conflicts; these are the user's commits". Same shape as
      the existing "update from base" conflict flow, different ref.
   3. Manual fallback (user merges/rebases, or `git reset --keep` if the
      commits were throwaway).
   Never resolve divergence with force in either direction - that is the only
   path that destroys user commits.

## Knock-on rules

- **Merge-to-main** (`performClaimedMerge`) and **publish**
  (`publish.go` refspec): use whichever tip is the DESCENDANT of the other
  (normally W; M if the user committed after the agent finished - user commits
  must reach main too). If diverged: block with the reconcile action instead
  of picking a side. Refresh the mirror right before merging so a paused
  mirror can never cause a stale merge.
- **Kill/purge**: delete BOTH branches.
- **Diff/tests/artifacts/prefetch**: keep keying off one consistent canonical
  ref (the descendant rule, or simply W refreshed-first); must be a single
  deliberate choice across handlers.

## Implementation touchpoints

Step zero: introduce `heads.BranchName(id)` / `heads.WorktreeBranchName(id)`
helpers - the literal `"hydra/"+id` is inlined, not centralized.

Construction sites and prefix assumptions found by audit:

- `internal/heads/heads.go:433` (SpawnHead branch construction), `:415`
  (BranchExists guard), `:487` -> `git.CreateWorktree` (worktree.go:69,
  `git worktree add -b`) - spawn creates the worktree on the internal branch
  and additionally creates the mirror branch at the same commit.
- `internal/heads/id.go:156` HeadExists, `:27,61` error strings.
- Enumeration/classification that would now double-match `hydra/worktree/*`:
  `internal/git/worktree.go:38` ListHydraBranches glob,
  `internal/http/repository.go:275` `IsAgent` prefix check (internal branches
  must not leak into the UI branch list),
  `internal/git/merge.go:182` MergedHydraBranches,
  `internal/heads/heads.go:231` ResolveMergeDir prefix-trim,
  kill/purge guards `heads.go:1254,1408`, `internal/cli/merge.go`,
  `internal/db/queries.go:491`.
- Merge: `internal/http/handlers.go:1698` performClaimedMerge (+
  merge-when-green `internal/http/tests.go:463` RunAutoMergeWatcher,
  remote-merge `internal/http/review_watcher.go:136`).
- Publish: `internal/http/publish.go:210` pushes
  `*head.Branch + ":refs/heads/" + downstream` - push the canonical tip;
  remote naming unchanged.
- Diff refs: `internal/http/handlers.go:2272` GetAgentDiff (+ `:2045`,
  `:2200`), artifacts `internal/http/artifacts.go:76-139`, tests
  `internal/http/tests.go:128-151`, prefetch `internal/http/prefetch.go:165`.
- Seeded env: `internal/heads/seed.go:525` HYDRA_BRANCH should carry the
  worktree branch (what the agent actually commits to); consider also
  exporting the public name.
- Sync driver: a tick in an existing daemon loop
  (`internal/heads/poller.go` RunJSONStatusPoller settle callback and/or a
  RunAutoMergeWatcher-style loop in `internal/cli/runtime.go:242-245`), NOT
  the agent-side trigger_hook (mirror logic belongs host/daemon-side, outside
  the sandbox). `git.WorktreeStateHash` is the existing cheap change signal.
- New git plumbing needed in `internal/git`: update-ref CAS wrapper,
  `git worktree list --porcelain` parser (nothing in the codebase uses
  update-ref/branch -f/worktree list today).
- Comments asserting "the local branch always stays hydra/<id>"
  (`internal/db/queries.go:315`, `internal/db/model_unix.go:80`,
  `internal/config/review.go:108`) - revisit deliberately, not find-replace.

## Migration

Existing heads: on resume (or a one-time daemon boot pass),
`git -C <worktree> checkout -B hydra/worktree/<id>` - instant, same commit,
keeps the working tree - then let the mirror logic take over. `hydra/<id>`
already exists and becomes the mirror as-is.

## Naming (open decision)

`hydra/worktree/<id>` has no git ref-namespace conflict with `hydra/<id>`,
but every `hydra/*` glob in code and in users' own git aliases double-matches.
`hydra-wt/<id>` (or similar, outside the `hydra/` namespace) shrinks the
filtering blast radius and keeps `hydra/*` meaning "one public branch per
head". Mostly taste; decide before building.

## Rejected alternatives

- **Force-update the user's working dir** ("without regard for changes"):
  `git reset --hard` on a timer - silently destroys uncommitted work.
- **Auto conflict-merge into the checkout**: repeatedly strands the user
  mid-merge (MERGE_HEAD, markers) against a target that keeps moving; merge
  commits mean `hydra/<id>` stops being a mirror and the "what do I
  merge/diff" story degrades permanently.
- **Raw update-ref on a checked-out branch**: see verified semantics - the
  user's checkout appears to revert the agent's work.
- **Bidirectional sync protocol beyond ff + reconcile** (agent auto-rebases
  onto user commits, etc.): much bigger project, mid-flight-agent hazards; the
  symmetric-ff design gets most of the value.

## Phasing

1. **Cheap, ship first**: "open/copy worktree path" affordance in the UI.
   Covers look-at-it/build-it/run-it immediately, zero risk.
2. **The feature**: branch split + symmetric ff mirror + divergence
   reconcile, as above.
3. **Optional polish**: auto-ff inside the user's main-repo checkout (state 2b
   above) can ship after the basic mirror if it feels too magic at first; a
   `hydra sync <id>` / UI "refresh" button running the ff-only merge is the
   manual stepping stone.
