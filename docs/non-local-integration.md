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
remote = "origin"
target_branch = "main"          # default MR target; per-head editable
auth = "cli"                    # cli (gh/glab, recommended) | token (NOT implemented)
default_action = "merge"        # merge | create_mr - which button leads; both stay available
push_branch_template = "{id}"   # e.g. "feat/{ticket}-{id}" - {id}, {ticket}, {base}
draft = true                    # open MRs as draft
squash = true                   # request squash-on-merge
delete_remote_branch = true     # tell the forge to delete the source branch on merge
require_local_tests = true      # gate Publish on local tests, like Merge
# publish_when_green = true     # arm new heads to auto-open a draft MR once green
# protected_branches = ["main"] # warn before a DIRECT LOCAL merge into these

[jira]
url = "https://mycorp.atlassian.net"
ticket_pattern = "[A-Z]+-[0-9]+"   # pulls {ticket} out of the prompt/title
```

Template placeholders collapse cleanly: a placeholder expanding to nothing eats
its adjacent separator (`-`, `_`, `/`) and empty path segments drop, so
`feat/{ticket}-{id}` with no ticket yields `feat/<id>`. There is deliberately no
`${x:-fallback}` syntax.

Settings -> Review shows the *effective* values, where each came from, and live
auth status (`gh: logged in as X` / `glab: not authenticated`), and edits
`config.local.toml` or `config.toml` as the user chooses.

### Credentials: host-side only

Every forge call runs **host-side in the daemon** with the user's own
credentials - `gh`/`glab` for the API, the normal git credential helper /
ssh-agent for pushes. Nothing token-shaped is ever mounted into a sandbox:

- `~/.config/gh` is NOT restored into the sandbox (it once was, which quietly
  handed every head the user's GitHub identity - `gh auth token` from Bash is
  not gated). Forge credentials in-sandbox are opt-in via `restore_ro`.
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
2. Run the local test gate (same verdict logic as merge; `force` overrides).
3. `git push <remote> hydra/<id>:refs/heads/<downstream>` - the LOCAL branch is
   untouched, publish is a refspec push and nothing more.
4. `EnsureMR` creates the MR/PR if none exists (idempotent, so re-publishing is
   safe) and the link is stored on the head: `ReviewURL`, `ReviewID`,
   `ReviewProvider`, `ReviewTargetBranch`, `DownstreamBranch`.
5. **Nothing is deleted.** Worktree, branch and session all survive - review
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
- Diverged -> pull first, then push. The only `--force-with-lease` case is a
  head that rewrote its own history where the remote tip still matches what this
  head last pushed; foreign commits always win a pull-first.

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
- auto-publishes armed **publish-when-green** heads once local tests pass and
  the agent has been finished for the usual dwell - unlinked heads open a DRAFT
  MR, linked heads plain-push. Never for an adopted PR (pushing into someone
  else's PR must be deliberate).

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
- **Local tests vs remote CI drift.** The pre-push gate is local
  `[tests.<name>]`; the forge gate is CI. Hydra can only surface both, not
  align them.
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
- **Linked-head kill / local-merge close-or-detach dialog.** Killing or locally
  merging a head with a linked MR currently does nothing about the MR or the
  remote branch. It should offer "close the MR and delete the remote branch" or
  "detach - leave it open", and locally merging a head whose MR is open should
  be blocked-with-override like a failing test gate.
- **Fetch-fresh spawn base.** `SpawnHead` still defaults to the project root's
  current branch: no fetch-before-spawn, no `<remote>/<target>` base. This also
  caps how crisp an adopted PR's diff is.
- **Adopting a PR into an EXISTING head.** Today adoption happens only at spawn.
  Linking a running head to a PR is mostly a matter of fetching the pseudo-ref,
  writing the link columns, seeding the review file and *merging* the PR head in
  (never resetting - that would discard the head's own commits); the merge half
  already exists as Pull from MR. Worth doing for "I started work and then found
  there was already a PR", but it is not urgent.
- **Stacked-MR retargeting.** When a parent MR merges, the child MR is not
  retargeted at trunk.
- **Token/REST auth.** `auth = "token"` returns `NotConfiguredError`; forge
  access is CLI-only.
- **Spawn-from-ticket / JIRA depth.** Only the `{ticket}` templating rung is
  wired. The ladder, in order, stopping when satisfied: (1) `{ticket}` in branch
  names and MR titles - corporate JIRA<->forge integrations auto-link off this
  for free; (2) spawn-from-ticket fetch, REST or via MCP; (3) a "my open
  tickets" picker in the spawn form; (4) skip transitions/comments/two-way sync
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
call for approval, even under `--dangerously-skip-permissions`) over
`restore_ro = ["~/.config/gh"]`, which makes the head *you* on the forge with no
approval step. JIRA reads are the same story: an Atlassian MCP server plus the
host on the network allow-list is likely the permanently correct answer.

Direct local merge also remains the right tool for *local integration branches*:
merge several stacked heads into `integration/foo`, test the combination, and
publish that as one MR.
