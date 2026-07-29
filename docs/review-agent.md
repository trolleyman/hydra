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

Related: [testing.md](testing.md) (the runner + marker machinery), [review-threads.md](review-threads.md)
(the diff viewer's comment gutter), [non-local-integration.md](non-local-integration.md)
(the forge review side), [artifacts.md](artifacts.md) (the sibling runner).

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

## The options

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

Four sinks, and the choice is independent of how the reviewer is run:

- **Tests panel** (`CaseTree`) - free today via `warn` markers. One line per
  finding, real file locations, filters, search. Good enough to evaluate whether
  the reviewer is worth building for; not good enough as the destination.
- **Diff viewer gutter** - the best UX by far, and the diff viewer already has
  the hard parts: line anchoring, a frozen `contextBlock` and `hunkHash` for
  staleness detection, and a card layout. What is missing is a *server-side*
  store (local review comments are `localStorage` only, and `reviewstore.LocalNote`
  requires an existing forge thread id to hang off - `mergeLocalNotes` drops
  orphans) and a third origin badge beside `forge` / `local_only`.
- **A chat message into the reviewed head** - `SendAgentInput` already does
  exactly this, and the existing "Submit review" flow already formats comments as
  markdown for the agent (`buildReviewMessage`). Cheapest delivery, but it spends
  the head's context and gives you no chance to drop the bad findings first.
- **Its own chat pane** - only option E, and the only one where the findings are
  a conversation rather than a list.

The sinks compose: D writing to a server-side findings store, rendered in the
gutter, with a per-finding "send to agent" button reusing `SendAgentInput`, is
the shape worth aiming at.

## When it fires

- **Manual button** - "Review this diff" in the agent header. Always needed.
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

1. **Today, free:** adopt A as a convention - a pre-prompt line telling the head
   to have a sub-agent review its diff before declaring done. Costs nothing,
   catches the obvious.
2. **First build (small):** C - a `[tests.review]` runner emitting `warn`
   markers, plus the per-runner `prefetch = false` flag on `config.TestScript`
   so it is manual-only. This answers the question that actually matters - are
   the findings any good? - for a day's work and no new subsystem.
3. **If the findings are good, and you want to argue with them:** E - a
   "Review this diff" button spawning an `Ephemeral` head with
   `BaseBranch = hydra/<id>`, plus a `ReviewOf` column and child-card rendering.
   Mostly bookkeeping.
4. **If the findings are good, and you want them in the gutter:** D - the
   `[review.<name>]` runner, a server-side findings store, and a third origin in
   `ReviewThreadCard`. This is the real feature, and it is worth doing only once
   steps 2 or 3 have shown the reviewer earns its place.

Steps 3 and 4 are not alternatives - they answer different questions ("discuss
this with me" vs "annotate my diff") and can both exist.

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
