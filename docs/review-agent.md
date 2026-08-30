# Review agent + a real comment system

Status: **both halves are BUILT.** This is a design doc, not an options survey -
the survey it grew out of is kept as an appendix at the bottom, and the parts
still open are called out where they belong.

Two halves that only work together:

1. **A review slot** - **BUILT.** A "Review" entry in the tab dropdown (beside
   Sandboxed / Regular shell) opens a tab holding a reviewer agent with its own
   disposable checkout, no branch, and no ability to write to git.
   `internal/heads/reviewslot.go`, `?review=true` on the terminal WS,
   `TabKind = 'review'` in `AgentTerminal.tsx`.
2. **A server-side comment system** - **BUILT.** Comments are no longer ephemeral
   text piped into an agent's context: they are durable, numbered, line-anchored
   objects that agents read and append to through tools. A comment permalink uses
   the fragment `#comment-N`.
   `internal/reviewstore/comments.go`, `internal/http/review_comments.go`,
   `reviewq.OpComments` / `OpAddComment`, `web/src/lib/reviewComments.ts`.

Opening the Review tab for the first time starts a review turn immediately. The
reviewer reads the current base-to-head diff, records actionable findings with
`add_review_comment` at the relevant changed lines, and uses its response for the
summary. Reopening or reviving an existing reviewer restores its conversation
but leaves it idle; it does not automatically re-review or duplicate its findings.

The second was the more valuable half, and building it fixed the existing
"Comment to agent" flow as a side effect: that used to format a markdown blob and
inject it into the transcript, where it could not be re-read, re-anchored, or
survive a compaction, and the unsent batch lived in `localStorage`, so it died on
a reload and never left the browser it was typed in. What is still open is
listed at the end of Part 2.

> **Caveat on "BUILT": the reviewer has barely run.** The first time it was
> opened on a live head it showed the head's own chat - see
> [Its own conversation](#its-own-conversation-key-by-the-slot-not-by-the-head)
> for what was keyed by the head that should not have been. The simulation server
> does not spawn real sandboxes, so nothing below the socket is exercised by the
> Playwright pass; treat everything about the reviewer's *own* turns as
> lightly tested until it has been driven on a real head.

Related: [review-threads.md](review-threads.md) (the forge-thread half that
exists), [agent-page-tabs.md](agent-page-tabs.md) (the URL sub-view state a
comment permalink needs), [git-isolation.md](git-isolation.md) (the read-only git
mode the reviewer runs under), [testing.md](testing.md) (the runner machinery the
appendix draws on).

## Part 1: the review slot

### It is a session, not a head

The reviewer should be modelled on the **bash shell tabs**, not on a spawned
head. That is a much lighter thing than it first appears:

- `StartShellSession` (`internal/heads/heads.go:937`) starts a sandboxed session
  under an id derived from the head (`<head>@shell[-host]`, `ShellSessionID`),
  seeds it with its own policy, and registers it in `session.Registry`. It
  **never touches `internal/db`**.
- `ListHeads` builds its result from `store.ListAgents` and only overlays live
  status from the registry (`heads.go:105-150`). So a registry-only session is
  invisible to the head list **by construction** - there is no exclusion filter
  to write.
- Teardown is already a prefix sweep: `reg.KillMatching(SlotPrefix(head.ID))` on
  kill/merge, which catches every slot the head owns.

So a review slot needs **no DB row, no branch, no sidebar card, no merge path**.
It is a sibling of `<head>@shell`.

The one thing that genuinely differs from a shell is the argv and the seeding:
`StartShellSession` hardcodes `/bin/bash` and passes an empty `gate.Policy{}`
(`heads.go:1034,1054`). A review session wants
provider-specific `sandbox.AgentArgv(...)`, chat-mode framing, and a **real**
gate policy. Claude heads get a Claude reviewer and Codex heads get a Codex
reviewer. Providers without Hydra structured-chat support retain the original
Claude reviewer fallback.

### The slot id: `<head>@review`, not `<head>/<N>`

Two reasons not to key the slot by an ordinal under a slash.

**A `/` breaks things, because these ids become filenames.** `seedGatePolicy`
writes `cacheDir/<id>-gate-policy.json` (`internal/heads/seed.go:467`) and
provisions `paths.GetApprovalsDirFromProjectRoot(projectRoot, id)`. An id of
`agent-1/2` names a directory that does not exist. The established convention is
`<head>@<slot>` for exactly this reason - `ShellSessionID` produces
`<head>@shell[-host][-<token>]`, via `SlotSessionID`.

**And a bare ordinal hides the only thing that makes a second reviewer
worthwhile.** `agent-1@review-2` says nothing; `agent-1@review-security` says
everything. Ordinals are also unstable - kill the second slot, make another, and
whether it is `2` or `3` depends on bookkeeping nobody wants to maintain. A lens
name is self-describing and idempotent.

So: **`<head>@review`** (`SlotSessionID(headID, "review")`) for the default, with
no suffix at all, leaving `<head>@review-<lens>` free for later. A single-slot v1
then needs no naming scheme, and adding lenses later is not a migration.

### The session-id namespace (BUILT - was broken, `-review` would have inherited it)

**Status: fixed.** `heads.SlotSep` / `SlotSessionID` / `SlotPrefix`
(`internal/heads/heads.go`) now build slot ids as `<head>@<slot>`, and
`sandbox.ScopeUnit` disambiguates unit names with a hash. Kept here in full
because the reasoning is what the review slot's id scheme rests on.

Session ids used to be built by **string concatenation onto a head id** with a
hyphen, and head ids can contain hyphens. That collided, and it was not
theoretical.

`ValidateHeadID` accepts `^[a-zA-Z0-9][a-zA-Z0-9._-]*$` for an explicit id
(`internal/heads/id.go:29`), and `slugifyHeadID` produces `[a-z0-9-]` from a
prompt's first eight words (`id.go:82-94`). So two ordinarily-named heads are
enough: a head from "Fix the" (`fix-the`) and a head from "Fix the shell script"
(`fix-the-shell-script`).

Three things break, in increasing order of severity:

1. **Spawn/resume failure.** `Registry.Start` returns `ErrExists`
   (`internal/session/registry.go:20`) - a head named `foo-shell` cannot start
   while head `foo` has a live shell tab holding that id.
2. **Cross-head kill.** Teardown was `reg.KillMatching(head.ID + "-shell")`, and
   `KillMatching` is a **prefix** sweep
   (`strings.HasPrefix`, `internal/session/registry.go:638`). Killing or merging head
   `fix-the` sweeps the prefix `fix-the-shell`, which matches
   `fix-the-shell-script` - **the main agent session of an unrelated head**. The
   prefix match is what makes this likely: no exact name collision is needed.
3. **Gate policy clobber, and this one is security-relevant.**
   `StartShellSession` calls `seedHead` with the shell's id and an *empty*
   `gate.Policy{}` (`heads.go:1034`), which writes
   `cacheDir/foo-shell-gate-policy.json`. That is the same path head `foo-shell`'s
   real policy occupies. The gate hook reloads the policy **fresh on every tool
   call** (`internal/cli/gate.go:73-91`), so a live head's gate can silently go
   from enforcing to disabled because someone opened a shell tab on a
   similarly-named head. The approvals directory collides the same way.

**The fix: a separator that cannot appear in a head id.** Not a reserved-suffix
blacklist (`*-shell`, `*-review`, ...) - that grows with every new slot kind,
does nothing for heads that already exist, and leaves the prefix sweep ambiguous.
Instead pick a character outside `[a-zA-Z0-9._-]` and filename-safe on all three
platforms: **`@`** reads well and qualifies (`.` and `_` do **not** - explicit
head ids may contain both).

```
foo@shell   foo@shell-host   foo@review   foo@review-security
```

Collisions are now impossible by construction, and the prefix sweep is sound as a
side effect: `KillMatching(SlotPrefix("foo"))` can only ever match head `foo`'s
own slots. `TestSlotSepIsNotAValidHeadID` asserts the separator stays outside
`ValidateHeadID`'s character class, so a later loosening of head-id validation
fails a test rather than silently reopening this.

**Why `@` specifically survives every surface a session id reaches.** The
constraint is narrow - the character must be rejected by `ValidateHeadID` *and*
harmless everywhere an id is used - so it is worth recording what each candidate
does, because most of the obvious ones fail:

| surface | requirement | `@` |
| --- | --- | --- |
| Windows filenames (`<id>-gate-policy.json`, the approvals dir) | not one of `< > : " / \ \| ? *`, not a control char, no trailing dot/space | legal on NTFS/FAT32/exFAT; device names (`CON`, `NUL`, `COM1`) are unaffected by it |
| POSIX filenames | not `/`, not NUL | legal |
| URLs | - | never reaches one: the client sends only a *tab token* as `shell_id` and the backend derives the session id (`internal/http/terminal.go:290`). Legal in a path segment and a query string regardless (RFC 3986 `pchar`) |
| shell | no expansion if interpolated | not special in sh/bash/zsh |
| git refnames | only if a slot ever became a branch (none do) | legal - the refname rules only forbid a bare `@` and the sequence `@{`, neither of which a slot id can spell |
| systemd unit names | see below | **is** special (`foo@bar.service` is template syntax) - which is why `sanitizeUnit` maps it to `_`, and why the hash below matters |

The near misses are instructive: **`:`** is illegal on Windows (drive
separator); **`%`** is systemd specifier expansion *and* URL percent-encoding;
**`#`** is a URL fragment; **`!`** is history expansion in interactive
bash/zsh; **`~`** is tilde expansion and is illegal in a git refname; **`+`**
decodes as a space in form-encoded query strings. And `.`, `_`, `-` are all
accepted by `ValidateHeadID`, so they fail the first requirement outright.

**And one layer down: the systemd unit name.** `sandbox.sanitizeUnit` maps every
character systemd disallows to `_`, so `foo@shell` and a head explicitly named
`foo_shell` both sanitized to `foo_shell` - the same collision, one layer lower,
and not fixed by the separator alone. It bites harder than it looks: `WrapScope`
calls `StopScope(unit)` first to clear a stale unit from a prior life, so one
workload starting would tear down the other's **live** cgroup. `ScopeUnit` now
appends `ScopeHash(id)` of the *unsanitized* id, which keeps the readable name
and makes the mapping injective. (Several callers - tests, artifacts, services -
already appended a hash by hand for exactly this reason; this moves it into the
one place that cannot be forgotten.)

**The migration was close to free**, which is why it was worth doing before a
third slot kind existed: slot ids live only in `session.Registry` (in-memory -
shell sessions have no DB row) and their on-disk traces are regenerated cache
files, so a daemon restart is the migration. Note the frontend needed no change
at all: it passes a `shell_id` *tab token* as a query param and the backend
derives the session id, so no client ever spelled one.

Still worth doing as belt and braces: record the **owning head id** on the
session and sweep by field equality instead of by string prefix. The registry
already carries a per-session worktree label, so there is a natural home for it,
and it retires the whole prefix-matching bug class rather than one instance.

### Correction: its own tree, not the head's

The proposal says "read-write tree". Agreed on read-write - a read-only tree
breaks builds, caches, and test runs for no benefit. But it must be the
reviewer's **own** checkout, not the head's, for two independent reasons:

1. **Transcript collision.** Provider conversation state is keyed by *worktree
   path*. For Claude, `claudeProjectDir` (`internal/http/chat_ws.go:918`) and
   `claudestream.LatestSessionID` make this explicit. A reviewer sharing the
   head's worktree could write into the same state the head resumes from.
2. **Worse: it races the head's edits.** A read-write reviewer in the head's tree
   runs a build, writes a lockfile, clobbers a scratch file - while the head is
   mid-edit. Corrupting the work under review is a much bigger failure than
   anything the reviewer might catch.

Giving it its own checkout solves both, and costs nothing: `WorktreePath` is a
plain field on `sandbox.Options` and nothing in the registry or `BuildSpec` ties
a session to the head's worktree. The base sandbox already read-only-binds the
whole host filesystem at `/` (`internal/sandbox/linux.go:172`), so the head's
worktree stays *visible* to the reviewer - just not writable.

**And because it can never commit, it does not need a branch** - a detached
checkout is enough.

**But not a pooled one.** The obvious move is to reuse `slotPool`
(`internal/artifacts/slots.go`), which already hands out bounded, recycled,
detached checkouts to tests and artifacts. That is wrong here, for a reason worth
stating because it is the same reason the reviewer gets its own tree at all: a
pool slot is *recycled* - acquired, released, re-checked-out for someone else's
run - and the reviewer's **conversation is keyed by its checkout path**. A moving
path means a new transcript, so the reviewer forgets everything on every
re-acquire. Holding a slot forever instead just starves a 4-slot pool.

So the reviewer wants a **dedicated, persistent directory** -
`.hydra/local/review-checkouts/<head-id>/` - created once and checked out forward in place.
The pool is for ephemeral runs; a conversational reviewer is not one. See
[Surviving a restart](#surviving-a-restart), which turns out to be the same
requirement.

> **On the pool itself:** there is no separate `tests.slotPool` - `internal/tests`
> imports `internal/artifacts` and calls `artifacts.NewSlotPool`
> (`internal/tests/manager.go:112`), with its own dir and its own cap. The *code*
> is already shared; only the pool *instances* are separate (so up to 4 checkouts
> each). The giveaway that it lives in the wrong package is
> `internal/artifacts/exports.go`, a shim whose entire purpose
> (`type SlotPool = slotPool`) is to let `internal/tests` reach an unexported
> type. Extracting it to its own package - `internal/checkout` or
> `internal/worktreepool` - deletes that shim and stops a reviewer having to
> import `artifacts` for something that has nothing to do with artifacts. Worth
> doing before a third consumer arrives, not after.

### Its own conversation: key by the SLOT, not by the head

Its own checkout buys nothing if the *plumbing* still says `head.ID`, and for a
while it did: the Review tab opened onto the head's own chat, complete with the
head's plan chip. Two independent places, one root cause - `<head>@review` has no
`db.Agent` row, so anything that resolves an id through the store falls through
to "unknown" or, worse, silently keeps using the head's.

- **The socket pumped the wrong log.** `pumpChatOutput` was passed `agentID`, so
  the durable event log it watched, the history window it paged, the queued
  messages it replayed and the pending questions it announced were all the
  head's. `internal/http/terminal.go` passes `sessionID` now; they are the same
  value for a head's own tab.
- **The reviewer's own output was being dropped on the floor.**
  `Registry.SetOnChatLine` fires with the *session* id, and the chat manager's
  context resolver looked the id up in the DB and gave up when it missed - so
  every line the reviewer printed was logged as `resolve ...: unknown head` and
  discarded. `chatContextResolver` (`internal/cli/runtime.go`) now falls back
  through `heads.SplitSlotID` to the owning head for the project root, but onto
  the reviewer's **own** checkout, and with **no** prompt or plan seed: those are
  the head's task and to-do list, and seeding them would open the reviewer's
  transcript with someone else's job.

`heads.SplitSlotID` is the shared reverse of `SlotSessionID` and the general
answer to "this id has no row"; `ChatQueueManager.resolveRoot` uses it too, or a
review turn would end with nothing to write its status against and a queued
message that never drains.

The same split exists in the browser. `ChatPane` keys its composer draft, its
attachments, its composer height, its scroll offset and its local plan mirror by
a `stateId` that carries the `@review` suffix, so the two panes on one agent page
do not type into each other's draft. What deliberately stays on the head id:
approvals (the reviewer's egress prompts are routed to the head's card on
purpose), unread state, and the branch/worktree a markdown image resolves
against.

### No git, enforced twice

`git_isolation = readonly` binds the entire git common dir read-only, so raw
`git commit` / `add` / `reset` fail at the **OS level** - the gate deliberately
lets them through to hit that wall rather than denying them
(`internal/gate/decide.go:365-377`, [git-isolation.md](git-isolation.md)). Layer
the MCP tool block on top (`policy.mcp_tools_blocked`, enforced first in
`gate.Decide`, `internal/gate/decide.go:220-249`) and the host-mediated commit
path is gone too. No writes, no escape hatch.

Policy is already per-session, not per-head: `seedHead` takes `gate.Policy` as a
parameter and writes a `<id>-gate-policy.json` bound into that sandbox
(`internal/heads/seed.go:457-472`), which is exactly how shells get an empty
policy while the head gets a real one.

> **Gotcha worth knowing up front:** `resolveGitIsolation`
> (`internal/heads/heads.go:828-833`) *falls back to `off`* when the agent type
> does not support the git tools, so that a head is never left unable to commit.
> A reviewer that drops the git tools would silently lose its read-only isolation
> to that fallback. The fallback needs to become conditional, or the reviewer
> needs to keep the tools present-but-blocked.

### Slot keying: one per head, commit as context

This was the open design question. **One long-lived slot per head**, with the
commit under review as *context* rather than as the key.

Per-commit keying is tempting because it matches how the test cache works, but it
breaks the thing that makes review valuable: **review is a conversation across
rounds.** "I raised #3 two commits ago - is it addressed?" is the highest-value
review interaction there is, and a per-commit key throws away the context needed
to answer it. It also proliferates checkouts and transcripts (a 40-commit head
gets 40 reviewers), and makes the dropdown entry ambiguous - which review?

The per-commit precision belongs one level down, in the **comment anchors**
(`commit, path, line`), which you need anyway for staleness detection.

Practically: when the head commits, sync the reviewer's checkout forward
(`git checkout --force <new tip>` - what the slot pool already does) between
turns, and say nothing to the reviewer (see the next section - telling it was
built, and cost too much). Never mid-turn. The reset button is closing the tab,
which now really does end the session, exactly like closing a shell tab.

Name it so extra slots are possible later without a migration -
`<head>-review`, leaving room for `<head>-review-security` - mirroring how
`ShellSessionID` already carries variants.

### What wakes the reviewer

Two candidate triggers, and they should be answered differently. The distinction
that matters: **syncing the reviewer's checkout is free; waking it is a model
turn.** Never conflate them.

- **A reply on a thread it participated in - yes, wake it.** This is what makes
  the reviewer a participant rather than a one-shot report. Without it you answer
  its finding and it never learns whether it was right. It rides the same
  notify-by-id path, and it is human-initiated, so the rate is naturally bounded.
- **New commits on the branch - no, do not wake it.** An agent that commits
  fifteen times in a task would trigger fifteen review passes: fifteen model
  turns, a flood of near-duplicate comments, and a feature switched off inside a
  day. Instead: sync the checkout forward **silently** between turns, mark the
  existing review stale (the tip moved past what the comments were written
  against - `hunk_hash` already detects this per comment), and let the next pass
  be triggered deliberately.

  **This was then built the other way round, and reverted.** `reviewsync.go`
  shipped sending the reviewer a catch-up message on every sync - batched per
  tick, capped at 20 subjects, and closing with "you do not need to re-review the
  whole branch". The batching and the wording were both beside the point: a live
  reviewer got a model turn per commit batch anyway, which is the flood this
  section predicted, and a transcript of six identical `[Hydra] The head has
  committed` bubbles is what it looks like from the other end. The sync is silent
  again. What replaced the message is one line in `reviewSystemPrompt` - your
  checkout moves under you between turns, so re-read before relying on what you
  read earlier - which costs nothing per commit and is true whether or not
  anyone is watching. If an automatic pass is ever wanted, hang it on `finished`,
  as below.

If an automatic pass is wanted, hang it on the **`finished` transition**, not on
commits - the hook machinery already distinguishes main-agent completion from
live sub-agents, and merge-when-green already gates on finished-for-10s, so there
is a precise, once-per-task moment to fire on.

### Surviving a restart

Yes, and most of it falls out of decisions already made:

- **Comments** are server-side by construction. Free.
- **The reviewer's conversation** - BUILT, and it fell out for free:
  `StartReviewSession` is idempotent, so the `?review=true` attach doubles as
  both the lazy-create path and the revive-after-restart one. Opening the Review
  tab brings it back rather than starting fresh.

The neat part is that the own-tree decision makes resume *safe* here. Bare
`--continue` is unreliable in a head's worktree only because something else may
write that transcript dir; the reviewer's checkout is used by exactly one
session, so the mtime heuristic is unambiguous and no session-id bookkeeping is
needed. A slot has no DB row - that was the point - and this is why it does not
need one.

**That only holds if the checkout path is stable**, which is the argument against
a pooled slot above. Same requirement, arrived at from the other direction.

### Where it lives in the UI: a tab, from the `+` dropdown

**BUILT**, and worth recording that the first attempt put it in the wrong place.

Review is a **tab**, opened from the `+` split-button menu in
`AgentTerminal.tsx` alongside Sandboxed shell / Regular shell (host). That menu
is the "open another session attached to this head" control: each entry spawns a
slot (`<head>@shell`, `<head>@shell-host`), and Review is the same kind of thing
(`<head>@review`, a sibling). Putting it there makes the UI mirror the model the
backend already has.

The first attempt instead added a row to `ChatViewSelector`, the chat view
dropdown. That was wrong for a reason this doc had already argued - the selector
switches *views over one transcript*, and a session is a different category, so
"two switchers for what is in this pane" is exactly what it warned against - but
it also had a plain defect that the reasoning missed:

> `ChatViewSelector` renders inside `ChatPane`, and `AgentTerminal` only renders
> `ChatPane` when `chatMode` is true. So a **terminal-mode head could not reach
> its reviewer at all** - even though the review slot is its own chat session
> regardless of how the head it is attached to runs. The tab dropdown
> sits outside that branch and works for both.

What the tab shape settles:

- **Identity.** A permanent label next to Chat, rather than a dropdown chip you
  have to notice. This was the risk flagged as most likely to bite - switching to
  Review, forgetting you are not talking to your head, and telling it to "just
  fix that", which fails silently because it has no git and a throwaway tree.
- **Both at once.** Tabs are peers, so reading a finding and then telling the
  head about it is a tab click, not a modal switch through a dropdown.
- **Room for status.** A tab is always visible, so a dot on it beats any
  affordance on a collapsed dropdown. (Not built yet - see the open list.)
- **Less code.** The tab strip already does multiple-mounts-one-visible, which
  the first attempt hand-rolled with two wrapper divs and a `chatPane` state.

Decisions inside that shape:

- **A divider above it in the menu.** The other two entries are shells; the
  reviewer is a second agent. Same reasoning as the divider the first attempt put
  between Review and the sub-agents.
- **Idempotent open.** Clicking Review when the tab exists focuses it rather than
  adding a second - the backend keys exactly one review session per head. The
  shells add a tab each time and carry a per-tab token; Review has a fixed id.
- **Lazy.** The tab (and therefore the checkout and the model session) is created
  on first open. A head nobody reviews never pays for one.
- **Persisted** (`agentViewPrefs.reviewTabOpen`), unlike the pane choice it
  replaced. "I have a reviewer open" is real state: the backend session is
  long-lived, one slot per head, and reattaching is free. A bool rather than a
  list like `bashTabs`, since there is only ever one. Note `loadAgentViewPrefs`
  is an explicit field-by-field projection, so a field the writer sets but the
  loader does not name is written and never read - which is exactly what the
  first version of this did, making the tab vanish on every agent switch.
- **Closable from the tab, and closing it ends the session.** This went back and
  forth. It first shipped with a close X, which was removed on the grounds that
  an X reads as disposable when the thing behind it is one durable slot per head,
  and that the X was the wrong verb anyway - there was no `/close` for a
  reviewer, so it only detached the pane. The second half of that was the real
  defect, and the fix was to make the verb true rather than to take the button
  away: with only a hide, a reviewer you were finished with kept its sandbox, its
  supervisor and its model session for a pane nobody was looking at, and there
  was no way to stop it short of killing the head.

  So there is a `/close` now (`POST .../review/close` ->
  `heads.KillReviewSession`), and both affordances - the tab's X and un-ticking
  the `+` menu entry - go through it. It ends the process **and removes the
  checkout**; the CONVERSATION survives. That is the split worth keeping:
  killing a process and reclaiming a working tree are reversible, deleting a
  conversation is not, and the transcript goes on purge
  (`RemoveReviewSessionDir`), with the head's.

  Dropping the tree is only safe because neither provider keeps its history
  inside it - Claude's transcript is `~/.claude/projects/<slug of the checkout
  PATH>`, Codex's thread id is a file in `.hydra/local/cache` - and the path is
  derived from `(projectRoot, headID)`. So `EnsureReviewCheckout` rebuilds the
  same path on the next open and `--continue` picks the review back up. This is
  the same stable-path requirement that ruled out a pooled checkout, arrived at
  from a third direction: a close that moved the path would silently be a reset.
  It also drops the head out of the sync loop, which skips any head with no
  checkout.

  The reviewer is also the one slot that needs a kill of its own rather than the
  `KillMatching(SlotPrefix)` sweep: it runs in a different tree, so it has its
  own namespace-host supervisor and its own egress proxy, both keyed by the slot
  id. The sweep killed the agent and left those two behind - `KillHeadNoLock`
  calls `KillReviewSession` now for the same reason.

Still open: a **status dot on the tab** (mid-turn, or stale because the tip
moved), and telling the user in the *composer* what this agent cannot do.

### How many reviewers

Default **one**, but the naming should allow more from the start
(`<head>-review`, leaving room for `<head>-review-security`) so adding them later
is not a migration.

On duplication vs a second pair of eyes: the duplication worry is real, but it is
specific to *identical* reviewers. N general-purpose reviewers on one diff produce
heavily overlapping findings, and the overlap is not free - you read all of it,
and every duplicate erodes trust in the channel until you stop reading any of it.
What does not duplicate is diversity of **lens**: security, performance, "does
this actually do what the task asked". Those look at different things and produce
disjoint findings. So multiple reviewers should be distinguished by lens, not by
count.

**And this is where the comment store earns its keep.** A second reviewer can
call `get_review_comments` and be briefed to *not restate what is already there -
reply to an existing thread if it agrees or disagrees*. That converts a second
reviewer from a duplicate into a second opinion **on existing threads**, which is
worth more than either review alone and is exactly what N blind parallel
reviewers cannot do. Sequenced-and-aware beats parallel-and-blind. It is also the
strongest argument for building the store before building any reviewer.

## Part 2: the comment system

### One store, two states

Comments live on the server, append-only, in one store with a `status` field:

- **`draft`** - visible to you, synced across reloads and devices, **invisible to
  every agent tool**. This fixes a real bug today: drafts are `localStorage` only
  (`web/src/lib/reviewDrafts.ts`), so they die on a reload and never leave the
  browser they were typed in.
- **`published`** - visible to agents, immutable.

Making visibility a field rather than a separate store means "publish" is a state
transition, not a copy between systems, and there is exactly one thing to query.

**Read + append only, as proposed.** Editing a published comment is the one
mutation to leave out: append-only is already the shape of `reviewstore`
(`AppendNote`, `internal/reviewstore/reviewstore.go:81`), it is crash-safe, it
needs no conflict resolution between concurrent writers, and it makes a thread an
audit log rather than something an agent could quietly rewrite. Drafts are freely
editable - that is what a draft is - and the ban applies from publish onward.

`reviewstore.LocalNote{ID, ThreadID, Author, Body, CreatedAt}` is most of the
model already, and it already understands a non-human author (`AuthorAgent =
"agent"`). What it needs is an **anchor** (`commit, path, line-range, hunk_hash`)
and the ability to exist **without a forge parent** - `mergeLocalNotes`
(`internal/http/review_threads.go`) currently drops any note whose thread is not
in the forge's list.

### Notify by id, not by text

This is the sharpest part of the proposal and it fixes a concrete waste. Today
`buildReviewMessage` (`web/src/DiffViewer.tsx:1771-1797`) formats each comment
together with a fenced block of its diff context and injects the whole thing into
the agent's transcript via `SendAgentInput`. Instead:

```
Comments added: #4 (web/src/DiffViewer.tsx:1204), #5 (internal/tests/manager.go:88)
```

...and the agent pulls the bodies with a tool. Why this is strictly better:

- **Constant-size.** Six comments cost one short line, not six diff excerpts.
- **No duplication.** The agent already has the diff; shipping context blocks
  re-sends it.
- **The comment stays canonical.** The transcript holds a pointer, so it cannot
  drift from the comment, and a later reply appears when the agent re-reads.
- **It survives compaction.** An injected blob that scrolls out of context is
  gone forever. An id is a stable handle the agent can re-resolve at any point -
  which is what makes "you raised #3, is it fixed?" work two rounds later.

Include the `path:line` in the notification even though it is redundant with the
fetch: it is nearly free and it lets the agent decide whether a comment is worth
fetching at all. Batch it - "Submit review" with six comments is one
notification, not six.

The notification itself rides the existing path: `SendAgentInput`
(`internal/http/handlers.go`) queues a chat turn for a chat head, or
bracketed-pastes into the PTY otherwise.

**This is symmetric, and that is the point.** When the *review agent* appends a
comment, the head gets the same notification. The two agents are peers
communicating through a shared, durable, user-visible medium rather than piping
text into each other's context - which means you see everything, can intervene on
any thread, and a human reviewer is an interchangeable participant.

### Comment ids

The consumer here is unusual: these ids are read *and typed back* by a language
model, and read aloud by a human ("fix #3"). That argues against a raw UUID -
36 characters, several tokens, and easy for a model to corrupt by a character.

**Recommendation: per-head sequential numbers, rendered `#4`.** They are one
token, unambiguous, human-speakable, and stable (append-only, never renumbered).
Assignment is safe because every write already goes through the daemon - the web
client does not write the store directly, and `reviewq`
(`internal/reviewq/reviewq.go`) is already the daemon-mediated channel agent
writes arrive on. The permalink is
`/project/<p>/agent/<h>#comment-4`, and the head is already in the path.

The tradeoff to accept knowingly: sequential ids are only meaningful **within a
head**. If comments ever need to move between heads or be aggregated
project-wide, you would want a prefixed opaque id (`cmt_<base32>`) underneath.
If that feels likely, do it now: prefix + Crockford base32 (no I/L/O/U, so no
lookalike corruption), ~10 chars. What to avoid either way is a bare UUID - the
prefix is what stops a model confusing a comment id with a commit sha.

### Numbering forge comments too - without becoming their source of truth

The numbers should cover **every** comment on the head, forge ones included -
"fix #3" has to work regardless of who wrote it or where it lives, and a UI with
two numbering schemes in one gutter is worse than none.

But that does **not** mean Hydra should become the source of truth for forge
comments, and it is worth being precise about why, because the natural next
thought ("sync it all into the DB, nothing goes around Hydra") does not survive
contact with the forge. People comment on GitHub directly. They edit and delete
there too. Hydra cannot prevent that and should not try - it does not own that
web UI. A local copy declaring itself authoritative would be a replica pretending
to be a source, and would need reconciliation for every edit, delete and resolve
that happened while nobody was looking.

Today's behaviour is already the right one: forge threads are fetched **live** per
request via `provider.Threads(...)` (~1s) and the server-side copy exists only as
a fallback when that call fails (`internal/http/review_threads.go`).

**So split ownership: Hydra owns the numbering, the forge owns its content.**
BUILT, exactly as described - `internal/reviewstore/sidecar.go`.

- An append-only local map, `(origin, external_id) -> #N`, assigned on **first
  sight** of a comment from any origin. Numbering is idempotent, because the diff
  viewer re-numbers every note on every render: a repeat lookup must not burn a
  number, or the sequence would run away while you scrolled.
- One sequence per head across all origins, so the numbers interleave in the order
  Hydra first saw them.
- Numbers are never reused. A comment deleted on the forge retires its number
  rather than freeing it - otherwise "#3" means something different depending on
  when you read it, which is exactly the failure the ids exist to prevent.
- Content for forge comments keeps flowing live; content for native comments
  lives in Hydra. Nothing needs reconciling, because nothing is duplicated.

**Not everything routes through `reviewq`** - that is the *agent to daemon*
channel specifically, and it exists because an agent has no network and no forge
credentials. Three write paths converge instead: the web client over HTTP, agents
over `reviewq`, and the forge poller daemon-side. What matters for numbering is
not that they share a channel but that they share a **single writer** - and they
already do, because all three land in the daemon. Assign numbers there.

Note the ordering consequence: a forge comment written while the daemon was down
gets its number on the next fetch, so numbers reflect *when Hydra first saw* a
comment, not when it was written. That is fine - they are handles, not a
chronology - but it should be a deliberate choice rather than a surprise.

### The tools

Four, mirroring what already exists rather than inventing a surface:

| tool | shape | notes |
| --- | --- | --- |
| `get_review_comments` | no args = every published comment; `numbers` = those, with their frozen diff context | **BUILT.** ONE tool over both sources - Hydra's own comments first, the forge's unresolved discussions after. They are the same job to an agent ("what has someone said about my code, and where"), so splitting them by where they happen to be stored would only make the model pick, and pick wrong |
| `add_review_comment` | `path`, `line`, `reply_to`, `body` | **BUILT** - `reviewq.OpAddComment`. Published on write: an agent has no drafts, because a draft exists so a person can think before speaking |
| `reply_to_review_comment` | `number`, `body` | **BUILT** - takes a NUMBER, so one tool answers either origin: a Hydra comment gets a threaded reply inheriting its anchor, a forge note gets a local note on its thread. Never posted to the forge, and scoped to the calling head by construction - the request arrives on that head's own reviewq dir and the number resolves against that head's own store. A draft is not repliable: an agent must not answer something the user has not said yet |
| `resolve_review_thread` | `number` | still open for AGENTS (a user resolves in the UI). The state exists; nothing exposes it as a tool, and an agent resolving its own review comments is a conflict of interest worth thinking about first |

Scope every tool to the calling head's own comments. `reviewq` is already a
per-head file channel, so that falls out of the existing design.

Two details the implementation settled:

- **The unfiltered read carries no diff blocks.** "Show me everything" should stay
  cheap enough to call habitually; a fenced context block per comment would make
  an unfiltered read on a long review the most expensive tool in the session. Ask
  for `numbers` and you get the full context for those.
- **A reviewer signs as `reviewer`, not as `agent`.** The review slot has its own
  `reviewq` dir (`<head>@review`) but no comment store of its own - the comments
  are about the head, and a reviewer writing into a private store would be talking
  to nobody. `commentOwner` maps the slot back to the head and swaps the author,
  so the head cannot sign as its own reviewer.

### Resolve, read, and working through a review

Three things turn a numbered list into something you can actually work through,
and they are all built. Each is Hydra's own state about a comment it may not own,
so all three live in the sidecar (`internal/reviewstore/sidecar.go`).

**Resolve** is a state change, not an edit, so it does not break the append-only
rule: the body stays exactly as written and stays readable, it just leaves the
open list. On a Hydra comment it is a flag; on a forge comment it resolves the
THREAD, which is the unit anyone actually resolves.

Resolving a forge thread is **local to Hydra**, and that is a decision rather
than a gap. Resolving on the forge is a write to someone else's PR, and the two
providers do not make it equally reachable: GitHub's `resolveReviewThread` is a
GraphQL mutation keyed by a thread *node* id, which Hydra does not fetch (its
thread handle is the root comment's id). A resolve that silently worked on GitLab
and silently did not on GitHub would be worse than one that is honestly local
everywhere, so the API returns `resolved_locally` and the card says "resolved
here" with a tooltip naming the forge that still shows it open. The forge's own
flag still wins when it is set.

**Read** is per-number and only ever set explicitly - nothing becomes read by the
passage of time, and nothing is marked read by merely scrolling past. A comment
you wrote yourself is born read; anything an agent or a reviewer left is not. The
unit that gets marked is the *conversation*: arriving at a thread marks every
note in it, because otherwise the dot stays lit on the reply you just read.

**The navigator** (`↑ ↓` in the Changes bar) steps through what is still open, in
document order, across both origins - a forge thread and a Hydra comment are the
same thing to someone working through a review. Two counts, because they answer
different questions: `N open` is how much is left, `N new` is what arrived while
you were elsewhere. The cursor is held as a NUMBER rather than an index, so
resolving the comment you are standing on does not silently move you somewhere
else.

### Who said it: avatars without hosting any

A comment carries a small rounded square saying who left it
(`web/src/components/Avatar.tsx`). Three sources, each falling back to the next
rather than to a broken frame, and **Hydra stores no images and proxies none**:

1. **An agent** gets its own brand mark - the same logomark the sidebar and spawn
   form use, in the same accent colour, on a tinted tile. Nothing to fetch, it is
   already in the bundle, and "an agent said this" becomes readable at a glance
   instead of a name you have to read.
2. **A forge user** gets the picture the forge already hosts. Both providers hand
   it over with the comment - GitHub's GraphQL `author { avatarUrl }`, GitLab's
   `author.avatar_url` - so this is a field on `forge.Note`, not a URL Hydra
   guesses from a login (which would break on Enterprise and on GitLab entirely).
   The browser loads it directly with `referrerPolicy="no-referrer"`, and an
   error falls silently to (3).
3. **Everyone else, including you**, gets a monogram on a colour derived from the
   name by a small string hash - deterministic, so one person is one colour in
   every list, and it works with no network at all.

**"You" is whoever git says you are.** Hydra has no accounts, so the comments
response carries `you` from the project's `user.name`; it is the only name a
comment that never went near a forge has, and it is the name your commits already
carry. Deliberately NOT built: matching your git name against a forge login to
borrow that avatar. `Callum Tolley` and `trolleyman` are not the same string, and
a heuristic that silently attributes your comment to someone else's face is worse
than a monogram.

A rounded square rather than a circle, to match the chips and tiles the rest of
the UI is built from - a lone circle in a square-cornered gutter reads as a
different system.

**The avatar owns the left column**, replacing the speech-bubble glyph that used
to sit there, and a forge thread gets one PER NOTE rather than one per card: a
thread has several authors, so a single icon for the whole card could only ever
be generic. Everything else in a note hangs off that column, and the thread's
actions and reply box indent to match (`pl-7` - the avatar plus its gap). A draft
carries one too: a draft is still yours, and a bubble in the same slot said less.

**The number sits on the right**, at the far edge of the header row, where it
reads as a reference rather than as part of the sentence - the same place the
forge threads put theirs. The unread dot rides on it, so what is new and what to
call it are one glance.

**A draft shows no number and a `draft` chip.** It HAS a number - allocated when
it was written, and publishing does not change it - but until it is published
nobody else can cite it, so putting a handle on it would invite quoting something
the agent cannot look up. The chip is the one state worth calling out: the
difference between something the agent has been told and something only you can
see is not otherwise visible on the card. Every draft card also carries the same
Submit review popover as the Changes toolbar in a footer at its bottom right.
Both instances are the shared `ReviewDraftPopover`, including the chevron,
selection list, held-back state, anchored entrance motion and submission path, so
the review can be inspected and published without returning to the toolbar. Its
panel is portalled and viewport-positioned: the inline trigger lives inside the
diff file's rounded overflow clip, where an in-place popup would be cut off.
Selecting a draft marks its card with the transient focus cue and uses the
remeasuring diff scroll path; this matters for a comment on an unchanged file,
whose off-diff card can grow while its source context is still loading.
Submitting a selection is optimistic: those drafts immediately become sent,
read comments in the diff while the daemon publishes them. The response remains
canonical, and a failed publish restores only the selected drafts without
disturbing comments added while the request was in flight.

**A reply can join the draft review or be sent immediately.** Add to agent review
stores it as a draft under the published parent, while Comment to agent publishes
it at once. In both cases the parent owns the anchor, so the reply box needs no
second file or line selection.

**Your own comments say "You"**, not your git name. The name is on the avatar's
tooltip; in a list of comments what matters is which ones are yours. With no git
`user.name` to draw on the avatar is a person glyph rather than an initial - "Y"
for "You" is a letter that belongs to nobody and reads as someone whose name
starts with Y.

### Permalinks

`#comment-4` on the agent page. The number is the whole address - the head is
already in the path, and a number is stable and never reused - so the link is
short enough to paste into a message and still means one exact thing months
later. Landing on one jumps to it and marks it read. The jump keys on the number
rather than on the diff, so a background refresh cannot yank the view back to the
anchor after you have scrolled away. Its amber focus cue stays fully visible long
enough to orient you, then fades back to the card's normal colour instead of
ending in a hard visual cut. In a forge thread the cue sits on the exact numbered
note the link names, while Previous/Next still treats the conversation as one
navigation stop.

Three ways to get one, because people reach for different ones:

- **The date**, as on a forge. It is a real `<a href>` so copy-link-address and
  middle-click behave the way a link should, with the click intercepted so an
  in-app jump does not reload the page.
- **The `...` menu on ANY note**, not just a thread's first. The thing you most
  often want from that menu is a link to *that* comment, which a menu on the
  opening line cannot give you. It also carries **Copy as markdown** (the body
  quoted under a link back, with its file and line - a review remark without its
  location is an opinion about nothing) and **Mark unread**, which is the only way
  a comment becomes new again. Thread-wide actions ("Resolve with agent", the
  thread's forge link) stay on the first note, where they describe the whole
  conversation. The menu is portalled and viewport-positioned because forge
  notes render inside the diff file's overflow clip; keeping it in the note's DOM
  subtree would cut the menu off at the next code row.
- **The link button** on Hydra's own comments.

Two UI details that were wrong and are worth remembering:

- **The resolve control was a double tick** (`CheckCheck`). In every messaging app
  that means "read", which is precisely the wrong thing to say next to an unread
  dot. It is a `CircleCheck` now - "mark this done" rather than "seen".
- **The number rode ~3px high of the buttons beside it.** It sat in the body
  column while the controls were a sibling of that column, so the two had
  different line boxes and no amount of alignment on the parent could fix it (the
  Flexbox 8.3 trap in CLAUDE.md, in miniature). The header row now holds the
  number AND the buttons, so they share one centre line - measured at 0.00px
  apart rather than eyeballed.

### Telling a head something: one shape, four rules

The things that could notify a head keep multiplying - published comments, a
resolve, a forge reviewer, a failing test. They all want the same rules, and the
rules are worth stating once rather than rediscovering per source:

1. Fire on a **transition**, never on a poll tick.
2. **Batch.** Resolving five comments is one line, not five model turns.
3. Respect what the head is **doing** (see below).
4. Send **one short line** and let the agent pull the detail with the tool it
   already has. The comment/log is canonical; the message is a pointer.

Rule 3 is not "never interrupt", which is what it looks like at first. It is
"interrupt only when the interruption is the point", and the two cases pull in
opposite directions:

- **New information** (comments published, tests failed) waits until the head is
  NOT mid-turn, so it never lands in the middle of something.
- **A cancellation** - resolving a comment - only fires BECAUSE it is mid-turn.
  Otherwise it is silent, and deliberately so: `reviewstore.OpenComments`, the
  agent's default read, already filters resolved comments out, so an idle agent
  picks the change up for free the next time it looks. The single case worth
  spending a turn on is "you are working on #3 right now and I have just
  cancelled it". Reopening never notifies - the comment is simply back in the
  list it reads anyway.

Resolve notifications are debounced (`resolveNotifyDelay`) so a run of clicks is
one message, and re-checked at the end of the debounce: a head that finished while
you were resolving gets nothing.

**And one of them has to give up.** Test failures are the case where the four
rules are not enough: dedup is per (runner, commit), and the notify -> fix ->
commit -> still red -> notify cycle produces a NEW commit each time, so every
report is genuinely new news and nothing bounds it. `testNotifyMaxStreak` does -
after three consecutive reports with no human in between, Hydra stops talking. The
head is not cut off (it can read its own status whenever it likes); Hydra has just
stopped paying to repeat something it has said three times. The streak resets when
the suite goes green, or when the USER types something - a message Hydra sent
itself deliberately does not reset it, or its notifications would keep renewing
their own licence to send more. Same "no chains without a human" rule the mentions
follow.

### Unread, in the UI

Three surfaces, deliberately different from each other:

- **In the diff** - a dot on the comment's number, and `N open · N new` in the
  navigator, with `↑ ↓` and a mark-all-read.
- **On the sidebar card** - a speech bubble with a count, NOT a third dot. The
  card already carries a needs-input dot and an unread-changes dot; a third would
  make none of them readable, and this one has to say how many, which a dot
  cannot.
- **A toast** when comments land while you are looking at something else, on the
  INCREASE only - the count also falls when you read one, and announcing that
  would be telling you about your own action.

`unread_comments` is its own field on the agent rather than folded into
`has_unread_changes`, because that flag means "the agent finished" and one
indicator meaning both would be trustworthy for neither.

### Mentions: who a comment wakes

`@review` addresses the reviewer, `@agent` (or `@head`) the head, naming both
reaches both - and **no mention means the head**, exactly as it always has.
That default is what makes the feature free to adopt: every existing gesture keeps
working, and the reviewer becomes addressable for the first time. The explicit
`@agent` is redundant with the default and exists anyway, because once two agents
are on one diff "who am I talking to" is worth saying out loud rather than leaving
to a rule you have to remember.

Three rules hold it together:

- **An agent's own comment never routes.** Otherwise one "@review this" in a reply
  becomes a chain of agents summoning each other, which is an unbounded bill and
  nobody's idea of a review.
- **`@review` DOES start a reviewer.** This went the other way first, on the
  grounds that a slot costs a checkout, a sandbox and a model session and typing a
  word should not spend that. The reasoning was wrong about what a mention is: an
  accidental spawn would be indefensible, but `@review` is a person typing the
  reviewer's name to address it, which is the same intent as clicking the Review
  tab and should not do less. An agent's comment still never routes, so no agent
  can spawn one. The start is async (a sandbox takes seconds, and a publish should
  not block on it) and the notice retries briefly, because a just-launched agent
  is not ready for stdin the instant Start returns. The UI says a reviewer was
  addressed - one working in a tab you never opened is otherwise invisible.
- **The highlighter and the parser share a pattern.**
  `web/src/lib/mentionHighlight.tsx` deliberately mirrors
  `internal/reviewstore/mentions.go`, because a token the box paints and the daemon
  ignores teaches a rule that is not real. It paints in the comment box and the
  thread reply box ONLY: a mention means nothing in the chat composer, and
  highlighting it there would promise a behaviour that does not exist.

A local note on a forge thread routes the same way - it is *your* comment. What
Hydra deliberately does NOT do is notify because an outside reviewer commented:
that is the forge's conversation, and an agent woken by every drive-by remark is a
bill rather than a feature.

### Marking an automated turn

`SendAgentInput` injects a plain user turn, so the chat could not tell "you said
this" from "Hydra said this for you". `origin` on the user message fixes that, and
the test for what belongs in it is **"did the user type it in the composer"** -
not "did Hydra write the words". So Fix with agent and Resolve with agent count as
automated, even though you meant every word of them.

The bubble keeps the user's shape and side - it speaks for you, and the agent
answers it as if you had - but takes a cooler tint, a dashed edge and a line saying
who sent it and why.

**The `[Hydra]` text prefix stays.** Metadata is invisible to an agent, which only
ever sees the text, so it still needs to know Hydra is speaking. The prefix is for
the model; the marker is for you.

### Attachments: a field, not paths in the body

A comment can carry files - normally a screenshot of the thing being pointed at.
Attach them with the paperclip in the comment box, or by pasting or dropping onto
it; they ride on `Comment.Attachments`, a list of absolute paths under the
project's `.hydra/local/uploads`, and the head reads the files itself because
that path resolves identically on the host and inside every agent sandbox.
`RenderForAgent` puts them after the body as "Attachments (read these files):" -
after, because a picture illustrates a remark rather than replacing it, and the
paths are something for the model to act on.

The chat composer carries an attachment by appending its path to the prompt text.
This deliberately does **not** do that, for three reasons, and they are the reason
the field exists:

- a comment is structured on disk already, so there is somewhere better to put it;
- a **draft is editable in a textarea** - pasted paths would be sitting in it,
  and one stray keystroke would break the link;
- `commentAsMarkdown` and the forge-publish path would otherwise carry a local
  path to a reader who cannot resolve it.

`reviewstore.CleanAttachments` is the gate: it drops blanks, collapses
duplicates, resolves symlinks, and requires every survivor to sit *directly*
inside the uploads dir. Skipping that check would turn a comment into a read
primitive for anything on the host - the path is both handed to an agent to read
and served back to the browser as bytes.

Three things worth knowing before touching this:

- **A comment with only an attachment is a real comment.** "Look at this
  screenshot" is a whole remark, so the empty-draft guard in `PublishDrafts` and
  the handlers' empty check both test body *and* attachments.
- **On `UpdateDraft`, nil and empty differ.** nil leaves the attachments alone,
  so a caller predating the field cannot silently strip them; an empty non-nil
  list clears them, which is what removing the last chip has to do. The HTTP
  handler carries the pointer's nil-ness through rather than flattening it.
- **The forge does not get them.** An upload only exists on this machine, and
  Hydra does not drive the forges' asset-upload APIs, so the new-comment box says
  so plainly when the "Comment on GitHub/GitLab" button is also on screen.

**An agent can attach too.** `add_review_comment` takes an `attachments` array of
paths as the AGENT sees them - a screenshot it just wrote into its worktree, or
into its own `/tmp`. It cannot write into the uploads dir itself (it is read-only
in the sandbox), so the daemon does two things on its behalf, in
`Server.storeAgentAttachments`:

1. **Resolves** each path with `resolveAgentFile` - the same resolver that guards
   the agent-file blob endpoint. It confines the path to the head's own worktree,
   its private `/tmp`, and the uploads dir, and re-checks containment *after*
   symlinks. An agent naming `/etc/passwd` gets nothing. (A head with no private
   `/tmp` legitimately reads the host's, which is the pre-existing rule that
   endpoint already follows.)
2. **Copies** it into uploads via `StoreUploadFile`, under the same 25MB cap a
   browser upload gets. The copy is the whole point: a worktree is deleted when
   the head is merged or killed and the per-head `/tmp` goes with it, so a comment
   that merely pointed at one would rot while still looking fine.

A path that resolves to nothing does **not** cost the comment - the remark is
saved either way, and the tool's answer names the files that did not make it, so
the agent does not go on describing a screenshot the user cannot see.

Two deliberate gaps. `reply_to_review_comment` (a local note) takes none - notes
live in the forge-thread sidecar, not the comment store. And an image-PIN comment
takes none: its composer is the lightbox pin popover, and attaching a second
picture to a comment that already points at one is a combination nobody has asked
for.

In the UI the chips sit INSIDE the comment box, under the text they belong to,
the way the spawn composer does it - so the box, not the textarea, owns the
border and the focus ring (drawn as `focus-within:`, since the highlighted input
is a transparent layer on top and a ring drawn there frames the text rather than
the box).

The composer half is `lib/useAttachmentUploads.ts` - the pick/paste/drop +
optimistic-chip loop, extracted in its plain form because the chat's copy is
welded to its undo timeline and the spawn form's to its localStorage draft cache.
Those two are deliberately left as they are.

### Still open in the comment store

None of it blocking:

- **A forge reviewer's comment does not notify** - the watcher caches the threads
  and updates the chip, and the agent only finds out if it asks. Deliberate for
  now (see above), but the shape is there if it is ever wanted.
- **`resolve_review_thread` as an agent tool**, and the conflict-of-interest
  question it raises: an agent resolving the comments about its own work.

### Unread, and where it should go next

Worth writing down, because the shape matters more than the code. Per-comment
read state is the primitive, and the head-level "something happened here" dot is
derived from it, not the other way round: the existing unread flag means "the
agent finished", and folding "someone commented" into the same dot would make
neither trustworthy. A separate count is cheap and can render as its own badge.

What is deliberately NOT the rule is *read on scroll into view*. A comment can
scroll past while you are jumping to a file, and losing the dot without having
read it is worse than the dot lingering. Arriving at a comment - a permalink, or
a step of the navigator - is the signal, because it is the one that means you
looked.

A toast with a link is the right thing for a comment that lands while you are on
another page, and it must be one toast per batch rather than per comment - the
same batching principle as the notify-by-id line the agent gets. Not built.

## What is already built vs what is new

| | status |
| --- | --- |
| Session slot with no DB row, invisible to `ListHeads` | **built** (shell tabs) |
| Per-session gate/MCP policy | **built** (`seedHead` takes a policy; shells already differ from heads) |
| Read-only git at the OS level | **built** (`git_isolation = readonly`) |
| Disposable detached checkouts | **built** (`artifacts.slotPool`) |
| Agent -> comment write path | **built** (`reply_to_review_comment` -> `reviewq.OpNote`) |
| Notification into an agent | **built** (`SendAgentInput`) |
| Staleness detection | **built** client-side (`hunkHash`, `contextBlock`) |
| Provider-matched session slot + chat framing + UI entry | **built** (Claude and Codex; Claude fallback for other providers) |
| Comment store: anchors, draft/published, forge-independent threads | **built** (`internal/reviewstore/comments.go`) |
| `add_review_comment` / native `get_review_comments` | **built** (`reviewq.OpAddComment` / `OpComments`) |
| Notify-by-id replacing `buildReviewMessage` | **built** (and deleted it) |
| Agent-authored comments rendered in the gutter | **built** (the quiet numbered card in `QueuedCommentCard`) |
| Numbering FORGE comments into the same sequence | **built** (`sidecar.go`, assigned on first sight) |
| Resolve, for a Hydra comment and a forge thread alike | **built** (local-only for the forge, and says so) |
| Per-comment read state + the open/new navigator | **built** |
| Permalink (`#comment-4`) | **built** |
| Agent replies to a comment by number | **built** (`reviewq.OpNote` takes a number) |
| Avatars (agent mark / forge picture / monogram) | **built** (`components/Avatar.tsx`; no image is hosted or proxied) |
| Third origin badge for agent-authored notes | new (`ReviewThreadCard.tsx` knows only `forge` / `local_only`) |
| A head-level unread-comments badge, and an arrival toast | new (see "Unread, and where it should go next") |
| `resolve_review_thread` as an agent tool | new |
| Conditional `resolveGitIsolation` fallback | new (small; see the gotcha above) |

## What state gets reviewed

The reviewer's checkout is a commit, so it sees committed work. That is usually
right, and it is what makes the checkout cheap and cacheable - but it misses
uncommitted work, which mid-task is often most of it.

Cover it with a **snapshot, not a live mount**: `git -C <head-worktree> diff HEAD`
is a pure read of the head's tree, and `git apply` puts it into the reviewer's
checkout at the same SHA. Uncommitted state becomes a commit-shaped input, and
every isolation property is preserved.

A live read-only bind of the head's worktree is the obvious alternative and is a
trap: the head is *actively editing*, so the reviewer reads a torn tree and
reports on code that never existed.

## Build order

1. **Comment store + notify-by-id.** No review agent involved. Server-side
   comments with anchors and draft/published, `get_review_comments` /
   `add_review_comment`, and replace `buildReviewMessage`'s text injection with a
   batched id notification. This alone makes the *existing* agent more useful and
   fixes drafts dying on reload.
2. **The third origin badge + permalinks.** Small, and needed before anything
   agent-authored shows up in the gutter.
3. ~~**Fix the session-id namespace**~~ - **DONE.** `heads.SlotSep` (`@`),
   `SlotSessionID`, `SlotPrefix`, plus the `ScopeUnit` hash. Was a standalone bug
   fix that did not need the review agent; doing it first meant `@review` never
   shipped into a broken namespace.
4. ~~**Extract the slot pool**~~ - **DONE.** `internal/checkout` (`Pool`, `Slot`)
   and `internal/sched`; `internal/artifacts/exports.go` is gone.
5. ~~**The review slot**~~ - **DONE**, and built out of order: it landed before
   the comment store (1-2), so the reviewer currently talks but cannot leave a
   finding anchored to a line. `internal/heads/reviewslot.go`
   (`StartReviewSession`, `EnsureReviewCheckout` at
   `.hydra/local/review-checkouts/<head-id>/`, `RemoveReviewCheckout` /
   `RemoveReviewSessionDir` on kill/purge), `?review=true` routing in
   `internal/http/terminal.go`, and the Review tab in `AgentTerminal.tsx`.
6. **@-mentions**, if wanted - `@<head-id>` / `@self` on a comment, routing
   through the same notification path. At this point it is routing plus a
   loop-cap rule, because both ends already exist.

Still open on the built slot:

- **Exercise each provider against a live head.** Claude and Codex both need
  regular end-to-end coverage in real review checkouts (see the caveat at the
  top).
- **Lens-named extra slots** (`<head>@review-security`). The naming leaves room;
  nothing creates them.

Done since this list was written: the status dot on the Review tab and the
composer note (`AgentTerminal.tsx`, `AgentChat.tsx`), syncing the checkout
forward - silently - as the head commits (`internal/heads/reviewsync.go`), and
ending the session from the tab (`heads.KillReviewSession`).

One rule for anything that grows a new way to message the reviewer: send it
through `ChatQueues.Submit` with an **origin**, never `reg.SendChatUser`. The
queue appends the chat event as it writes, so the bubble lands where it was sent
and carries the "Sent by Hydra" marker; a bare stdin write leaves the transcript
to learn about the message from the CLI's echo, which arrives whenever the CLI
next takes a turn - so notices to an idle reviewer surfaced in a clump at the
bottom, styled as if the user had typed them. `notifyReviewer` (the `@review`
mention) was the last one doing that.

## Deliberately not

- **The reviewer sharing the head's worktree.** Transcript collision, and it
  races the head's edits.
- **A branch for the reviewer.** It cannot commit; a detached checkout is enough.
- **A pooled checkout for the reviewer.** Recycled paths mean a new transcript on
  every re-acquire, i.e. a reviewer that forgets everything.
- **Waking the reviewer on every commit.** Sync its tree silently; a model turn
  per commit is a flood of near-duplicate comments and a real bill. Built once,
  batched and capped, and it was still both of those - see "What wakes the
  reviewer". The reviewer learns that its tree moves from its system prompt.
- **Making Hydra the source of truth for forge comments.** It cannot be - people
  comment, edit and delete on the forge directly. Own the numbering, not the
  content.
- **Reusing a retired comment number.** `#3` must mean one thing forever.
- **A `/` in a session id, or an ordinal slot suffix.** Ids become filenames, and
  an ordinal hides the lens that makes a second reviewer worth having.
- **Fixing the id collision with a reserved-suffix blacklist.** It grows with
  every slot kind, does nothing for existing heads, and leaves the prefix sweep
  ambiguous. Make the separator unrepresentable in a head id instead.
- **N identical parallel reviewers.** Overlapping findings are not free to read,
  and they erode trust in the whole channel. Distinguish by lens, and let each
  read what is already there.
- **Editing published comments.** Append-only keeps the thread an audit log and
  avoids conflict resolution. Drafts stay editable.
- **Showing drafts to agents.** Half-written thoughts are not instructions.
- **Agents posting to the forge.** Promotion of a thread to a PR stays an
  explicit user action - the agent has no forge credentials, which is why
  `reply_to_review_comment` is local-only ([review-threads.md](review-threads.md)).
- **Auto-mention chains.** An agent's reply must not summon another agent without
  a human in the loop, or one "@review this" becomes an unbounded bill.
- **Gating merges on review findings** in a first version. A reviewer that blocks
  a merge on a false positive gets switched off within a day.

---

## Appendix: other ways to run the reviewer

The design above makes the reviewer a session slot. These were the alternatives,
kept because the trade-offs still apply if that turns out to be wrong.

**A sub-agent inside the head's own conversation.** Zero code - the sub-agent
tree already renders in `ChatViewSelector`. But it is the author grading their
own homework, findings return straight into the author's context with no chance
to triage, and nothing durable survives. Good as a pre-prompt convention ("have a
sub-agent review your diff before declaring done"), not as the feature.

**A `[tests.review]` runner.** A `type = "stdout"` runner whose script is a
`claude -p` call emitting `::hydra:test:warn::` markers renders findings in the
tests panel with real file locations - **with no Hydra code at all**. `~/.claude`
is writable in every sandbox by default (`internal/sandbox/defaults.go:25-39`)
and `*.anthropic.com` is on the built-in egress allow-list
(`internal/sandbox/sandbox.go:192-196`), so credentials and network just work.
Caveats: findings squash to one line, there is no reply path, and the prefetcher
runs every enabled runner on every commit (`testPrefetchOnce`) with only a
project-wide opt-out - a per-runner `prefetch = false` on `config.TestScript` is
effectively a prerequisite. **Still the cheapest way to find out whether a
model's findings are worth anything**, before building UI for them.

**A first-class `[review.<name>]` runner.** The runner grown up: a fourth sibling
to tests/artifacts/previews writing structured findings to
`$HYDRA_REVIEW_OUTPUT`. Gets per-commit caching for free. Worse than a slot for
the thing that matters most - you cannot argue with a runner.

**A full reviewer head** stacked on `hydra/<id>` via `BaseBranch`. Works today
with no code. But it needs a branch it will never use, appears in the sidebar as
a peer of real work, and has no link back to what it reviews (there is no
`ParentID` on `db.Agent`). The session slot is this minus everything it does not
need.

**A one-shot `claude -p` from the daemon**, following `generateTitle`
(`internal/heads/title.go:220-242`). Fine for a narrow bounded question. Bad for
review: that precedent deliberately runs with `--tools ""` and no repo context,
and a reviewer that cannot read the code around a diff produces confident
nonsense about context it cannot see.

**A second conversation on the head itself.** Rejected - it is the one option
that can corrupt the head's own conversation, for the transcript-keying reason
above, and its only unique advantage (seeing uncommitted work) is available from
the `git diff HEAD` snapshot.
