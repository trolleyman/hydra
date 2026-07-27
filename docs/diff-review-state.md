# Plan: per-file "viewed" state for the diff review workflow

Status: **per-file viewed state BUILT (v1, client storage); the "reviewed up to"
marker and DB-backed storage remain unbuilt.** Build steps 1-2 below are done:
`git.HeadBlobSHAs` fills `git.DiffFile.HeadBlobSHA` -> `api.DiffFile.head_blob_sha`;
the client keys `agentViewPrefs.viewedFiles` (path -> last-viewed head blob sha)
off it, with a "Viewed" checkbox per file card and an `N/M viewed` count in the
Files header. Steps 3-4 (promote storage to `internal/db`; the `reviewed_up_to_sha`
marker + *Since last review* selector) are still open, as is the optional
auto-collapse of viewed files.

## Problem

Reviewing a head's diff is all-or-nothing today. There is no per-file "I've
looked at this" state and no notion of "what changed since I last looked", so
after the agent touches three files in a thirty-file diff you have no cue to
what's new - you re-scan everything. The commit dropdown (`DiffViewer.tsx`
`LeftSelector`/`RightSelector`) lets you diff between two commits, but that is a
manual range picker, not review progress.

Two things were explicitly considered and **rejected** as the primary fix:

- **GitLab-style numbered diff versions.** GitLab needs frozen snapshots because
  a force-push rewrites history and the old diff is otherwise lost. Hydra head
  history is append-only and every commit is already addressable, so the commit
  dropdown already *is* the version selector (and now lists first-parent commits
  only - see the merge-collapse change). Snapshotting would duplicate that.
- **A boolean "reviewed" checkbox per file.** A plain bool needs invalidation
  logic and races the agent committing while you read. Keying on content (below)
  removes both problems.

## Design: viewed keyed on blob sha

Store, per (agent, file path), the **blob sha you last marked viewed**:

```
(agent_id, path, blob_sha, reviewed_at)
```

A file renders as *viewed* iff its stored `blob_sha` equals the file's **current**
blob sha on the head side of the comparison. That single rule gives auto-unticking
for free:

- You tick a file -> we store its current blob sha.
- The agent changes that file -> its blob sha changes -> stored != current ->
  the file shows as unviewed again. No invalidation pass, no event wiring, no
  race with an in-flight commit.
- The agent reverts it back to the exact bytes you reviewed -> viewed again,
  correctly (same content = same review).

This is GitHub's "viewed" model and it is the right one. Blob sha (not a diff
hash) is the key so it is stable across context/whitespace toggles and unaffected
by the base ref moving.

### Where the blob sha comes from

`git.GetDiffFiles` / `GetDiff` already run per file; add the head-side blob sha to
`git.DiffFile` (a `git diff --raw` / `ls-tree` gives `<mode> <sha> <path>`, or
`%H`-style object id per path). Surface it on the `api.DiffFile` response so the
client can compare without a second round-trip. For an **uncommitted** working-tree
diff the "blob sha" is the hash of the working-tree file (`git hash-object`), so an
unsaved edit still flips the file to unviewed.

### Storage

Per-agent, low-volume, cleared when the head is purged - the same lifecycle as
per-agent view prefs. Two options:

- **Backend/DB** (`internal/db`, a small `diff_reviews` table keyed by agent id):
  survives across machines/browsers, and lets a future "reviewed up to" marker and
  any server-side "is this fully reviewed" checks read it. Preferred if review
  state should ever be more than a local convenience.
- **Client/localStorage** via `web/src/lib/agentViewPrefs.ts` (already a sharded,
  per-project+agent, 30-day-TTL store): zero backend surface, ships fastest, but
  is per-browser. Reasonable for a v1.

Recommendation: start in `agentViewPrefs` to validate the UX, promote to the DB if
it earns its keep.

### UI

- A checkbox in each diff file card header (`DiffViewer.tsx` file column + file
  diff headers). Ticking stores the current head blob sha; a file whose stored sha
  != current renders unticked with no extra work.
- A header count: "12 / 30 files viewed".
- Optional: collapse viewed files by default (the card body already unmounts when
  collapsed via `CollapsibleCard`), so a re-review naturally surfaces only what
  changed.

## Secondary (optional): "reviewed up to" marker

A single `reviewed_up_to_sha` per head plus a "Mark reviewed" button and a third
`LeftSelector` option, *Since last review*, that diffs `reviewed_up_to_sha...HEAD`.

Note **triple-dot** (merge-base) here, deliberately: a two-dot
`reviewed_up_to_sha..HEAD` would re-surface all of main's changes as "unreviewed"
the next time the agent merges main in - exactly the flood problem this area just
fixed, in a different guise.

This composes with per-file viewed rather than replacing it: the marker answers
"what's new since I looked", the per-file state tracks progress within one pass.
Per-file is the bigger win and should land first; add the marker only if per-file
viewing proves insufficient on its own.

## Suggested build order

1. Add head-side blob sha to `git.DiffFile` + `api.DiffFile` (backend, testable in
   isolation).
2. Per-file viewed state in `agentViewPrefs` + checkbox + viewed count (client only).
3. Promote storage to `internal/db` if cross-browser persistence is wanted.
4. `reviewed_up_to_sha` marker + *Since last review* selector (triple-dot).

## Touch points

- `internal/git/diff.go` - `DiffFile`, `GetDiff`/`GetDiffFiles` (add blob sha).
- `internal/http/handlers.go` - `GetAgentDiff` response mapping (`apiDiffFiles`).
- `api/openapi.yaml` - `DiffFile` schema (then `mage generate:go` + web codegen).
- `web/src/DiffViewer.tsx` - file cards, header count, checkbox.
- `web/src/lib/agentViewPrefs.ts` - viewed map (v1 storage).
- `internal/db` + `api` - only if promoting storage / adding the marker.

See [docs/web-agent-page.md](web-agent-page.md) for the diff viewer's layout and
per-agent view-state conventions this would extend.
