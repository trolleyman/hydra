# Big Items

Large functionality gaps identified from a survey of the current feature surface
(CLI, web UI, API, config) cross-checked against PLAN.md / MOBILE_PLAN.md /
MCP_PLAN.md (2026-07-06). Hydra is strong at running one agent safely (sandbox,
egress, tests gate, auto-merge); the biggest remaining gaps are in what happens
around the agents - getting work out (GitHub/PRs), getting work in
(queueing/scheduling/templates), and operating the fleet (mobile, notifications,
history).

## Not on any roadmap yet

1. [ ] **[Forge]** GitHub / forge integration. There is push, sync, and local
   merge, but no PR creation, no reading PR review comments back into a head,
   and no CI status ingestion. "Open a PR from this head" / "address the review
   comments on PR #123" is probably the single highest-leverage missing feature.
   Composes with merge-when-green: gate on real CI instead of (or alongside)
   local `[[tests]]`.

2. [ ] **[Orchestration]** Task queue / scheduled spawns. Every head is spawned
   interactively, one at a time. No way to queue a backlog of prompts ("run
   these 5 tasks as slots free up"), no recurring/cron spawns ("nightly: update
   deps and open a PR if tests pass"), no dependency chaining ("when head A
   merges, spawn B"). The daemon already owns lifecycle and has an auto-merge
   watcher, so the machinery to hang this off exists.

3. [ ] **[Orchestration]** Head pipelines / agent-to-agent steps. Agents are
   fully isolated; the only reviewer of a head's diff is the user. A built-in
   "spawn a reviewer head against this head's diff" or a spawn -> review -> fix
   loop would leverage existing pieces (worktrees, diff API, tests gate).

4. [ ] **[Agent UX]** Spawn templates/presets. Spawn is ad-hoc flags plus
   per-agent-type config. Saved presets (e.g. "bugfix: claude, base main, this
   pre_prompt, merge-when-green armed") would make repeat workflows one click,
   and are a prerequisite for queueing/scheduling anyway.

5. [ ] **[Notifications]** Notification backends beyond the browser. Today
   notifications are browser/OS notifications from an open tab only. A head
   finishing, failing tests, or blocking on an approval while the user is away
   is invisible - add a webhook/Slack/ntfy sink in the daemon. Pairs with
   mobile: approve a blocked tool call from a phone.

6. [ ] **[Metrics]** Fleet history/metrics. Claude usage and archived agents are
   tracked, but there is no cross-agent view: cost per head, merge rate,
   time-to-green, which prompts fail. Even a simple history table would show
   whether the orchestration is paying off.

7. [ ] **[Review]** Persistent review comments. Inline diff comments already
   exist (gutter hover -> comment box -> sent to the agent as input with diff
   context, `web/src/DiffViewer.tsx` `handleComment`), but they are
   fire-and-forget: not persisted, not rendered in the diff afterwards, no
   threads, no resolve state, no batch "submit review". The big version is a
   review mode: comments stored server-side, shown inline on the diff, agent
   replies/resolutions tracked, and a pending-comments batch submitted as one
   message. (PLAN #16 covers only UI bugfixes for the existing one-shot flow.)

## Already on a roadmap but untouched

8. [ ] **[Mobile]** Mobile UI - MOBILE_PLAN.md is entirely unimplemented; the
   web UI is desktop-only today.

9. [ ] **[Agent UX]** LSP alongside sandboxed agents (PLAN #7) - definitions,
   references, and diagnostics instead of file reads; real leverage for agent
   quality on Go code.

10. [ ] **[Sandbox]** Windows support (PLAN #4, #37) - every Windows path is a
    hard stub (sandbox, PTY, daemon, attach). Big cost; only worth it with
    actual Windows users.

11. [ ] **[Agent UX]** Resume archived agents (PLAN #49) - the button already
    exists in AgentDetail with a "not available yet" tooltip, so it is the most
    visible broken promise in the UI.
