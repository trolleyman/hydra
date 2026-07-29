# Agent page: should it be GitHub/GitLab-shaped?

Status: **proposed, unbuilt.** The question is whether the agent page should adopt
a pull-request layout - an Activity tab first, diffs on another tab. The short
answer this doc argues for: **not between chat and diff (that import is wrong for
a live agent), but yes inside the inspector pane, where five unrelated things are
currently stacked in one scroll.** And "Activity" should be rows in the chat
transcript, not a tab.

Current layout facts are in [web-agent-page.md](web-agent-page.md); this is the
proposal that would change them.

## What the page is today

Two panes, no tabs anywhere, no URL sub-routes:

- **Working pane** (40%, `SPLIT_RATIO_DEFAULT` in `web/src/lib/layout.ts:77`) -
  chat transcript or raw terminal, mutually exclusive per head.
- **Inspector pane** (60%) - one scroll container holding, in fixed order:
  the sticky Changes bar, `TestsPanel`, `PreviewPanel`, `ArtifactsPanel`, the
  Files header, then the file list + diffs (`web/src/DiffViewer.tsx:4172-4192`).

Switching is by dragging the divider, collapsing a pane
(`PaneCollapse = 'none' | 'inspector' | 'working'`, `layout.ts:37`), or on narrow
screens sliding between the two panes in a `w-[200%]` track. All view state is
component state or localStorage; the route is a bare
`/project/$projectId/agent/$agentId` with no params.

## Why the chat-vs-diff tab split is the wrong import

GitHub's Conversation/Files tabs solve a problem Hydra does not have. On a PR the
conversation is **finished and in the past**, the diff is **static**, and you look
at one or the other. The tabs exist because there is no reason to see both at
once.

In Hydra the conversation is **live and it is the steering wheel**. You read what
the agent is saying *while* watching the diff it is producing - that simultaneity
is the whole point of the split, and it is why the default is 40/60 rather than
50/50 ("the diff needs the room, chat reads fine at 40%", `layout.ts:77`). Tabbing
them apart would force a choice between watching the work and reviewing it.

It is also worth noting that the thing GitHub's Files tab actually buys you -
the diff at full width - **already exists**: collapse the working pane
(`toggleWorking()`, or `Ctrl+,`) and the diff is 100% wide. You get the benefit
without the mutual exclusion.

**One exception.** The archived/merged head already renders through a different
path (a single `[data-main-scroll]` container rather than the split,
`AgentDetail.tsx`). For a finished head the conversation genuinely *is* history
and the diff genuinely *is* the artifact - GitHub's shape fits that case. If the
PR layout is wanted anywhere, that is where it belongs, and it is a much smaller
change than restructuring the live page.

## Where the tab bar does belong: inside the inspector pane

This is the real version of the instinct. The inspector is five things stacked in
one scroll - tests, previews, artifacts, the file tree, the diffs - and unlike
chat-vs-diff, **these are genuinely mutually exclusive**. Nobody reads a test tree
while scanning a diff hunk. They are stacked only because that was the cheapest
way to add each one.

What tabs there would fix:

- **Reaching the files costs a scroll past three collapsed cards.** Every time.
- **Everything is height-starved.** The artifacts masonry grid and the tests
  `CaseTree` both want the full pane; today they each get a slice of a shared
  column, and the file list is pinned to a hard-coded
  `max-h-[calc(100vh-140px)]`.
- **The sticky machinery exists only to make the stack survivable.** `DiffViewer`
  publishes `--sticky-changes-h` from a ResizeObserver so `--sticky-section-h`,
  `FILE_STICKY_TOP` and `CollapsibleCard`'s `STICKY_CARD_TOP` can dock section
  headers under it. That is a co-ordination problem created entirely by "five
  sticky things in one scroll". With tabs, one section is visible and the header
  is just a header. **This is a simplifying refactor, not only an additive one** -
  worth weighing against the size of `DiffViewer.tsx` (4233 lines).
- **It creates addressable sub-views for the first time.** There is no
  `?tab=tests` today because there is nothing to address. Once tabs exist, so
  does `?tab=...`, and that is the prerequisite for a comment permalink
  (`?thread=<id>`) - which is the hinge the review work turns on, see
  [review-agent.md](review-agent.md).

Costs and traps:

- `CollapsibleCard` fully unmounts its body ~200ms after collapse. Tab switching
  inherits that, which is mostly good (cheap) but the tests panel holds a live WS
  subscription and the artifacts panel holds filter/scrub state - both need to
  survive a tab switch or visibly reset.
- Per-agent prefs (`web/src/lib/agentViewPrefs.ts`) gain a "last tab" key, and it
  should be per-agent, not global like `PaneCollapse` is - which tab you want
  depends on what the head is doing.
- The narrow layout already uses horizontal sliding for pane switching. A tab bar
  adds a second navigation axis on the smallest screen; it probably wants the
  tabs as the primary control there and the pane slide demoted.
- A verdict that changes while you are on another tab must still be visible.
  Tabs need status affordances - a red dot on Tests, a count on Files - or tabbing
  hides exactly the thing the panel existed to surface.

## Activity: rows in the chat, not a tab

A separate Activity feed would be a **second timeline competing with the one that
is already the best record of what happened.** The chat transcript is already
chronological, and it already carries non-message system rows - `ChatItem` has
`commit`, `notice` and `meta` kinds alongside the message kinds
(`web/src/components/AgentChat.tsx`), and the commit chips are already clickable
to jump the diff viewer to that commit (`handleSelectCommit`).

But there is a real gap underneath the idea, and it is worth naming precisely:
**head-level events are ephemeral today.** A status transition renders through
`AgentTransitionRow`, which lives inside a *toast* (`web/src/lib/agentToast.tsx`)
and disappears. Tests going red, a publish, a merge, an artifact generation - if
you were not looking at the tab, that history is simply gone. Nothing persists it.

The fix is to emit those as chat rows, not to build a feed:

- New `ChatItem` kinds for head-level events (`tests`, `publish`, `merge`,
  `review`), rendered as compact system rows in the same visual family as the
  commit chips, each clickable to the tab that explains it.
- `AgentTransitionRow`'s rendering already exists - it needs a second home in the
  transcript, not a rewrite.
- This is the *good* half of GitLab's shape: system notes interleaved with the
  conversation in one stream, rather than a parallel log you have to remember to
  check.

It also composes with the review work: a review thread being opened, or an agent
replying in one, is exactly such an event, and it belongs in the same stream.

## Build order

1. **Head-level events as chat rows.** Independent of everything else, small,
   and it fixes a real loss of information today. Start with the transitions that
   already render in toasts, plus test verdict changes.
2. **Inspector tabs** - Changes / Tests / Artifacts / Previews / Files. Ship with
   per-agent last-tab persistence and status affordances on the tab labels; take
   the sticky-coordination simplification as part of the same change rather than
   leaving both mechanisms in place.
3. **URL sub-view state** (`?tab=`, later `?file=`, `?thread=`). Cheap once (2)
   exists, and it unlocks linking - to a file, to a failing test, to a comment.
4. **PR-shaped archived view**, if still wanted. Different render path already,
   and the case where GitHub's layout is actually correct.

## Deliberately not

- **Tabbing chat away from the diff on a live head.** They are read together;
  full-width diff already exists via pane collapse.
- **A separate Activity tab.** Duplicates the transcript, and splits the record
  of what happened across two places.
- **Folding the repository browser (`RepositoryView.tsx`) in as a tab.** It is a
  separate route with a single-ref model (`RepositoryArtifactsView` is its
  one-sided artifacts sibling); merging it is a different piece of work and
  should not ride along.
