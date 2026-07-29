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
It is `<head>-review`, a sibling of `<head>-shell`.

The one thing that genuinely differs from a shell is the argv and the seeding:
`StartShellSession` hardcodes `/bin/bash` and passes an empty `gate.Policy{}`
(`heads.go:1034,1054`). A review session wants
`sandbox.AgentArgv(sandbox.AgentTypeClaude, ...)`, chat-mode framing, and a
**real** gate policy. That is the new code, and it is the same shape as the
existing function.

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
checkout is enough. That is exactly the `slotPool` primitive that already exists
for tests and artifacts (`internal/artifacts/slots.go`): bounded, reused via
incremental `git checkout --force`, crash-safe.

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
3. **The review slot.** A Claude-argv sibling of `StartShellSession`, a detached
   checkout, `git_isolation = readonly` with git tools blocked, and a "Review"
   entry in the chat view dropdown.
4. **@-mentions**, if wanted - `@<head-id>` / `@self` on a comment, routing
   through the same notification path. At this point it is routing plus a
   loop-cap rule, because both ends already exist.

## Deliberately not

- **The reviewer sharing the head's worktree.** Transcript collision, and it
  races the head's edits.
- **A branch for the reviewer.** It cannot commit; a detached checkout is enough.
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
