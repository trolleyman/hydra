# Review agent + a real comment system

Status: **proposed, unbuilt.** This is a design, not an options survey - the
survey it grew out of is kept as an appendix at the bottom.

Two halves that only work together:

1. **A review slot** - a "Review" entry in the chat view dropdown opens a chat
   with a reviewer agent that has its own disposable checkout, no branch, and no
   ability to write to git.
2. **A server-side comment system** - comments stop being ephemeral text piped
   into an agent's context and become durable, addressable objects that agents
   read and append to through tools.

The second is the more valuable half. It is worth building even if no review
agent ever ships, because it fixes the existing "Comment to agent" flow, which
today formats a markdown blob and injects it into the transcript where it cannot
be re-read, re-anchored, or survive a compaction.

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
  under an id derived from the head (`<head>-shell[-host]`, `ShellSessionID` at
  `heads.go:849`), seeds it with its own policy, and registers it in
  `session.Registry`. It **never touches `internal/db`**.
- `ListHeads` builds its result from `store.ListAgents` and only overlays live
  status from the registry (`heads.go:105-150`). So a registry-only session is
  invisible to the head list **by construction** - there is no exclusion filter
  to write.
- Teardown is already a prefix sweep: `reg.KillMatching(head.ID + "-shell")` on
  kill/merge (`heads.go:1562,1737`).

So a review slot needs **no DB row, no branch, no sidebar card, no merge path**.
It is a sibling of `<head>-shell` (though the id scheme itself needs fixing
first - see below).

The one thing that genuinely differs from a shell is the argv and the seeding:
`StartShellSession` hardcodes `/bin/bash` and passes an empty `gate.Policy{}`
(`heads.go:1034,1054`). A review session wants
`sandbox.AgentArgv(sandbox.AgentTypeClaude, ...)`, chat-mode framing, and a
**real** gate policy. That is the new code, and it is the same shape as the
existing function.

### The slot id: `<head>-review`, not `<head>/<N>`

Two reasons not to key the slot by an ordinal under a slash.

**A `/` breaks things, because these ids become filenames.** `seedGatePolicy`
writes `cacheDir/<id>-gate-policy.json` (`internal/heads/seed.go:467`) and
provisions `paths.GetApprovalsDirFromProjectRoot(projectRoot, id)`. An id of
`agent-1/2` names a directory that does not exist. The established convention is
a hyphen, for exactly this reason - `ShellSessionID` produces
`<head>-shell[-host][-<token>]` (`heads.go:849`).

**And a bare ordinal hides the only thing that makes a second reviewer
worthwhile.** `agent-1-review-2` says nothing; `agent-1-review-security` says
everything. Ordinals are also unstable - kill the second slot, make another, and
whether it is `2` or `3` depends on bookkeeping nobody wants to maintain. A lens
name is self-describing and idempotent.

So: **`<head>-review`** for the default, with no suffix at all, leaving
`<head>-review-<lens>` free for later. A single-slot v1 then needs no naming
scheme, and adding lenses later is not a migration.

### The session-id namespace is broken today, and `-review` would inherit it

Session ids are built by **string concatenation onto a head id**, and head ids
can contain hyphens. That collides, and it is not theoretical.

`ValidateHeadID` accepts `^[a-zA-Z0-9][a-zA-Z0-9._-]*$` for an explicit id
(`internal/heads/id.go:29`), and `slugifyHeadID` produces `[a-z0-9-]` from a
prompt's first eight words (`id.go:82-94`). So two ordinarily-named heads are
enough: a head from "Fix the" (`fix-the`) and a head from "Fix the shell script"
(`fix-the-shell-script`).

Three things break, in increasing order of severity:

1. **Spawn/resume failure.** `Registry.Start` returns `ErrExists`
   (`internal/session/registry.go:20`) - a head named `foo-shell` cannot start
   while head `foo` has a live shell tab holding that id.
2. **Cross-head kill.** Teardown is `reg.KillMatching(head.ID + "-shell")`
   (`heads.go:1562,1737`), and `KillMatching` is a **prefix** sweep
   (`strings.HasPrefix`, `registry.go:638-651`). Killing or merging head
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

Collisions then become impossible by construction, and the prefix sweep becomes
sound as a side effect: `KillMatching("foo@")` can only ever match head `foo`'s
own slots.

**The migration is close to free**, which is why this is worth doing now rather
than after a third slot kind exists: slot ids live only in `session.Registry`
(in-memory - shell sessions have no DB row), and their on-disk traces are
regenerated cache files. A daemon restart is the migration.

Worth doing as belt and braces afterwards: record the **owning head id** on the
session and sweep by field equality instead of by string prefix. The registry
already carries a per-session worktree label, so there is a natural home for it,
and it retires the whole prefix-matching bug class rather than just this
instance.

### Correction: its own tree, not the head's

The proposal says "read-write tree". Agreed on read-write - a read-only tree
breaks builds, caches, and test runs for no benefit. But it must be the
reviewer's **own** checkout, not the head's, for two independent reasons:

1. **Transcript collision.** Claude's transcript dir is keyed by *worktree path*
   (`claudeProjectDir`, `internal/http/chat_ws.go:918`) and resume falls back to
   an mtime scan over it (`claudestream.LatestSessionID`). A reviewer sharing the
   head's worktree writes into the same dir the head resumes from, and the head's
   next `--continue` can latch onto the reviewer's conversation.
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
`.hydra/local/review/<head-id>/` - created once and checked out forward in place.
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
turns, and tell the reviewer the tip moved. Never mid-turn. The reset button is
killing the slot, exactly like closing a shell tab.

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

If an automatic pass is wanted, hang it on the **`finished` transition**, not on
commits - the hook machinery already distinguishes main-agent completion from
live sub-agents, and merge-when-green already gates on finished-for-10s, so there
is a precise, once-per-task moment to fire on.

### Surviving a restart

Yes, and most of it falls out of decisions already made:

- **Comments** are server-side by construction. Free.
- **The reviewer's conversation** needs the lazy resume-on-attach path heads
  already have (`ResumeHead` when the session is dead but the tree remains):
  opening the Review view revives it rather than starting fresh.

The neat part is that the own-tree decision makes resume *safe* here. Bare
`--continue` is unreliable in a head's worktree only because something else may
write that transcript dir; the reviewer's checkout is used by exactly one
session, so the mtime heuristic is unambiguous and no session-id bookkeeping is
needed. A slot has no DB row - that was the point - and this is why it does not
need one.

**That only holds if the checkout path is stable**, which is the argument against
a pooled slot above. Same requirement, arrived at from the other direction.

### The dropdown entry

`ChatViewSelector` (`web/src/components/AgentChat.tsx:4120`) is the right home -
it is already the "which conversation am I looking at" control. But adding Review
to it is a **category change** worth making deliberately: every entry today is a
*view over one head's transcript* (the main conversation plus its sub-agent
sidechains). A review slot is a different process, a different session and a
different transcript.

Once the selector is a session switcher, the bash shell tabs arguably belong in
it too - and they currently live in an entirely separate control, the `+`
split-button in `AgentTerminal.tsx`. Two switchers for "what is in this pane" is
the outcome to avoid. Ship the narrow version (Review joins, shells stay put),
but know that is the direction.

Even in the narrow version: **put a divider between Review and the sub-agents.**
Sub-agents are *children of* the main conversation; Review is a *sibling of* it.
A flat list erases that, and the hierarchy is the only cue for why one of them
disappears when a turn ends and the other does not.

Three things matter more than the dropdown itself:

- **Make the entry lazy.** A reviewer that does not exist yet renders as an
  action, and opening it is what creates it. Pre-spawning a checkout and a model
  session per head - most never opened - is real cost for nothing.
- **Status has to show on the *closed* trigger.** Mid-turn, unread comments,
  stale because the tip moved: if that is only visible once the dropdown is open,
  nobody will open it. Same argument as tabs needing status affordances in
  [agent-page-tabs.md](agent-page-tabs.md).
- **The pane must be unmistakably a different agent.** This is the one likely to
  bite: switching to Review and forgetting you are not talking to your head is
  easy, and the failure is silent - you tell it to "just fix that" and it cannot,
  because it has no git and a throwaway tree. A changed dropdown label is not
  enough; the pane wants persistent identity (a tinted header or a badge), and
  the composer should say what this agent cannot do.

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
`/project/<p>/agent/<h>?comment=4`, and the head is already in the path.

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

- An append-only local map, `(origin, external_id) -> #N`, assigned on **first
  sight** of a comment from any origin.
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
| `get_review_comments` | no args = all published on this head; with ids = those, full body + anchor + diff context | extends the existing forge-only tool (`internal/mcpserver/server.go`) to Hydra-native comments |
| `add_review_comment` | `path`, `line`/`line-range`, `body` | new; opens a thread |
| `reply_to_review_comment` | `thread_id`, `body` | **already built** - `reviewq.OpNote`, writes an agent-authored note |
| `resolve_review_thread` | `thread_id` | optional, later. A state change, not an edit of content, so it does not break the append-only rule |

Scope every tool to the calling head's own comments. `reviewq` is already a
per-head file channel, so that falls out of the existing design.

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
| Claude-argv session slot + chat framing + UI entry | new |
| Comment store: anchors, draft/published, forge-independent threads | new |
| `add_review_comment` / native `get_review_comments` | new |
| Notify-by-id replacing `buildReviewMessage` | new (and deletes code) |
| Third origin badge for agent-authored notes | new (`ReviewThreadCard.tsx:44-83` knows only `forge` / `local_only`) |
| Permalink / URL sub-view state | new (see [agent-page-tabs.md](agent-page-tabs.md)) |
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
3. **Fix the session-id namespace** (`@` separator, and ideally an owner field
   instead of the prefix sweep). This is a **standalone bug fix that should not
   wait for the review agent** - it can silently disable a live head's gate
   today. Doing it first also means `-review` never ships into a broken
   namespace.
4. **Extract the slot pool** out of `internal/artifacts` into its own package,
   deleting the `exports.go` shim. Mechanical, and it is on the path anyway -
   better before a third consumer than after.
5. **The review slot.** A Claude-argv sibling of `StartShellSession`, its own
   persistent checkout under `.hydra/local/review/<head-id>/`,
   `git_isolation = readonly` with git tools blocked, resume-on-attach, and a
   "Review" entry in the chat view dropdown.
6. **@-mentions**, if wanted - `@<head-id>` / `@self` on a comment, routing
   through the same notification path. At this point it is routing plus a
   loop-cap rule, because both ends already exist.

## Deliberately not

- **The reviewer sharing the head's worktree.** Transcript collision, and it
  races the head's edits.
- **A branch for the reviewer.** It cannot commit; a detached checkout is enough.
- **A pooled checkout for the reviewer.** Recycled paths mean a new transcript on
  every re-acquire, i.e. a reviewer that forgets everything.
- **Waking the reviewer on every commit.** Sync its tree silently; a model turn
  per commit is a flood of near-duplicate comments and a real bill.
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
