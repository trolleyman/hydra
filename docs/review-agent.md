# Spawning a review agent for a head's diff

Status: **proposed, unbuilt.** This is an options survey, not a design that has
been committed to. It exists because "get a second model to review this head's
diff" has an unusually large number of plausible homes in Hydra - a chat thread,
a sub-agent, a test runner, a second head, a one-shot daemon call - and they are
not equivalent. The answer depends less on the model call (which is the easy
part) than on three questions the options answer differently:

1. **What does it read** - the committed branch tip, or the live worktree with
   uncommitted work in it?
2. **Where do the findings land** - the tests panel, the diff viewer's comment
   gutter, the head's chat, or its own pane?
3. **What does it cost the head being reviewed** - context window, transcript
   integrity, wall-clock, money per commit?

**The framing that makes the rest fall into place, and which a first pass at this
doc missed: a review agent is not a report generator, it is a participant in a
comment thread.** Once the reviewer posts into threads and you summon it by
@-mentioning it on a line, the "where do the findings go" question answers itself,
the trigger becomes contextual instead of global, and the same mechanism covers
self-review, asking another head, and spawning a fresh reviewer. That design is
["Review is a thread"](#review-is-a-thread-not-a-report) below; the options survey
after it is then only about *how the reviewer is run*, which is a smaller and
more replaceable decision.

Related: [testing.md](testing.md) (the runner + marker machinery), [review-threads.md](review-threads.md)
(the diff viewer's comment gutter), [non-local-integration.md](non-local-integration.md)
(the forge review side), [artifacts.md](artifacts.md) (the sibling runner),
[agent-page-tabs.md](agent-page-tabs.md) (the navigation work that gives threads
a permalink).

## The constraint everything bends around

Claude's transcript directory is keyed by **worktree path**, not by head or
session id: `claudeProjectDir` (`internal/http/chat_ws.go:918`) resolves to
`~/.claude/projects/<paths.ClaudeProjectsSlug(worktree)>`, and resume picks a
conversation out of it with an mtime heuristic -
`claudestream.LatestSessionID` / `LatestTranscript` (`internal/claudestream/transcript.go:30,61`),
newest non-sidechain `.jsonl` wins. `sandbox.AgentArgv` prefers
`--resume <id>` when that id is known and falls back to bare `--continue`
otherwise (`internal/sandbox/agentcfg.go:626-656`).

So: **any second Claude process whose cwd is the head's worktree writes into the
same transcript dir the head resumes from.** Nothing locks it. The head's next
resume can latch onto the reviewer's conversation instead of its own. This is the
single biggest reason to be careful with "just add another thread", and the
reason every other option here is cheap: give the reviewer a *different cwd* and
the isolation is free and total - different path, different slug, different
transcript dir, no shared state at all.

Hydra's own session registry is a separate, weaker guard: `session.Registry` is
keyed by session id and returns `ErrExists` for a duplicate
(`internal/session/registry.go`), which is why the shell tabs use derived ids
(`<agent>-shell`, `<agent>-shell-host`). That stops Hydra tracking two sessions
under one id; it does not stop two Claude processes sharing a transcript dir.

## Parts already in the box

Most of what a review agent needs already exists for tests and artifacts. Worth
knowing before choosing, because it moves the cost estimates a lot.

| Need | Already built | Where |
| --- | --- | --- |
| An isolated checkout of an arbitrary commit | bounded pool of persistent detached-HEAD worktrees, reused via incremental `git checkout --force` + `git clean`, crash-safe, max 4 | `internal/artifacts/slots.go`, acquired at `internal/tests/manager.go:950` |
| Sandboxed exec with the project's policy | `buildCommandSpec` -> `egress.StartCommandEgress` -> `sandbox.BuildSpec`, wrapped in a transient systemd scope for cgroup limits + one kill handle | `internal/tests/manager.go:1144,1209,1217` |
| Claude credentials inside that sandbox | `~/.claude` and `~/.claude.json` are **writable by default** in every sandbox, agent or runner | `internal/sandbox/defaults.go:25-39` |
| Network to the API | `*.anthropic.com`, `claude.ai`, `platform.claude.com` are on the built-in egress allow-list | `internal/sandbox/sandbox.go:192-196` |
| Per-commit caching + background prefetch on tip change | test cache keyed by commit, 30s prefetch sweep that cancels stale runs | `internal/http/tests_prefetch.go` |
| Live streaming of findings to the UI | `::hydra:test:<pass\|fail\|warn\|skip>[:ms]:: path:line:col › scope › name \| message` scanned off stdout | `internal/tests/stream.go`, [testing.md](testing.md) |
| A findings tree with file locations, filters, search | `TestsPanel.tsx` + `CaseTree.tsx` | `web/src/components/` |
| A gate that can block a merge | `testGateVerdict` | `internal/http/tests.go:575` |
| A one-shot, non-interactive model call | `claude -p --model haiku --tools "" --strict-mcp-config --system-prompt ...`, `cmd.Dir = os.TempDir()`, 25s cap | `internal/heads/title.go:220-242` |
| Spawning a head based on another head's branch | `BaseBranch = hydra/<id>` -> `git worktree add -b <new> <path> <base>` | `internal/heads/heads.go:378`, `internal/git/worktree.go` |
| Throwaway heads | `SpawnHeadOptions.Ephemeral` - torn down on close, not resumed, not listed by default | `internal/heads/heads.go:385` |
| A local, non-forge note store | `reviewstore.LocalNote{ID, ThreadID, Author, Body}`, append-only JSON per head, `Author: "agent"` already a thing | `internal/reviewstore/reviewstore.go:23-97` |
| Delivering text into a head as a user turn | `SendAgentInput` - chat queue for chat heads, bracketed paste into the PTY otherwise | `internal/http/handlers.go` |

What is **not** in the box: any notion of one head being related to another (no
`ParentID` on `db.Agent`), any server-side store for diff-anchored comments that
are not forge threads (local review comments are `localStorage` only -
`PendingReviewComment` in `web/src/lib/reviewDrafts.ts:26-37`), and any origin
badge other than `forge` / `local_only` (`web/src/components/ReviewThreadCard.tsx:44-83`).

## Review is a thread, not a report

Hydra currently has **two half comment systems**, and the gap between them is
exactly the review agent's missing home:

| | local review comment | forge thread |
| --- | --- | --- |
| storage | `localStorage` only (`web/src/lib/reviewDrafts.ts:26-37`) | live from the forge, cached server-side as fallback |
| anchored to a line | yes | yes |
| is a thread | **no** - one shot, fire into chat, gone | yes |
| can be replied to | no | yes (`reviewstore.LocalNote`, local-only) |
| survives a reload / another device | no | yes |
| exists without a PR | yes | **no** |
| addressable / linkable | no | on the forge, not in Hydra |

So today you can either write a note that has no thread and no persistence, or
have a real thread that requires a published PR. Neither can hold a conversation
between you and an agent about a line of code, which is what review actually is.

**The proposal: a Hydra-native comment thread** - server-side, anchored to
`(commit, path, line-range)`, with a stable id, existing with or without a forge.
The data model is most of the way there already: `reviewstore.LocalNote{ID,
ThreadID, Author, Body, CreatedAt}` (`internal/reviewstore/reviewstore.go:23-97`)
is append-only JSON per head and already understands a non-human author
(`AuthorAgent = "agent"`). What it lacks is (a) an anchor, and (b) the ability to
exist without a forge parent - `mergeLocalNotes` (`internal/http/review_threads.go`)
deliberately *drops* notes whose thread is not in the forge's list. Staleness
handling already exists client-side: `PendingReviewComment` freezes a
`contextBlock` and a `hunkHash` per comment for exactly this.

### @-mentions are the trigger

Instead of a global "Review this diff" button, you summon a reviewer **on the
line you care about**:

- `@<head-id>` - ask another head. Head ids are already global primary keys, so
  they are addressable across projects with no new naming scheme.
- `@self` - ask the head that wrote this to explain or reconsider it.
- `@review` - a reserved handle: spawn an ephemeral reviewer scoped to this
  thread's anchor (which of the run options below backs it is an implementation
  detail the user never sees).

Why this is better than a button:

- **The anchor is the prompt.** "@review is this lock held across the await?" on
  line 40 carries its own context. A global "review this diff" has to be answered
  in the abstract, and abstract review is where models produce confident noise.
- **Both directions of delivery already exist.** Inbound: `SendAgentInput`
  (`internal/http/handlers.go`) queues a chat turn for a chat head or
  bracketed-pastes into the PTY otherwise, and the diff viewer already formats
  comments as markdown for an agent (`buildReviewMessage`). Outbound: an agent
  replies with `reply_to_review_comment` -> `reviewq.OpNote`
  (`internal/reviewq/reviewq.go`), which takes a `thread_id` + `body` and writes a
  `LocalNote` authored by `"agent"`. **The agent reply path is built.** It is
  currently pointed only at forge threads.
- **One mechanism, three features.** Self-review, cross-agent review and a fresh
  reviewer stop being three UI surfaces and become three handles.
- **It absorbs the delivery gap.** The reason the first pass at this doc ended
  with "there is no server-side store for diff-anchored comments that are not
  forge threads" is that building that store *is* this feature.

### What has to be true for it to work

- **Staleness.** A thread anchored to a line the agent then rewrites must degrade
  gracefully. `hunkHash` already detects it; the policy should be GitHub's -
  mark the thread outdated, keep it readable, show it against the code it was
  written on rather than silently re-anchoring to whatever now occupies line 40.
- **Waking a stopped head.** An @-mentioned head may not be running. Lazy resume
  already exists (`ResumeHead` on attach), and `reviewq` is already the on-demand
  file channel the daemon watches for exactly this class of request - so the
  queue is there; the wake-on-mention wiring is not.
- **Mention loops.** Agent A mentions B, B replies mentioning A, forever. Cap
  chain depth and do not let an agent's reply auto-fire another mention without a
  human in the loop. Cheap to get right up front, ugly to retrofit.
- **A permalink.** Threads want `?thread=<id>`, and the agent page has no URL
  sub-view state at all today. That is the same prerequisite the inspector-tabs
  work creates - see [agent-page-tabs.md](agent-page-tabs.md).
- **A third origin badge.** `OriginBadge`
  (`web/src/components/ReviewThreadCard.tsx:44-83`) knows `forge` and
  `local_only`. An agent-authored note currently renders as "private" with the
  author string doing all the work. It needs its own mark - a reader must be able
  to tell "a model said this" from "a person said this" at a glance.
- **Promotion, later.** A Hydra-native thread on a head that later gets published
  should be able to become a forge thread. Deliberately a separate, explicit user
  action - the agent has no forge credentials, which is the whole reason
  `reply_to_review_comment` is local-only ([review-threads.md](review-threads.md)).

## The options - how the reviewer is *run*

These are orthogonal to the thread design above: whichever one backs `@review`,
the findings land in the same place. They differ in what the reviewer can read,
what it costs, and whether you can argue with it.

### A. A sub-agent inside the head's own conversation

The head spawns a Task-tool sub-agent with "review the diff you just wrote".

- **Effort: zero.** No Hydra code at all. The sub-agent tree already renders -
  `ChatViewSelector` (`web/src/components/AgentChat.tsx:4120`) lists the main
  conversation plus every live sub-agent, nested transcripts and all.
- **Reads:** whatever the head shows it, including uncommitted work.
- **Cost:** it is the author grading their own homework. The reviewer inherits
  the author's framing through the prompt, findings return straight into the
  author's context and get acted on with no chance for you to triage, and it
  burns the head's context window. Results are ephemeral - not anchored to the
  diff, not cached per commit, gone after a compaction.
- **Verdict:** the right *baseline* and worth adopting as a convention today
  (a pre-prompt line: "before you say you're done, have a sub-agent review your
  diff against the task"). It is not the feature - it cannot be triggered by
  Hydra, only by the agent, and it produces nothing durable.

### B. A second conversation on the same head ("another thread in the dropdown")

- **Effort: high, and it is the one option that fights the constraint above.**
  A second Claude in the head's worktree shares its transcript dir. The head's
  next resume can pick up the reviewer's session.
- **Mitigations, if it were pursued anyway:** make the head's session id
  authoritative rather than heuristic - `db.Agent.ConversationID` is already
  captured from the CLI's `system:init` line, so always resume with
  `--resume <id>` and never fall back to the mtime scan; and give the reviewer
  its own session id the way the shell tabs do (`<agent>-review`). That is real
  work on the load-bearing resume path, to fix a problem the other options
  simply do not have.
- **The one thing it buys:** the reviewer sees the *live* worktree, uncommitted
  work included, with no snapshot dance.
- **Verdict: don't.** The uncommitted-state advantage is obtainable more cheaply
  (see "What state gets reviewed"), and this is the only option that can corrupt
  the head's own conversation. Note also that the chat dropdown is not currently
  a thread switcher - it is a *view* switcher over one conversation - so this is
  a new concept in the UI, not an extra entry in an existing list.

### C. A `[tests.review]` runner - buildable today, no Hydra code

Add a runner whose script is a `claude -p` call, `type = "stdout"`, emitting one
`::hydra:test:warn::` marker per finding:

```toml
[tests.review]
type = "stdout"
timeout_sec = 600
script = """
git diff "origin/$HYDRA_BASE..HEAD" > /tmp/review.diff
claude -p --model sonnet --output-format text \
  --system-prompt "$(cat .hydra/review-prompt.md)" \
  "Review the diff in /tmp/review.diff. Emit one line per finding: \
   ::hydra:test:warn:: <path>:<line> › <short name> | <finding>"
"""
```

- **What it gets for free:** the isolated pooled checkout, the sandbox + egress,
  the cgroup scope and timeout, per-commit caching, background prefetch on every
  tip change, live streaming into the tests panel, a findings tree with real file
  locations, filters and search, and log persistence. Credentials and network
  work with no config change (see the table). Its cwd is a slot worktree, so its
  transcript slug differs from every head's - zero interference.
- **What it costs:**
  - Findings are squashed to one line each. Prose review does not fit a test
    case, and there is no reply/converse path.
  - It appears as a *test runner*, in the tests verdict and the sidebar chip.
    Map findings to `warn`, never `fail` - warnings are surfaced but never flip
    the verdict or gate a merge ([testing.md](testing.md)).
  - **Money.** The prefetcher runs every *enabled* runner on every branch-tip
    change (`testPrefetchOnce`), and the only opt-out today is the project-wide
    `IsTestPrefetchEnabled()`. A per-runner `prefetch = false` / `on_demand`
    flag on `config.TestScript` is a ~20-line change and is effectively a
    prerequisite for shipping this as anything but an experiment.
  - It reads the committed tip, not the working tree.
- **Verdict: the cheapest honest experiment.** Do this first to find out whether
  the *findings* are any good, before building UI for them. If they aren't, no
  Hydra code was written.

### D. A first-class `[review.<name>]` runner - C grown up

A fourth sibling to `[tests.*]` / `[artifacts.*]` / `[previews.*]`, same
`buildCommandSpec` shape, but with an agent-shaped result model instead of test
cases: `$HYDRA_REVIEW_OUTPUT` receives JSON findings carrying
`path`, `line`, `end_line`, `severity`, `title`, `body` (markdown, multi-line),
and ideally `confidence` and a `hunk_hash` for staleness.

- Reuses everything C reuses, drops C's compromises: findings are prose, they
  anchor to lines properly, and they render in the diff viewer's gutter rather
  than in a test tree.
- Needs: the config struct + merge-by-name plumbing (mirrors `TestScript`), a
  results store (per-commit, same cache shape as tests), a server-side findings
  store, and diff-viewer rendering with a third origin (see "Where findings
  land").
- **Verdict: the likely long-term home for automated review.** It is the option
  where the per-commit caching, the gate integration and the diff anchoring all
  land in the right place at once.

### E. A reviewer head stacked on `hydra/<id>`

Spawn a normal head with `BaseBranch = hydra/<id>`. This already works and is
already documented in the spawn form ("can be pointed at another agent's
`hydra/<id>` branch to stack agents on top of one another"). Git's
same-branch-twice rule is not a problem - a new branch is created off that tip,
not a second checkout of it.

- **What it buys that nothing else does: you can talk to the reviewer.** Its own
  chat pane, its own model, its own tools, full repo context, and a conversation
  you can push back on ("that's intentional, why?"). It can read the code around
  the diff, not just the diff.
- Its worktree is a different path, so its transcript is fully isolated.
- **Gaps:** no parent/child link exists in the DB, so it shows up as just another
  card in the sidebar with no indication of what it is reviewing; it is heavier
  than a runner (full worktree, seeding, sandbox, a branch); it reads the
  committed tip; and its findings come back as chat text, so getting them to the
  reviewed head means copy/paste or a `SendAgentInput` call.
- **To make it nice:** spawn it `Ephemeral` (field exists), add a `ReviewOf`
  column mirroring how `AdoptSpec` pre-links an adopted head to its PR, render it
  as a child card under the head it reviews, and put a "Review this diff" button
  in the agent header / review controls that spawns it with a canned prompt and
  the diff range baked in.
- **Verdict: the best *product* answer if the goal is a reviewer you converse
  with**, and it is 80% built already. The missing 20% is bookkeeping and one
  button, not machinery.

### F. One-shot `claude -p` from the daemon

The title-generator pattern (`internal/heads/title.go:220`): shell out, feed the
diff on stdin, ask for JSON findings, parse.

- Fastest to build, no worktree, no checkout, deterministic output shape,
  trivially cacheable by SHA.
- But that precedent deliberately runs **unsandboxed, with no tools and no repo
  context** (`--tools ""`, `--strict-mcp-config`, `cmd.Dir = os.TempDir()`), and
  those choices are load-bearing for a title generator. A diff-only reviewer with
  no tools is markedly worse - it cannot check a caller, cannot grep for other
  uses of a symbol it thinks is wrong, and produces confident nonsense about
  context it cannot see. Giving it tools means putting it back in a sandbox with
  a checkout, at which point it *is* option C/D.
- **Verdict:** good for a narrow, bounded job (a commit-message critique, a
  "does this diff match the task" sanity check). Not good for code review.

### G. Publish it to the forge

For a head with a PR, post the findings as PR review comments. The existing
review-threads UI then renders them inline, with origin badges and replies, for
free.

- Zero new UI, and the findings are visible to human reviewers too.
- But it requires a published MR, it is public (bad for a noisy first-pass
  reviewer), and it cuts against a deliberate design decision: the agent has no
  forge credentials, which is exactly why `reply_to_review_comment` is
  local-only ([review-threads.md](review-threads.md)).
- **Verdict:** a later opt-in on top of D ("promote this finding to the PR"),
  not a delivery mechanism to build first.

## What state gets reviewed

The committed tip is what every runner-based option sees, because the slot pool
checks out a commit. That is usually right - it matches what tests gate on - but
it misses uncommitted work, which for a head mid-task is often *most* of the
work.

Three ways to cover it, in increasing order of intrusiveness:

1. **Review the tip and say so.** Simplest, and honest. Pairs naturally with a
   trigger on the `finished` transition, by which point the head has usually
   committed.
2. **Snapshot the working tree into the checkout.** `git -C <worktree> diff HEAD`
   is a pure read of the head's worktree, produces a patch, and `git apply` puts
   it into a slot checkout at the same SHA. This converts "uncommitted state"
   into a commit-shaped input, so every cache, sandbox and isolation property is
   preserved, and the head is never touched. **This is the recommended answer to
   the user's "read-only worktree" instinct** - it gets the same information
   without a live mount.
3. **Bind the head's worktree read-only into the reviewer's sandbox.** The
   primitives exist (`restore_ro`, or `cow_paths` for copy-on-write scratch), so
   this is not hard. The problem is not the mount, it is that the head is
   *actively writing* - the reviewer reads a torn tree, half-way through an edit,
   and reports on code that never existed. Prefer (2).

## Where findings land

The destination is threads (above). The other sinks are worth knowing as
stepping stones, because two of them are free today:

- **Tests panel** (`CaseTree`) - free via `warn` markers, one line per finding,
  real file locations, filters, search. The right place to *evaluate* whether a
  reviewer produces anything worth reading, before any UI is built for it. Not a
  destination: a test case cannot hold prose and cannot be replied to.
- **A chat message into the reviewed head** - `SendAgentInput`, free today. But
  it spends the head's context and gives you no chance to drop the bad findings
  first, which for a first-generation reviewer is most of them.
- **Its own chat pane** - option E only, and the fallback if threads are not
  built: a conversation you can push back on, just not one anchored to a line.
- **The forge** - option G, later, as explicit promotion of a thread.

## When it fires

- **An @-mention on a line** - the primary trigger, and the only one that carries
  context. Everything else is a convenience on top of it.
- **Manual button** - "Review this diff" in the agent header, i.e. an @-mention
  of `@review` with the whole diff as its anchor.
- **On the `finished` transition** - the hook machinery already distinguishes
  main-agent completion from live sub-agents, and merge-when-green already gates
  on finished-for-10s, so there is a precise moment to fire on. This is the
  trigger most likely to feel like magic.
- **Per-commit prefetch** - free with C/D, but it is a real model call per
  commit. Off by default; needs the per-runner opt-out noted in C.
- **As a merge gate** - possible (`testGateVerdict` is right there), and
  tempting, and probably wrong for a first version. A reviewer that blocks a
  merge on a false positive gets disabled within a day. Ship it advisory.

## Recommendation

The order below is deliberately "cheap question first": each step answers
something the next one would otherwise be a bet on.

1. **Today, free:** adopt A as a convention - a pre-prompt line telling the head
   to have a sub-agent review its diff before declaring done. Costs nothing,
   catches the obvious.
2. **Find out if the findings are any good, for a day's work:** C - a
   `[tests.review]` runner emitting `warn` markers, plus the per-runner
   `prefetch = false` flag on `config.TestScript` so it stays manual. No new
   subsystem, no UI, and if the output is noise you have written no Hydra code.
3. **Build the thread, not the reviewer.** Server-side Hydra-native threads
   anchored to `(commit, path, line-range)`: extend `reviewstore` with an anchor,
   let threads exist without a forge parent (`mergeLocalNotes` stops dropping
   orphans), add the third origin badge, and render them in the gutter beside the
   existing local + forge cards. **This is worth building even if no review agent
   ever ships** - it is the persistent, linkable, replyable comment system that
   `PendingReviewComment` should have been, and every later step plugs into it.
4. **Wire @-mentions.** `@<head-id>` / `@self` via `SendAgentInput` inbound and
   `reviewq.OpNote` outbound - both ends exist, so this is mostly routing plus
   the wake-on-mention and loop-cap rules. At this point "ask another agent to
   review this line" works with no reviewer subsystem at all.
5. **Then `@review`** - back it with E (an `Ephemeral` head stacked on
   `hydra/<id>`, plus a `ReviewOf` link and child-card rendering) if you want to
   argue with it, or D (a `[review.<name>]` runner) if you want it cached
   per-commit and cheap. E is the better first cut: a thread participant needs an
   identity and a mailbox, and a head already *is* both.

The reframe changes the order from the first pass at this doc: the previous
version had the runner subsystem (D) as the endgame with threads as its output
format. It is the other way round. Threads are the feature; the runner is one
possible tenant, and the one you can defer longest.

## Deliberately not

- **B** - a second conversation on the head's own worktree. The transcript-dir
  collision is a real corruption risk on the resume path, and its only unique
  advantage (uncommitted state) is available via the `git diff HEAD` snapshot.
- **A live read-only mount of the head's worktree** as the default input. Torn
  reads on an actively-edited tree produce findings about code that never
  existed. The snapshot is strictly better and cheaper.
- **`git_isolation = clone`** as the isolation mechanism. It was built and then
  removed ([git-isolation.md](git-isolation.md)); the slot pool already provides
  cheap isolated checkouts and is the thing to reuse.
- **Gating merges on review findings** in a first version.
- **An agent posting to the forge.** Threads are Hydra-local; promotion to a PR
  stays an explicit user action, for the credential reason above.
- **Auto-mention chains.** An agent's reply must not summon another agent
  without a human in the loop, or a single "@review this" becomes an unbounded
  bill.
