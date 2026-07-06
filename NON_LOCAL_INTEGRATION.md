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
  `~/.netrc`, etc., the gate denies `git push` from Bash outright, and the
  Read tool is denied on credential paths. `~/.config/gh` *used to be*
  restored read-only by default - which quietly handed every head the
  user's GitHub identity (`gh auth token` from Bash is not gated, so the
  Read-tool deny was moot). That default is now removed
  (`internal/sandbox/defaults.go`); forge credentials in-sandbox are
  opt-in via `restore_ro`. The daemon itself runs host-side with full host
  credentials; `unsafe_host = true` on `[[tests]]`/`[[artifacts]]`
  (root-config-gated) is the existing precedent for a credentialed
  host-side action.
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
| Head archive states: `merged` / `killed` | Needs an MR-linked limbo (head alive, branch pushed) and a "merged remotely" terminal state |

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

### 2.2 Head-side forge access: gated MCP, not an ambient token

By default heads now have NO forge credentials: `~/.config/gh` is no longer
restored into the sandbox (an ambient token means any head can run
`gh auth token` and act as you with zero approval - Bash is not gated for
`gh`, only for `git push`). Two ways to give a head forge access, in order
of preference:

- **MCP with per-tool gating (recommended).** Configure a GitHub/GitLab MCP
  server and allow it via `[policy] mcp_tools_allowed`. The security gate
  already does exactly the right thing here (`internal/gate/decide.go`):
  allow-listed tools pass, `mcp_auto_allow_read` can wave through
  read-only tools, and every other tool call is PARKED for your approval -
  even under `--dangerously-skip-permissions`. So "head may read MRs and
  post a comment, but creating/merging an MR pings me" is expressible
  today with config only. Prefer an HTTP/hosted MCP server (token stays
  out of in-sandbox files) over a stdio one whose config rides into the
  sandbox.
- **Opt-in ambient CLI (`restore_ro = ["~/.config/gh"]`).** Simple and
  unrestricted: the head IS you on the forge, no approval step. Reasonable
  on a personal repo; at work, don't.

Either way a head still cannot `git push` (gate-denied + no SSH keys); you
can ask it to prepare branches/descriptions and do the push yourself, until
the daemon-side publish flow (Phase 2) exists.

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
combination, and publish that as one MR. The per-head MR link (3.3)
leaves direct merge completely untouched; the optional
`review.protected_branches` list (3.2) only adds a warning when a local
merge targets a branch the server would reject a push to anyway.

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
  follow template X"), setting `[review]` provider/remote on a repo whose
  committed config doesn't have it yet.
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

There is deliberately **no `mode` switch**: the MR link is per-head
(section 3.3), so this section only supplies defaults for the Create MR
dialog and tells Hydra how to talk to the forge.

```toml
[review]
# Forge provider. "auto" (the default) detects from the configured
# remote's URL: github.com (or a host known to gh's hosts.yml) -> github;
# gitlab.com (or a host known to glab) -> gitlab. Unresolvable self-hosted
# domain -> the Create MR button explains what to set. Set explicitly to
# skip detection.
provider = "auto"               # auto | github | gitlab
remote = "origin"
target_branch = "main"          # default MR target; per-head editable
# How Hydra talks to the forge: "cli" shells out to gh/glab on the host
# (recommended - they own auth, incl. self-hosted via their multi-host
# config); "token" uses the REST API with a token from the secrets file
# (section 3.1) or the HYDRA_FORGE_TOKEN env var. Never a token inline.
auth = "cli"                    # cli | token
# Optional: warn before a DIRECT LOCAL merge into these branches (they
# are protected on the server; the push would bounce anyway).
# protected_branches = ["main"]
# Default DOWNSTREAM branch name: what the head branch is pushed AS (the
# local branch stays hydra/<id>). This is only the template; each head
# carries its own editable downstream_branch seeded from it - see 3.3a.
# Placeholders: {id}, {ticket} (extracted from prompt/title, see [jira]),
# {base} (the head's base branch).
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

**Settings-page UI**: the web Settings page (which already hosts the
sandbox-policy editor) gains a Review section showing the *effective*
resolved values and where each came from: detected provider (+ the remote
URL it was detected from), remote, auth method and its live status
("gh: logged in as X" / "glab: not authenticated" / "token: present"),
with a test-connection button. Editing writes to `config.local.toml` (or
`config.toml` where the user chooses to share it).

### 3.3 The per-head MR link (Phase 2) - the heart of it

The head<->MR link is **optional and per-head** - there is no global
"review mode". Every head starts unlinked and behaves exactly as today
(direct local Merge stays available, unchanged); a **Create MR** button
establishes the link, after which the same spot shows **View MR** plus
sync affordances. A repo mixing both styles per head is the normal case,
not a mode switch.

Button lifecycle on the head page:

1. **Unlinked** (default): `Create MR` (next to Merge, not replacing it).
   Opens a dialog prefilled from config + the head: downstream branch
   name (3.3a), target branch, title/description (seeded from the head's
   task and commit log), draft toggle. Confirming runs the publish below.
2. **Linked**: the button becomes `View MR` (deep link to the forge) with
   an MR state chip (draft / open / CI / approvals / merged), plus,
   contextually:
   - `Push to MR` when the local head branch is ahead of the remote
     downstream branch;
   - `Pull from MR` when the remote is ahead (3.3b).

Daemon-side `performPublish` (parallel to `performClaimedMerge`):

1. Claim the head (`idle -> publishing`).
2. Run the local test gate (same `testGateVerdict`, same force override) -
   local tests act as a *pre-push* gate.
3. `git push <remote> hydra/<id>:refs/heads/<downstream>` - **host-side,
   by the daemon**, with the user's own credentials. The LOCAL branch is
   untouched: no rename, no rewrite, publish is a refspec push and
   nothing more. Plain push by default; `--force-with-lease` only in the
   one safe case spelled out in 3.3b.
4. Create the MR/PR if none exists (via `glab`/`gh` or REST), targeting
   the dialog's target branch; store the MR URL + IID on the head (new
   DB fields: `ReviewURL`, `ReviewID`, `DownstreamBranch`).
5. **Do not delete anything.** Worktree, branch, and session all
   survive - review iteration is the normal case. The link is metadata;
   the head's status lifecycle is unchanged (only the transient
   `publishing` claim is new).
6. Re-publish (`Push to MR`) is idempotent: push again, the MR follows.

#### 3.3a Per-head downstream branch name

Each head gets a **`downstream_branch`** field: the name its work is pushed
AS (the local branch always stays `hydra/<id>` - teardown and branch
listing rely on that prefix). Semantics:

- **Seeded, not fixed**: at spawn (or lazily at first publish) it is
  expanded from `review.push_branch_template` - `{id}`, `{ticket}`,
  `{base}` - but it is just a per-head string after that. Set it at spawn
  (`hydra spawn --downstream-branch ...`, spawn form field) or edit it
  later in the UI, exactly like the existing base-branch editor in
  `AgentDetail.tsx` (same pattern: a metadata-only field with an inline
  editor).
- **Empty template -> mirror**: with no template configured, the
  downstream name defaults to the local name (`hydra/<id>`), which is the
  degenerate local-ish behavior.
- **Soft-locked after first publish**: on GitLab/GitHub the source branch
  IS the MR's identity - renaming it orphans the MR (GitLab closes it;
  GitHub retargets at best). After `ReviewID` is set, editing
  `downstream_branch` warns and offers "push under new name and open a
  fresh MR (closes the old one)" rather than silently forking.
- **Collision handling**: publish fails cleanly if the downstream name
  exists on the remote and does not fast-forward from a previous publish
  of this head (someone else's branch) - never force-push a branch this
  head did not create.

#### 3.3b Bi-directional sync: Push to MR / Pull from MR

The remote downstream branch is not write-only: reviewers apply
suggestions in the forge UI, colleagues push fixups, bots amend commits.
So the link must sync both ways. Hydra tracks ahead/behind between local
`hydra/<id>` and `<remote>/<downstream>` (throttled background fetch -
same machinery as the existing behind-base count and `maybeFetchRemote`):

- **Local ahead** -> `Push to MR`: plain push (publish step 3 again).
- **Remote ahead** -> `Pull from MR`: fetch, then `git.Merge` of the
  remote-tracking ref INTO the head branch - deliberately the same
  merge-not-rebase semantics as the existing update-from-base button, so
  conflicts surface through the same conflict UI and nothing about the
  head's history is rewritten. The agent needs no special notification:
  its worktree IS the branch, so pulled commits are simply there on its
  next turn (at most, toast the user).
- **Diverged** -> `Pull from MR` first, then push. The ONLY
  force-with-lease case: the head rewrote its own history AND the remote
  tip still matches what this head last pushed (the lease enforces
  exactly this) - foreign commits on the remote always win a pull-first,
  never a force-push.

### 3.4 Authentication - does this need OAuth?

Short answer: **no OAuth implementation in Hydra.** Hydra's daemon is a
single-user, local process acting as you; every auth need is covered by
credentials you already provision once on the host:

- **`git push` (daemon-side)** uses your normal host git auth - SSH agent
  or credential helper - identically to the existing sidebar Push button,
  which already works today with zero Hydra auth code.
  - **Passphrase-protected SSH keys**: the answer is `ssh-agent` (or the
    OS keychain via `AddKeysToAgent`), NOT Hydra config. Hydra must never
    store or prompt for a key passphrase - there is no safe place for it
    and the ecosystem already solved this. The daemon inherits
    `SSH_AUTH_SOCK` from the CLI that auto-started it; the gotcha is a
    daemon started from a context without an agent (GUI launch, after
    reboot with the socket stale). So publish/push must run strictly
    non-interactively (`GIT_TERMINAL_PROMPT=0`, `GIT_SSH_COMMAND="ssh
    -oBatchMode=yes"` - the existing `git.Fetch` already sets the former,
    `git.Push` should too) and map the failure to an actionable error in
    the UI: "push auth failed - add your key to ssh-agent (`ssh-add`) or
    switch to HTTPS + credential helper", rather than hanging or a raw
    git stderr. If the agent socket needs pinning on odd setups, a
    NON-secret pointer like `ssh_auth_sock` or a `ssh_command` override
    is a legitimate `config.local.toml` entry - the *passphrase itself
    never is*.
- **MR creation via `gh`/`glab` (CLI-first)**: these CLIs implement OAuth
  *themselves* (device flow). You run `gh auth login` /
  `glab auth login --hostname gitlab.mycorp.com` once on the host; the
  daemon just shells out and inherits working auth. Self-hosted GitLab and
  GHE are handled by the CLIs' multi-host config.
- **REST fallback (no CLI available)**: a personal access token - on
  corporate GitLab typically a project/group access token with `api`
  scope - stored in the uncommitted 0600 secrets file
  (`deploy.toml` precedent, section 3.1) or read from an env var. PATs
  are the workplace norm; no OAuth dance needed.
- **JIRA**: cloud = API token (basic auth email+token); server/DC = PAT.
  If you go the MCP route instead, Atlassian's hosted MCP server does its
  OAuth in the MCP client, not in Hydra.
- **When WOULD real OAuth be needed?** Only if Hydra became a hosted,
  multi-user service that must act as *each* reviewer (OAuth app
  registration, redirect URI, refresh tokens). That contradicts Hydra's
  one-daemon-one-user trust model and is explicitly out of scope; the doc
  notes it only so nobody reinvents it by accident.

Placement rule regardless of method: tokens live **host-side only**
(CLI credential stores or the 0600 secrets file). Nothing under
`.hydra/config*.toml` ever holds a secret, and nothing token-bearing is
mounted into a sandbox by default (section 2.2).

**Masking the project-level secret files from heads** - a gap that exists
TODAY: sandbox masks are home-relative (`~/.ssh`, `~/.config`, ...,
`internal/sandbox/defaults.go`), but heads also get read access to the
host, including the project root - and `.hydra/deploy.toml` (which
already holds the web `AuthKey` + ngrok config) is not masked. Fix as
part of Phase 1: when building a head's sandbox options, always append
project-relative masks for `.hydra/deploy.toml` and any future secrets
file (`integrations.toml`), plus `.hydra/config.local.toml` (not secret
by rule, but personal - a head has no business reading another layer's
overrides, and masking it keeps the temptation to put a token there
inert). These cannot live in the static defaults list (the project root
varies per project), so they are appended at spawn/resume where the
options are resolved (`internal/heads/heads.go` around
`ResolveSandboxOptions`). The gate's `credentialRels` deny-list gets the
same entries as defense in depth.

Why daemon-side and not in-sandbox: credentials never enter the sandbox,
the audit trail is "the user's daemon pushed", and it works for every agent
type including bash heads. This follows the `unsafe_host` trust precedent:
a *branch* must not be able to reconfigure the publish action into running
arbitrary credentialed commands, so provider/remote/command resolution
reads from the trusted root + local config only, never the head's branch
copy.

### 3.5 MR lifecycle tracking (Phase 3)

A watcher (sibling of `RunAutoMergeWatcher`) polls each MR-linked head's
MR via the forge API (unlinked heads cost nothing):

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
  optionally automatic: new unresolved discussion on an idle MR-linked
  head -> notify, or (opt-in) auto-prompt.

### 3.6 Spawn-side changes (Phase 3)

- **Fetch-fresh base**: when a review provider is configured, default
  spawn base to `<remote>/<target_branch>` after a (throttled) fetch,
  instead of the local checkout. Keeps every head based on the real trunk
  regardless of local checkout drift. `maybeFetchRemote` throttling
  already exists to build on.
- **"Update from base" learns about the remote**: for heads based on a
  remote-tracking ref, the behind-count and update-from-base button
  compare against it.
- **Spawn-from-ticket** (with `[jira]` or MCP): paste `PROJ-1234`, Hydra
  (or the agent, via MCP) pulls summary/description into the prompt, and
  `{ticket}` feeds the push-branch template and MR title
  (`PROJ-1234: <title>` - which is usually all the "JIRA integration" a
  team actually needs, since forge-JIRA linking does the rest).

### 3.7 What NOT to build

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
4. Press **Create MR** - dialog prefilled (branch
   `feat/PROJ-1234-rate-limit`, target `main`, title, draft), confirm:
   branch pushed, draft MR opened, the button becomes **View MR** with a
   state chip. You keep working on other heads.
5. Reviewer comments; one applies a suggestion in the GitLab UI. Hydra
   shows "2 unresolved discussions" and "remote ahead by 1" - one click
   feeds the comments to the agent, one click pulls the suggestion commit
   into the head, `Push to MR` sends the fixes back.
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
- Add corporate hosts to the network allow-list; set up JIRA/forge MCP
  servers with per-tool allow-lists (section 2.2/2.3). Only grant
  `restore_ro` forge-CLI configs where you accept the head acting as you.

### Phase 1 - config groundwork (small)

- `config.local.toml` as a fourth merge layer in `config.Load`
  (`internal/config/config.go:1004`); gitignore it next to `deploy.toml`;
  include it in the `unsafe_host` trusted-set derivation.
- **Mask project-level secret/personal files from head sandboxes**
  (pre-existing gap, see 3.4): append project-relative masks for
  `.hydra/deploy.toml`, the future secrets file, and
  `.hydra/config.local.toml` where sandbox options are resolved; mirror
  them in the gate's `credentialRels`.
- Add the `[review]` + `[jira]` sections (parsing + validation only),
  including provider auto-detection from the remote URL.
- Forge credentials stay OUT of sandbox defaults (done: `~/.config/gh`
  removed from `RestoreRO` in `internal/sandbox/defaults.go` +
  `profiles/sandbox.sb`; `glab-cli` config was never in). Document the
  two opt-in routes instead: per-project `restore_ro`, or MCP with
  per-tool gating (section 2.2).
- Settings UI: surface which layer each effective value came from (this
  becomes important once four layers exist).

### Phase 2 - publish (the core feature)

- DB: head fields `ReviewURL`, `ReviewID`, `DownstreamBranch`; head
  status `publishing`; archive end state for remote merges. Downstream
  branch: template expansion at spawn, inline editor in the UI
  (base-branch-editor pattern), soft-lock after first publish (3.3a).
- `internal/forge`: a small provider interface -
  `EnsureMR(branch, target, opts) (url, id)`, `MRStatus(id)`, `Merge(id)`,
  `Discussions(id)` - with `gitlab` and `github` implementations
  (CLI-first: shell out to `glab`/`gh`; REST fallback later).
- `performPublish` in `internal/http` (claim, local test gate, host-side
  non-interactive push with actionable auth errors, EnsureMR, store the
  link).
- API + web: Create MR dialog -> View MR + state chip, `Push to MR` /
  `Pull from MR` buttons with ahead/behind tracking (3.3b), optional
  `protected_branches` warning on direct local merge.
- Settings page: Review section with detected provider, auth status,
  test-connection (3.2).

### Phase 3 - lifecycle automation

- MR watcher: poll MR-linked heads; surface CI/approval state; detect
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
- **Killing or locally merging a head with an open MR**: the remote
  branch and MR outlive the head (they live on the server), but nothing
  would track them afterwards. Kill/merge on an MR-linked head should
  warn and offer: close the MR + delete the remote branch, or detach and
  leave them be. Never silently either.
- **Stacked heads -> stacked MRs**: a child head's natural MR target is
  its parent's *downstream* branch, and the merge-close reparenting
  (`AgentsByBaseBranch` retarget) has a remote analog (retarget the MR
  when the parent's MR merges). Forges handle stacked MRs poorly in
  general; punt beyond "target the parent's downstream branch" until real
  demand.
- **Forks / multiple remotes**: GitHub-style fork PRs need push-to-fork
  with MR-targets-upstream (`push remote != MR repo`). `review.remote`
  covers the simple case; a `push_remote`/`target_repo` split is a
  known-shape extension, not designed here.
- **Local tests vs remote CI drift**: the pre-push gate uses local
  `[[tests]]`; the forge gate uses CI. Keeping them aligned is a config
  discipline problem Hydra can't solve, only surface (show both states
  side by side on the head).
- **Rebase-heavy teams**: Hydra has no rebase support at all
  (update-from-base is a merge into the head branch). Squash-on-merge
  hides messy history from `main`, which defuses most objections; true
  rebase support is a separate, larger project - explicitly out of scope
  here.
