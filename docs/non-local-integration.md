# Non-local integration: publishing to a forge

Status: **BUILT** (the parts described under "How it works"). This is the
reference for everything that connects a head to a GitHub/GitLab merge request:
the `[review]` config, the publish flow, the MR link on a head, bi-directional
sync, the lifecycle watcher, the agent-facing review tools and the inline review
threads in the diff viewer. Adopting an *existing* PR as a head is the inbound
half and has its own doc: [pr-adoption.md](pr-adoption.md).

## Why this exists

Hydra's original model is a **local trunk**: a head's work lands with a plain
local `git merge` into its base branch, after which the `hydra/<id>` branch and
worktree are deleted. That is exactly wrong where the unit of landing is a
merge/pull request - there the branch must be pushed, reviewed, CI-checked and
merged **on the server** (often squashed), and only then does the change reach
trunk, which you *pull* rather than produce.

| Local-trunk assumption | MR-workflow reality |
|---|---|
| Landing = local merge into base | Landing = server-side MR merge (often squash) |
| Branch deleted on merge | Branch outlives the head: pushed, reviewed, iterated on |
| "Green" = Hydra's local `[tests.<name>]` | "Green" = remote CI + required approvals |
| `hydra/<id>` branch names | Team conventions, often `feat/JIRA-123-...` |
| Base = local checkout, no fetch | Base should track `<remote>/<trunk>`, freshly fetched |
| Merge detected from git ancestry | Squash merges leave no ancestry - the MR state is the truth |

Nothing here is a mode switch. **The MR link is per-head**: every head starts
unlinked and behaves exactly as it always did (direct local Merge included), and
a repo mixing both styles head-by-head is the normal case.

## How it works

### The `[review]` config

Resolved from the usual layer stack (internal defaults -> `~/.config/hydra/
config.toml` -> `<root>/.hydra/config.toml` -> `<root>/.hydra/config.local.toml`),
parsed in `internal/config/review.go`. `config.local.toml` is the untracked
per-user-per-project layer: personal remote names, extra allowed hosts, a
`[review]` block for a repo whose committed config has none.

```toml
[review]
provider = "auto"               # auto | github | gitlab - auto detects from the remote URL
publisher = "forge"             # forge | graphite - Graphite publishes GitHub PRs
remote = "origin"
target_branch = "main"          # default MR target; per-head editable
auth = "cli"                    # cli (gh/glab, recommended) | token (NOT implemented)
default_action = "merge"        # merge | create_mr - which button leads; both stay available
push_branch_template = "{id}"   # e.g. "feat/{issue}-{id}" - {id}, {issue}, {base}
issue_pattern = "[A-Z]+-[0-9]+" # extracts an issue key from the prompt/title
draft = true                    # open MRs as draft
squash = true                   # request squash-on-merge
delete_remote_branch = true     # tell the forge to delete the source branch on merge
auto_push = true                # automatically push after an MR is linked (default)
# protected_branches = ["main"] # warn before a DIRECT LOCAL merge into these

```

Template placeholders collapse cleanly: a placeholder expanding to nothing eats
its adjacent separator (`-`, `_`, `/`) and empty path segments drop, so
`feat/{issue}-{id}` with no issue yields `feat/<id>`. There is deliberately no
`${x:-fallback}` syntax.

`issue_pattern` is tracker-neutral: the default covers Linear identifiers such
as `ENG-123` and Jira keys alike. Hydra adds an extracted key to the PR title
when it is not already present, so the forge-side tracker integration can link
it. The former `[jira].ticket_pattern` spelling and `{ticket}` placeholder remain
compatibility fallbacks.

### Graphite publishing and stacked heads

Graphite is a GitHub publication layer, not a forge provider. Use
`provider = "github"` (or auto-detection) with `publisher = "graphite"`. Hydra
then runs `gt branch track` and `gt submit` from the head worktree; PR status,
comments, and lifecycle still flow through GitHub and `gh`.

Hydra's existing stack edge is authoritative: a child whose `base_branch` is a
parent's `hydra/<id>` branch is tracked against that branch in Graphite.
Graphite mode uses the local `hydra/<id>` as the PR source branch because its
metadata is branch-keyed, so `push_branch_template` only affects the normal
forge publisher. When a parent lands, Hydra reparents local children to the
parent's base and updates their cached PR target while Graphite/GitHub handles
the corresponding remote retarget.

This requires Graphite CLI 1.8.4 or newer, `gt` authenticated and on the
daemon's PATH, `gt repo init` run for the repository, and automatic deletion of
merged GitHub head branches as recommended by Graphite.

Settings -> Review shows the *effective* values, where each came from, and live
auth status (`gh: logged in as X` / `glab: not authenticated`), and edits
`config.local.toml` or `config.toml` as the user chooses.

### Credentials: host-side only

Every forge call runs **host-side in the daemon** with the user's own
credentials - `gh`/`glab` for the API, the normal git credential helper /
ssh-agent for pushes. Nothing token-shaped is ever mounted into a sandbox:

- `~/.config/gh` and other forge credential locations remain masked even below
  a broader `readable_paths` entry. Raw CLI tokens are never available to a
  head.
- In-sandbox `git push` is gate-denied outright; publishing is a daemon action.
- `.hydra/deploy.toml` and `.hydra/config.local.toml` are shipped mask defaults,
  since Hydra's own tooling creates the first of them.
- Provider/remote/command resolution reads the **trusted root + local config
  only**, never the head's branch copy - a branch must not be able to
  reconfigure a credentialed host-side action.

Pushes run strictly non-interactively (`GIT_TERMINAL_PROMPT=0`,
`GIT_SSH_COMMAND="ssh -oBatchMode=yes"`), and a credential failure surfaces as
`*git.AuthError` with an actionable message rather than hanging the daemon. A
passphrase-protected key is `ssh-agent`'s job; Hydra never stores or prompts for
one.

No OAuth implementation lives in Hydra, and none should: the daemon is a
single-user local process acting as you, `gh`/`glab` do their own device-flow
OAuth, and real OAuth would only be needed if Hydra became a hosted multi-user
service acting as *each* reviewer - which contradicts its trust model.

### Publishing: the per-head MR link

`publishHead` (`internal/http/publish.go`) is the publish analog of
`performClaimedMerge`:

1. Claim the head (`idle -> publishing`).
2. `git push <remote> hydra/<id>:refs/heads/<downstream>` - the LOCAL branch is
   untouched, publish is a refspec push and nothing more.
3. `EnsureMR` creates the MR/PR if none exists (idempotent, so re-publishing is
   safe) and the link is stored on the head: `ReviewURL`, `ReviewID`,
   `ReviewProvider`, `ReviewTargetBranch`, `DownstreamBranch`.
4. **Nothing is deleted.** Worktree, branch and session all survive - review
   iteration is the normal case. The link is metadata.

Each head owns a **`downstream_branch`**: the name its work is pushed AS (the
local branch always stays `hydra/<id>`; teardown and branch listing rely on that
prefix). It is seeded from `push_branch_template` and editable inline
afterwards, but soft-locked once `ReviewID` is set - on both forges the source
branch IS the MR's identity, so renaming it orphans the MR.

**Bi-directional sync.** The remote branch is not write-only: reviewers apply
suggestions, colleagues push fixups, bots amend. Hydra tracks ahead/behind
between `hydra/<id>` and its upstream review ref and offers:

- **Push to MR** when local is ahead - plain push.
- **Pull from MR** when the remote is ahead - fetch, then *merge* (not rebase)
  into the head branch, so conflicts surface through the existing conflict UI
  and no history is rewritten. The agent needs no notification: its worktree IS
  the branch.
- **Close PR/MR** from the linked review button's menu. Hydra closes the review
  on the forge, detaches it from the head, and disables automatic pushing. The
  local and remote branches remain intact, and the downstream branch name is
  preserved for a later publish.
- Diverged -> pull first, then push. The only `--force-with-lease` case is a
  head that rewrote its own history where the remote tip still matches what this
  head last pushed; foreign commits always win a pull-first.

Ahead/behind is computed per request in `agentResponseWithReview` from the
**cached remote-tracking refs** - no fetch on the request path. `ahead` is
therefore exact (Hydra updates the ref itself on push), and `behind` is only as
current as the last fetch, which is why the review watcher kicks the same
throttled `maybeFetchRemote` the sidebar's push status uses (once per
project+remote per window, shared with it rather than doubling the traffic).
Without that, a reviewer's push stayed invisible until you happened to pull.

**Where sync state is surfaced.** All three places, because a commit that only
exists as a line inside a dropdown is a commit that sits there unnoticed:

- the **head's chip row** - `MRSyncChip` in `ReviewControls.tsx`, modelled on the
  sidebar's repository sync row: amber down-arrow + count, blue up-arrow + count,
  or a quiet "in sync". Each arrow is its own button (Pull / Push): unlike the
  sidebar's pull-then-push Sync, these are separate operations with different
  consequences, so one click must never mean both. Unmeasured (no downstream ref
  yet) renders nothing rather than claiming "in sync";
- the **publish button** - it leads with `Push to MR (N)` while the head is
  ahead and `View MR` otherwise. Whatever it doesn't lead with stays in the
  dropdown, so nothing is ever reachable only one way;
- the **sidebar row** - a forge glyph marking which heads have an MR at all, with
  an up-arrow count when unpushed commits exist. Native `title=` there, per the
  per-row rule in CLAUDE.md.

### Lifecycle watcher

`RunReviewWatcher` (`internal/http/review_watcher.go`) polls every MR-linked
head every 30s, across all projects (one `hydrad` serves them all, and each head
resolves its provider/remote from its OWN project root's config - never the
daemon's boot project's). Unlinked heads cost nothing. It:

- caches MR state on the head (state / CI / approvals / unresolved discussions /
  mergeability) for the UI chip;
- writes the per-head review file the agent's tools read;
- detects a remote merge -> fetch, fast-forward the local target branch, archive
  the head as `merged` and tear it down. Squash merges are handled because the
  truth is the **MR state, not git ancestry** (the ancestry scan cannot see a
  squash; do not try to make it);
- refreshes the remote-tracking refs (see the ahead/behind note above);
- automatically pushes an armed linked head after the agent has been finished
  for the usual dwell. This is a plain push with no local test gate and never an
  automatic force-push. For an adopted PR it is opt-in per PR, never implicit:
  the arm endpoint refuses one without `acknowledge_adopted=true`, and adoption
  skips the project-wide default entirely (docs/pr-adoption.md).

  The arm is **sticky**: it survives a successful publish or push, so an armed
  head keeps its MR in sync for the rest of its life. That is the point - the
  commit an agent makes *after* the MR opens is exactly the one that used to sit
  there. The linked-head menu labels the arm "Push automatically". It is consumed
  only on failure, so a push that can never succeed (bad credentials, a protected
  branch) cannot retry every 30s forever. A linked armed head with nothing to push
  is a no-op: one local rev-list per tick, no network.

  `[review] auto_push` defaults on and arms a head when Hydra creates
  its MR. It does not arm at spawn, so Hydra never creates an MR automatically.

  The per-head database fields follow the same naming. On startup, `db.Open`
  renames the previous auto-publish columns to `auto_push` / `auto_push_at`
  before GORM's `AutoMigrate` runs. The explicit pre-migration is idempotent and
  preserves the stored arm state; `AutoMigrate` alone cannot infer a column
  rename.

### Agent-facing review tools

The always-seeded `hydra` MCP server (`internal/cli/mcp.go` +
`internal/mcpserver`) exposes two review tools on a linked head:

- `get_review_status` - URL, target branch, state, CI, approvals, unresolved
  count.
- `get_review_comments` - the unresolved discussions with file/line context.

They do **not** serve the 30s watcher's cache. Each call first asks the daemon
to re-read the MR from the forge over `internal/reviewq` (a request/result file
channel with the same shape as the gate's approval channel and `gitq`;
`RunReviewRequestWatcher` answers on a 500ms cadence), then reads the review file
the daemon rewrote. A refresh that fails or times out is not fatal - the cached
snapshot comes back with the reason attached, so the agent never treats a stale
"no comments" as authoritative. Two calls within 5s share one forge round trip.

Why this rather than pointing heads at a generic forge MCP server: it is
**scoped by construction** (the channel identifies the head, so the answer only
ever concerns THAT head's MR, where a generic server hands over the user's whole
forge identity), and it needs **no new credentials**. A generic forge MCP server
remains the right answer when you deliberately want a head to have unscoped
forge access - allow it via `[policy] mcp_tools_allowed` and let the gate park
the writes.

The user-facing loop is agent-*pull*, not push: "Resolve with agent" on a thread
(and the head menu's "Respond to review comments") sends the head a short prompt
and the agent fetches the discussions itself, so the data is fresh when it reads
rather than when you clicked. A new unresolved discussion notifies the user;
there is deliberately no automatic prompting of the agent.

### Agent-facing self-status tools

Two more tools ride the same `reviewq` channel, and are wired for **every** head,
linked or not (`internal/http/head_status.go` renders them):

- `get_head_status` - each configured test runner's verdict for the head's branch
  tip with the failing cases **and their failure messages**, each artifact set's
  state, and the project's supervised services.
- `get_test_logs` - the tail of one runner's captured output (default 200 lines,
  cap 2000), named by runner.
- `retry_tests` / `retry_artifacts` - discard the cached verdict/output for
  the branch tip and start a fresh run. (They were `run_tests` /
  `generate_artifacts`; the dispatcher still accepts both old names, and the wire
  ops on the `reviewq` channel are still `run_tests` / `run_artifacts` - see the
  naming note below.)

They exist because an agent could run its own test command but could not see
**the thing that actually gates its merge**: the daemon's cached per-runner
report and `testGateVerdict`. `get_head_status` answers "am I green?" with the
same verdict the merge and publish gates check, against the branch tip - so it
deliberately excludes uncommitted work, since a verdict that disagreed with the
gate would be worse than no verdict.

Design notes worth keeping:

- **Reading never runs anything.** Every lookup is a `Peek`
  (`tests.Manager.Peek` / `PeekCases`, and a new `artifacts.Manager.Peek`), so a
  status call never starts a run or a generation - a status call that causes the
  thing it reports is a trap. Starting work is a separate, explicit tool.
- **It is `retry_tests`, not `run_tests`, and the name is the whole design.**
  Hydra runs a head's runners ITSELF whenever its branch tip moves
  (`RunTestPrefetch` in `internal/http/tests_prefetch.go`, on by default,
  `[tests] prefetch = false` to opt out), so "run my tests" is not something an
  agent ever needs to ask for. A tool called `run_tests` gets called exactly
  then - after a commit, by an agent that wants a verdict - and every one of
  those calls is a wasted turn that mostly no-ops anyway, because a runner that
  settled inside `runCooldown` is reported rather than repeated. Renaming was
  the fix, not deleting: see the next note for the job that is left, which is a
  real one. The old name still dispatches (a tool name gets quoted in
  `mcp_tools_allowed` lists and in project docs), and only `retry_tests` is
  advertised.
- **`retry_tests` exists because the agent cannot reproduce the gate.** Hydra's
  runner executes in a separate checkout with the project's real
  `[tests.<name>]` command, possibly `unsafe_host`, possibly needing egress the
  head does not have - so "make the gate re-evaluate" is genuinely not something
  a head can do with its own shell. So when a verdict is wrong rather than
  merely red - a flake, a run that died on something environmental - clearing it
  is the one thing an agent has no other route to, and merge-when-green gates on
  that verdict, so without this a flaky red wedges the head until a human clicks
  re-run. It invalidates the branch-tip entry and calls
  `Get`, which returns as soon as the run is queued: an agent must never hold a
  tool call open for a suite's runtime, so it polls `get_head_status` instead.
  This is the only place an agent spends the user's CPU, and it is bounded twice
  over - a run already in flight is reused rather than restarted (both managers'
  `Invalidate` no-op while generating), and one that settled inside
  `runCooldown` is reported rather than repeated, which is what stops a
  finish-then-immediately-rerun loop. `retry_artifacts` is the same shape in
  every respect, including the name: artifacts are generated per commit by the
  same kind of background sweep (`RunArtifactPrefetcher`, plus `PrefetchHeadNow`
  the moment a head goes to rest), so waiting is the answer there too - the queue
  is just slower, because a screenshot run costs more than a test run. Its payoff
  is a UI head whose set FAILED regenerating it and then reading the images.
- **Split, but the summary must stand alone.** The common call stays cheap and
  only a real failure pays for a log - yet a status that just said "FAILING" and
  pointed at another tool would make the split a tax, not a saving. So the
  failure messages are inlined with their cases, bounded three ways (8 lines and
  600 chars per message, 4000 chars across the answer) and kept multi-line, since
  an expected/actual diff flattened to one line is unreadable. When a runner
  fails with no case-level detail at all - a build that died before producing a
  report, an `exit`-format runner - the last 25 log lines stand in for it.
  `get_test_logs` is then for the surrounding output, not for the basics.
- **The daemon renders the text**, not the sandbox: it owns the state, so the
  wording lives next to the managers it describes and the in-sandbox side is a
  thin relay. Services state exists ONLY in daemon memory, so there is nothing in
  the sandbox to read even in principle - which is what settled the round-trip.
- **No previews.** Live server previews are a user-facing affordance with no
  diffable output, and a head cannot reach the preview port under hard egress
  anyway. `dropServerSpecs` keeps them out.

### Review threads in the diff viewer

The forge's unresolved threads are rendered inline in Hydra's diff viewer,
anchored to their file and line next to your own local review comments. See
[review-threads.md](review-threads.md) for the data flow, the origin badges
(forge vs local-only), replying, and the agent's local-only replies.

This reverses an earlier "no review UI inside Hydra" position. The distinction
that makes it worth it: Hydra is not trying to *be* a review UI (no approvals,
no file-tree review state, no submitting a review), it shows the threads where
the code is so the fix-and-answer loop does not need a browser round trip.
Approving, resolving and everything else still happen on the forge.

## Gotchas

- **One daemon, many projects.** Any background loop added here must iterate all
  project roots and read each head's own config; the boot project's config is
  not special.
- **CLI-first fragility.** `gh`/`glab` output formats drift; always pin to
  `--json` / `-F json` modes and parse defensively. A REST client is the
  eventual stable path.
- **Local tests vs remote CI.** Auto-push deliberately does not wait for local
  `[tests.<name>]` verdicts. The forge remains responsible for its own CI and
  protected-branch rules; Hydra surfaces both states but does not align them.
- **Hydra is personal at work.** The daemon acts as one user - you. Publishing
  uses your identity; this is not a shared service.
- **Rebase-heavy teams.** Hydra has no rebase support in this flow
  (update-from-base and Pull from MR are merges). Squash-on-merge defuses most
  of the objection; true rebase support is a separate, larger project.
- **Forks.** Handled for adopted PRs (push to the head repo's clone URL, see
  [pr-adoption.md](pr-adoption.md)); for outbound publishing, a
  `push_remote`/`target_repo` split is a known-shape extension, not built.

## Not built yet

- **Merge when approved.** `forge.Provider.Merge` and `MergeOptions{Auto}` exist
  with no callers; the only arm endpoint is the local-tests one. Wants an arm
  endpoint/UI plus a watcher branch that prefers the forge's own auto-merge
  (it respects merge trains and protected-branch rules Hydra cannot replicate).
- **Linked-head kill / local-merge close-or-detach dialog.** The review button
  can close a Hydra-created MR/PR while keeping the head and branches. Killing or
  locally merging a linked head still does nothing about the review or remote
  branch. Those flows should offer a close-or-detach choice, and locally merging
  a head whose review is open should be blocked-with-override like a failing
  test gate.
- **Fetch-fresh spawn base.** The spawn UI defaults to the repository's stable
  default branch (remote `origin/HEAD`, then `main`/`master`) rather than whichever
  incidental branch the project checkout currently has. There is still no
  fetch-before-spawn and no automatic `<remote>/<target>` base. This also
  caps how crisp an adopted PR's diff is.
- **Adopting a PR into an EXISTING head.** Today adoption happens only at spawn.
  Linking a running head to a PR is mostly a matter of fetching the pseudo-ref,
  writing the link columns, seeding the review file and *merging* the PR head in
  (never resetting - that would discard the head's own commits); the merge half
  already exists as Pull from MR. Worth doing for "I started work and then found
  there was already a PR", but it is not urgent.
- **Token/REST auth.** `auth = "token"` returns `NotConfiguredError`; forge
  access is CLI-only.
- **Spawn-from-issue depth.** Only the `{issue}` templating rung is wired. The
  ladder, in order, stopping when satisfied: (1) `{issue}` in branch
  names and MR titles - corporate JIRA<->forge integrations auto-link off this
  for free; (2) spawn-from-ticket fetch, REST or via MCP; (3) a "my open
  issues" picker in the spawn form; (4) skip transitions/comments/two-way sync
  entirely - server-side integrations already do that off MR events.
- **Notifications on MR events** (approval, CI failure, new comments).

## Deliberately not built

- **A full review UI.** Approvals, review submission and resolution stay on the
  forge; see the diff-viewer note above for exactly how far this goes.
- **A native JIRA client** beyond ticket-fetch and keys-in-names.
- **Merge trains / protected-branch semantics.** Delegate to the forge.
- **Git-credential handling inside the sandbox.** Publishing is host-side.

## Working without any of it

The manual route still works and needs no config: push the head branch yourself
(`git push origin hydra/<id>:feat/my-feature`), open the MR with `gh`/`glab`, and
keep the head alive for review iteration - its branch and worktree survive as
long as you do not merge or kill it. For head-side forge access, prefer a forge
MCP server with `[policy] mcp_tools_allowed` (the gate parks every non-allowed
call for approval, even under `--dangerously-skip-permissions`). JIRA reads are
the same story: an Atlassian MCP server plus the host on the network allow-list
is likely the permanently correct answer.

Direct local merge also remains the right tool for *local integration branches*:
merge several stacked heads into `integration/foo`, test the combination, and
publish that as one MR.
