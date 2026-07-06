# Non-Local Integration Plan

Hydra today is built around a *local trunk* model: a head's work is landed by a
plain local `git merge` into its base branch, after which the `hydra/<id>`
branch and worktree are deleted. That is exactly wrong for a work environment
where the unit of landing is a **merge request / pull request**: the branch
must be *pushed*, reviewed, approved, CI-checked, and merged **on the server**
(often squashed), and only then does the change reach the trunk - which you
then *pull*, not produce.

This document maps where Hydra stands, what you can already do with zero code
changes, what should be built, and a phased plan for building it.

---

## 1. Where Hydra stands today (facts)

The merge/lifecycle path, end to end:

- **Merge is a local git merge.** `hydra merge` / the web Merge button call
  `POST .../agents/{id}/merge`, which claims the head (`idle -> merging`),
  runs the local test gate, and calls `performClaimedMerge`
  (`internal/http/handlers.go:1510`). That resolves a checkout of
  `head.BaseBranch` and runs `git.Merge` (`internal/git/merge.go:36`):
  `--ff-only` when possible, else a `--no-ff` merge commit. No squash, no
  push, no remote involvement of any kind.
- **The branch dies on merge.** The close path reparents stacked children,
  then `heads.KillHeadNoLock(..., "merged")` removes the worktree and deletes
  the branch (only `hydra/*` branches are eligible for deletion,
  `internal/heads/heads.go:1180`).
- **Merge-when-green is local too.** `RunAutoMergeWatcher`
  (`internal/http/tests.go:461`) polls armed heads every 5s and merges when
  the branch's `[[tests]]` are green and the agent has been `finished` for
  10s. The gate is Hydra's own test runners, not any remote CI.
- **The only remote interaction is "repository sync".** `git.Push/Fetch/Pull`
  (`internal/git/push.go`) push/pull the *project root's own branch* to its
  remote, driven by the sidebar Push/Sync button
  (`internal/http/repository.go`). Head merges never touch it. So even after
  a successful local merge, nothing reaches the server until you press Sync.
- **Base branch = whatever the project root has checked out.**
  `SpawnHead` defaults `BaseBranch` to `git.GetCurrentBranch(projectRoot)`
  (`internal/heads/heads.go:385`). There is no `origin/HEAD` detection and no
  fetch-before-spawn, so a stale local trunk silently produces heads based on
  old code.
- **No forge or tracker code exists.** Case-insensitive grep for
  GitHub/GitLab/PR/MR/JIRA finds only network allow-list hosts
  (`github.com`, `*.github.com`, `gitlab.com`, `*.gitlab.com`) and the
  read-only re-exposure of `~/.config/gh` inside the sandbox
  (`internal/sandbox/defaults.go:62-66`). Everything below is greenfield.
- **Credentials:** the sandbox masks `~/.ssh`, `~/.git-credentials`,
  `~/.netrc`, etc. - a head cannot `git push` over SSH. But the `gh` CLI's
  token IS readable (read-only) in-sandbox, and the daemon itself runs
  host-side with full host credentials. `unsafe_host = true` on
  `[[tests]]`/`[[artifacts]]` (root-config-gated) is the existing precedent
  for a credentialed host-side action.
- **Config layering:** internal defaults -> `~/.config/hydra/config.toml`
  (user/machine) -> `<root>/.hydra/config.toml` (project, committed), merged
  in `config.Load` (`internal/config/config.go:1004`). There is **no
  untracked per-project override** ("config.local.toml") today. The closest
  precedent is `.hydra/deploy.toml` (`internal/config/deploy.go`): an
  uncommitted, gitignored, 0600 per-machine secrets file.

### The mismatches, stated plainly

| Local-trunk assumption | MR-workflow reality |
|---|---|
| Landing = local merge into base | Landing = server-side MR merge (often squash), local merge to trunk is forbidden by branch protection |
| Branch deleted immediately on merge | Branch must outlive the head: pushed, reviewed, iterated on |
| "Green" = Hydra's local `[[tests]]` | "Green" = remote CI + required approvals |
| `hydra/<id>` branch names | Team naming conventions, often `feat/JIRA-123-...` |
| Base = local checkout, no fetch | Base must track `origin/<trunk>`, freshly fetched |
| Merge detection = local merge commit / ancestor check | Squash merges leave no ancestry; truth lives in the MR state |
| Head archive states: `merged` / `killed` | Needs an `in_review` limbo and a "merged remotely" terminal state |

---

## 2. What you can do TODAY (zero code changes)

You can run Hydra at work right now with a manual publish step. None of this
requires touching Hydra's source.

### 2.1 The manual-publish workflow

1. **Point the allow-list at your forge.** Add your corporate hosts to
   `[sandbox.network] allowed_hosts` in `.hydra/config.toml` (or, to keep it
   out of the shared repo, in `~/.config/hydra/config.toml` - host lists
   union across layers): `gitlab.mycorp.com`, JIRA host, artifact registry,
   etc.
2. **Keep the project root on a fresh trunk.** `git fetch && git pull` (or
   the sidebar Sync button) before spawning, so heads are based on current
   `main`. This is a discipline item until Phase 3 automates it.
3. **Spawn and iterate as usual.** Local `[[tests]]` still give you the fast
   pre-review signal - that value carries over unchanged.
4. **Publish manually instead of merging.** When the head is done, do NOT
   press Merge. From the host (your own terminal, with your creds):

   ```bash
   git push origin hydra/<id>:feat/my-feature
   glab mr create --source-branch feat/my-feature --target-branch main ...
   # or: gh pr create --head feat/my-feature ...
   ```

   The head's branch and worktree survive as long as you don't merge/kill,
   so review iteration works: prompt the agent with reviewer comments, it
   commits, you push again.
5. **After the MR merges remotely:** pull trunk at the project root, then
   `hydra kill <id>` (the local branch is now redundant; the code arrived
   via the remote merge). The head is archived as `killed` rather than
   `merged` - cosmetic inaccuracy, fixed in Phase 3.

### 2.2 Let the agent do the forge legwork

Because `~/.config/gh` is restored read-only in the sandbox and
`github.com`/`gitlab.com` are on the default allow-list, a Claude head can
already run `gh pr create`, `gh pr view --comments`, `gh pr checks` itself.
Caveats:

- It still cannot `git push` (SSH keys and git credentials are masked) - but
  `gh` can push over HTTPS with its token, and you can also ask the agent to
  prepare everything and do the push yourself.
- For GitLab, `glab` config (`~/.config/glab-cli`) is NOT restored today;
  until Phase 1 adds it, add it yourself via `[claude.sandbox] restore_ro`.
- Pushing from inside a head means the *agent's* token acts on your forge.
  At work, think before granting this; the daemon-side publish flow
  (Phase 2) is the better trust model.

### 2.3 JIRA via MCP, today

You do not need native JIRA code to get JIRA context into heads. Configure
an Atlassian/JIRA MCP server on the host, allow it with
`[policy] mcp_allowed`, and allow the JIRA host in the network config. Then
"implement PROJ-1234" in a spawn prompt lets the agent pull the ticket
itself. This is likely *permanently* the right call for read-side JIRA
(reading tickets, searching); only write-side conventions (transitions,
branch naming) justify native support.

### 2.4 Use local merges for what they are still good at

The direct-merge flow remains correct for *local integration branches*:
merge several stacked heads into a local `integration/foo`, test the
combination, and publish that as one MR. Review-mode (Phase 2) should
restrict direct merge to non-protected targets rather than remove it.

---

## 3. What SHOULD be built

### 3.1 Config: `config.local.toml` + secrets (Phase 1)

Two distinct needs, two files - mirroring the existing split between
committed config and `deploy.toml`:

- **`.hydra/config.local.toml`** - untracked (gitignored alongside
  `deploy.toml`), non-secret, per-user-per-project overrides. Loaded as a
  fourth merge layer in `config.Load`: defaults -> user -> project ->
  **project-local**. Same schema as `config.toml`, same union/last-wins
  merge semantics. Use cases: your personal remote name, extra allowed
  hosts, a personal `pre_prompt` addition ("our team's MR descriptions
  follow template X"), enabling review mode on a repo whose committed
  config doesn't have it yet.
  - Trust note: this file is on the *host*, editable only by the user, so
    it is as trusted as the root config. It participates in the
    `unsafe_host` trusted-set the same way the root config does.
- **Secrets stay out of both.** Forge/JIRA tokens go into either
  `.hydra/deploy.toml`-style storage (0600, never committed - either extend
  `DeployConfig` or add a sibling `integrations.toml`) or, better, are not
  stored by Hydra at all: shell out to `gh` / `glab` and let their own
  credential stores handle it. Recommendation: **CLI-first** (`gh`/`glab`
  on the host, invoked by the daemon), token-in-file only as fallback for
  forges without a good CLI.

### 3.2 A `[review]` config section (Phase 1-2)

```toml
[review]
# "direct" (today's behavior) | "mr" (publish flow replaces direct merge)
mode = "mr"
provider = "gitlab"            # gitlab | github (extensible)
remote = "origin"
target_branch = "main"          # MR target; also the spawn-base default
# Branch name used when pushing (head branch stays hydra/<id> locally).
# Placeholders: {id}, {ticket} (extracted from prompt/title, see [jira])
push_branch_template = "feat/{ticket}-{id}"
draft = true                    # open MRs as draft by default
squash = true                   # request squash-on-merge
delete_remote_branch = true     # tell the forge to delete on merge
# Gate the Publish action on local [[tests]] like merge is gated today
require_local_tests = true

[jira]
url = "https://mycorp.atlassian.net"
# Regex to pull a ticket key out of the spawn prompt / branch
ticket_pattern = "[A-Z]+-[0-9]+"
```

Committed parts (provider, target, templates - team conventions) live in
`config.toml`; personal deviations in `config.local.toml`; nothing secret in
either. Follow the existing nil-means-default pointer-field convention.

### 3.3 The Publish flow (Phase 2) - the heart of it

A new head action, **Publish**, sitting exactly where Merge sits today
(same CAS claim, same UI position; in review mode the primary button
becomes Publish and direct Merge moves behind an explicit
"merge locally" affordance, disabled for the protected target).

Daemon-side (`performPublish`, parallel to `performClaimedMerge`):

1. Claim the head (`idle -> publishing`).
2. Run the local test gate (same `testGateVerdict`, same force override) -
   local tests become a *pre-push* gate instead of a pre-merge gate.
3. `git push <remote> hydra/<id>:refs/heads/<push_branch>` - **host-side,
   by the daemon**, with the user's own credentials. Force-with-lease on
   re-publish.
4. Create the MR/PR if none exists (via `glab`/`gh` or REST), targeting
   `review.target_branch`; title/description seeded from the head's task
   and commit log; store the MR URL + IID on the head (new DB fields:
   `ReviewURL`, `ReviewID`, `PushBranch`).
5. Head status -> `in_review`. **Do not delete anything.** Worktree,
   branch, and session all survive - review iteration is the normal case.
6. Re-publish is idempotent: push again, the existing MR updates.

UI: the head card/page shows an MR chip (state: draft/open/approved/
CI-red/merged) linking to the forge. The agent header's merge button
becomes a split Publish button ("Publish", "Publish as ready", "Merge
locally...").

Why daemon-side and not in-sandbox: credentials never enter the sandbox,
the audit trail is "the user's daemon pushed", and it works for every agent
type including bash heads. This follows the `unsafe_host` trust precedent:
a *branch* must not be able to reconfigure the publish action into running
arbitrary credentialed commands, so provider/remote/command resolution
reads from the trusted root + local config only, never the head's branch
copy.

### 3.4 MR lifecycle tracking (Phase 3)

A watcher (sibling of `RunAutoMergeWatcher`) polls each `in_review` head's
MR via the forge API:

- **Status surfaced in UI**: CI pipeline state, approval count, unresolved
  discussion count, mergeability. The sidebar chip gains an MR state.
- **"Merge when approved"** - the remote analog of merge-when-green: arm a
  head so that when the forge reports approvals satisfied + CI green,
  Hydra calls the forge's merge API (or just enables the forge's own
  auto-merge/MWPS and lets the server do it - **prefer delegating to the
  forge's auto-merge where available**, it respects merge trains and
  protected-branch rules Hydra can't replicate).
- **Remote-merge detection and cleanup**: when the MR reports `merged`,
  fetch, fast-forward the local target branch (reusing `git.Pull`
  machinery), then archive the head with a new end state
  (`merged_remote` or reuse `merged`) via the existing teardown - now safe
  because the code has landed. Squash merges are handled correctly because
  the truth is the **MR state, not git ancestry** (the existing
  `MergedHydraBranches` ancestry scan cannot see squashes; do not try to
  make it).
- **Review-comment loop** (the big quality-of-life win): a "Fetch review
  comments" action that pulls unresolved MR discussions and feeds them to
  the head as a new prompt ("Address this review feedback: ..."). Later,
  optionally automatic: new unresolved discussion on an idle `in_review`
  head -> notify, or (opt-in) auto-prompt.

### 3.5 Spawn-side changes (Phase 3)

- **Fetch-fresh base**: in review mode, default spawn base to
  `<remote>/<target_branch>` after a (throttled) fetch, instead of the
  local checkout. Keeps every head based on the real trunk regardless of
  local checkout drift. `maybeFetchRemote` throttling already exists to
  build on.
- **"Update from base" learns about the remote**: the behind-count and
  update-from-base button compare against the remote-tracking ref in
  review mode.
- **Spawn-from-ticket** (with `[jira]` or MCP): paste `PROJ-1234`, Hydra
  (or the agent, via MCP) pulls summary/description into the prompt, and
  `{ticket}` feeds the push-branch template and MR title
  (`PROJ-1234: <title>` - which is usually all the "JIRA integration" a
  team actually needs, since forge-JIRA linking does the rest).

### 3.6 What NOT to build

- **No review UI inside Hydra.** Reviews happen on the forge; Hydra links
  out. Replicating comment threads is a tarpit.
- **No native JIRA client beyond ticket-fetch + key-in-names.** MCP covers
  the read side; forge integration covers linking; smart commits cover
  transitions.
- **No re-implementation of merge trains / protected-branch semantics.**
  Delegate to the forge's merge API and auto-merge.
- **No git-credential handling inside the sandbox.** Publishing stays a
  host-side daemon action.

---

## 4. The target workflow (day in the life, after Phase 3)

1. `hydra spawn "PROJ-1234: rate-limit the webhook endpoint"` - base is a
   fresh `origin/main`; the ticket body is in the prompt context.
2. Head works; local `[[tests]]` run continuously as today.
3. You skim the diff in the Hydra UI, maybe iterate.
4. Press **Publish** - branch pushed as `feat/PROJ-1234-rate-limit`,
   draft MR opened, head enters `in_review`. You keep working on other
   heads.
5. Reviewer comments. Hydra surfaces "2 unresolved discussions" - one
   click feeds them to the agent, it pushes fixes, MR updates.
6. You arm **merge when approved**. CI goes green, approval lands, the
   forge merges (squash), branch auto-deleted remotely.
7. Hydra notices the MR merged: fetches, fast-forwards local `main`,
   archives the head as merged, cleans worktree + local branch.

Steps 4-7 are today: manual push, manual MR, manual polling, manual
kill + pull. The plan converts each into one Hydra affordance without
changing steps 1-3 at all.

---

## 5. Phased implementation plan

### Phase 0 - no code (do now)

- Document the manual-publish workflow (section 2.1) in the README.
- Add corporate hosts to the network allow-list; add `~/.config/glab-cli`
  to `restore_ro` where wanted; set up a JIRA MCP server.

### Phase 1 - config groundwork (small)

- `config.local.toml` as a fourth merge layer in `config.Load`
  (`internal/config/config.go:1004`); gitignore it next to `deploy.toml`;
  include it in the `unsafe_host` trusted-set derivation.
- Add the `[review]` + `[jira]` sections (parsing + validation only).
- Add `~/.config/glab-cli` to `RestoreRO` defaults
  (`internal/sandbox/defaults.go`).
- Settings UI: surface which layer each effective value came from (this
  becomes important once four layers exist).

### Phase 2 - publish (the core feature)

- DB: head fields `ReviewURL`, `ReviewID`, `PushBranch`; head status
  `publishing`; archive end state for remote merges.
- `internal/forge`: a small provider interface -
  `EnsureMR(branch, target, opts) (url, id)`, `MRStatus(id)`, `Merge(id)`,
  `Discussions(id)` - with `gitlab` and `github` implementations
  (CLI-first: shell out to `glab`/`gh`; REST fallback later).
- `performPublish` in `internal/http` (claim, local test gate, host-side
  push, EnsureMR, status -> `in_review`).
- API + web: Publish button/split-menu, MR chip, review-mode gating of the
  direct Merge action against the protected target.

### Phase 3 - lifecycle automation

- MR watcher: poll `in_review` heads; surface CI/approval state; detect
  remote merge -> fetch, ff local target, archive + teardown.
- "Merge when approved" (prefer arming the forge's own auto-merge).
- Fetch-fresh spawn base (`<remote>/<target>`); remote-aware behind-count
  and update-from-base.
- "Fetch review comments -> prompt agent" action.

### Phase 4 - polish / tracker depth

- Spawn-from-ticket (JIRA fetch or MCP-assisted), `{ticket}` templating
  end-to-end, MR title conventions.
- Notifications on MR events (approval, CI fail, new comments).
- Optional: self-hosted GitLab/GHE base-URL support in the provider
  config (mostly free via `glab`/`gh` host config).

---

## 6. Open questions / risks

- **Branch naming vs teardown**: local branches stay `hydra/<id>` (teardown
  at `internal/heads/heads.go:1180` only deletes `hydra/*`); only the
  *push* refspec is renamed. If teams demand renamed local branches too,
  teardown eligibility needs rethinking - avoid unless forced.
- **Multi-user forges, single-user Hydra**: Hydra's daemon acts as one
  user (you). Publishing uses *your* identity; that matches the sandbox
  trust story but means Hydra is a personal tool at work, not a shared
  service. Fine - but say so explicitly in docs.
- **CLI-first fragility**: `glab`/`gh` output formats change; pin to
  `--json`/`-F json` output modes. REST clients are the eventual stable
  path.
- **Force-push semantics on re-publish**: `--force-with-lease` is right,
  but interacts with reviewers' local checkouts; consider making re-publish
  append-only (plain push) unless the head's history was rewritten.
- **Local tests vs remote CI drift**: the pre-push gate uses local
  `[[tests]]`; the forge gate uses CI. Keeping them aligned is a config
  discipline problem Hydra can't solve, only surface (show both states
  side by side on the head).
- **Rebase-heavy teams**: Hydra has no rebase support at all
  (update-from-base is a merge into the head branch). Squash-on-merge
  hides messy history from `main`, which defuses most objections; true
  rebase support is a separate, larger project - explicitly out of scope
  here.
