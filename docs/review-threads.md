# Review threads in the diff viewer

Status: **BUILT.** A head linked to a PR/MR shows the forge's review
conversations inline in Hydra's diff viewer, anchored to the file and line they
were written against, next to your own local comments. You can reply on the pull
request, keep a reply local to Hydra, hand a thread to the agent, or start a new
thread on a line. Code suggestions can be applied individually from their
comment or added to an explicit batch and applied together from the Changes
toolbar. The publish/forge machinery underneath is
[non-local-integration.md](non-local-integration.md); adopting someone's PR as a
head is [pr-adoption.md](pr-adoption.md).

## Two kinds of comment, one gutter

The diff viewer already had a comment system before this: **local review
comments** you write on a line and send to the *agent* (immediately with "Comment
to agent", or batched with "Add to agent review" and "Submit review"). Those never
touch the forge - they are how you brief the head.

Forge threads are the other kind, and both now render under the same line:

| | local review comment | forge thread |
|---|---|---|
| lives in | `localStorage` (`lib/reviewDrafts.ts`) | the PR, on GitHub/GitLab |
| audience | the agent | everyone on the PR |
| card | blue, editable, removable | violet, read-only, with replies |
| written by | you | reviewers, you, and the agent (locally) |

Telling them apart is the job of the **origin badge** at the top right of each
note: the provider's mark (GitHub/GitLab) for something that is really on the
pull request, and an amber `private` chip (a crossed-out eye) for a note that
only exists in this Hydra install. Both carry a tooltip spelling that out. The
badge is per NOTE, not per thread, because one thread routinely mixes the two -
a reviewer's comment, then the agent's local answer.

The provider mark is also the **link to that comment on the forge** (with the URL
in its tooltip, exactly like the sidebar's repository link), so the common "take
me to this on GitHub" move costs one click and needs no menu entry.

## What you can do with a thread

- **Reply on GitHub / Reply on GitLab** - posts as you, host-side via `gh`/`glab`.
  Every button naming the forge names it specifically; "the forge" only appears
  when the provider genuinely could not be resolved.
- **Note in Hydra** - stores the reply locally. Useful for a note to self, or for
  drafting. (It was "Keep private", which said what it wasn't rather than where
  it went.)
- **Resolve with agent** (the `...` menu) - sends the head a prompt quoting the
  thread and asking it to fix and commit, then to answer the thread. This is the
  agent-*pull* pattern used elsewhere: the agent re-reads the live thread itself,
  so nothing is snapshotted at click time.
- **Copy link to thread** (the `...` menu) - opening it is the icon's job.
- **Apply suggestion** - writes that comment's fenced replacement directly into
  the head's worktree. **Add to batch** selects a suggestion without applying it;
  once the batch is non-empty, the Changes toolbar offers **Apply batch** for
  exactly those selections. Hydra validates the entire batch before it changes a
  file.
- **Comment on GitHub / GitLab** (in the new-comment box on any new-side line) -
  starts a new review thread instead of writing to the agent.

That new-comment box now names its audience on every button: **Comment on
GitHub** (forge mark), **Comment to agent** (bot) for a single immediate
message, and **Add to agent review** (bot) - the primary, since batching several
comments into one review is the usual way to brief a head.

Both boxes are the shared `HighlightedTextarea` - the same live inline-markdown
highlighting as the chat and spawn composers. Review comments are markdown on
both forges, so what you type should read like what will be posted.

An in-progress reply is persisted per thread id (`loadThreadDraft` and friends,
the same shard-store machinery as the line drafts): a thread card unmounts when
it scrolls out of the diff, and losing a half-written reply to a reviewer is
worse than losing a note to the agent.

Resolving a thread is deliberately NOT here: resolution semantics differ between
the forges and belong to the review UI proper. Hydra shows the resolved state and
links out.

The Changes toolbar carries a compact comment pager. Its position counts every
top-level comment/thread in document order, including resolved ones, so resolving
a finding never makes it unreachable from Previous/Next. The adjacent open count
is status only; unread comments add a mark-read action. The control is UI chrome
and is not text-selectable.

## Why agents can only reply locally

An agent has no forge credentials by design (`~/.config/gh` is not in the
sandbox, and under hard egress there is no route to the forge at all), and every
Hydra write to a forge is an explicit user action. So the agent's
`mcp__hydra__reply_to_review_comment` tool writes a LOCAL-ONLY note: it appears
in the thread with the `private` badge, and you decide whether to repeat it to
the reviewer. The tool's description says so plainly, so the agent does not
promise the reviewer anything.

The note travels the same `internal/reviewq` file channel as the on-demand
review refresh (an op discriminator on the request), so no new sandbox surface
was needed. `get_review_comments` now includes each thread's id, which is what
the agent passes back to the tool.

## Data flow

```
diff viewer ──GET .../agents/{id}/review/threads──▶ daemon
                                                     ├─ forge.Threads()  (live, ~1s)
                                                     ├─ reviewstore.SaveThreads()   (cache)
                                                     └─ + reviewstore.LoadNotes()   (local)
```

- `forge.Thread`/`Note` come from one GraphQL query on GitHub (thread resolution
  is GraphQL-only there, and one round trip gets the comments too) and from the
  discussions API on GitLab, which is already thread-shaped.
- The GET reads **live** and caches. If the forge call fails - CLI not
  authenticated, network down, rate limit - the response falls back to the cache
  with `stale: true` and the reason, so the diff still shows the conversation
  instead of implying there is none.
- The Changes toolbar's Refresh action refreshes these live threads as well as
  the diff. It is the explicit way to pick up a forge reply without remounting
  the agent page.
- Local notes are merged per thread, sorted by time, after the forge notes.
  A note whose thread has vanished from the forge is dropped rather than shown
  floating.
- Writes (`POST .../review/threads`, `.../reply`) return the refreshed thread set,
  so a reply lands in the card without a second request.

In the UI the threads are grouped by path (`threadsByPath`), handed to each
`FileDiff` as `fileThreads`, and folded into the same per-line map as the local
comments - one discriminated entry type, so the memo'd hunk components keep a
single `comments` prop. The thread *actions* ride a React context
(`lib/reviewThreadContext.ts`) rather than props, for the same reason
`artifactDiffContext` exists: threading four callbacks through two memo'd
components would bust their memos on every parent render.

## Gotchas

- **Thread ids are provider-shaped.** GitHub replies address the ROOT review
  comment's REST id (not the GraphQL node id), so that is what `Thread.ID` holds;
  GitLab uses the discussion id. Do not assume they are interchangeable with a
  note id.
- **Anchoring is new-side only.** Forge threads anchor to a new-side line, so
  they key as `new:<line>`. A thread the forge reports with no line (a
  file-level or fully-outdated comment) is not rendered inline - it is still on
  the PR, and the card's link goes there.
- **An outdated thread keeps its original line.** GitHub nulls `line` once the
  diff moves under a thread but still reports `originalLine`; that is what gets
  used, and the card shows an `outdated` marker so the anchor is not trusted
  blindly.
- **New comments need a fresh anchor.** A new GitHub review comment must name
  the head commit; GitLab needs all three diff refs. Both are read at post time
  rather than cached, since a stale one is rejected by the forge.
- **Suggestions verify their source.** GitHub's `diffHunk` and GitLab's structured
  `from_content` carry the original lines. Hydra compares those lines with the
  head's current worktree before writing, rejects stale ranges, rejects overlaps
  in a batch, and never follows a suggestion path outside the worktree. Applied
  state is Hydra-local because the change is left uncommitted for the head to
  inspect and commit.
- **`local_only`, not `local`.** The origin enum value is spelled that way
  because an oapi-codegen enum value colliding with another enum's (the config
  scopes) silently re-prefixes BOTH enums' Go constants.

## Not built

- Resolving/unresolving a thread from Hydra.
- Threads on a line that is not part of the current comparison (they exist on the
  PR but Hydra has nowhere to put them).
- A local note on a line with no forge thread - local review comments already
  cover that, with a different audience.
- Reactions and review submission. Those remain the forge's review UI.
