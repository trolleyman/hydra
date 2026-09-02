# Agent collaboration MCP

Status: **built**. The initial protocol, policy, UI attribution, simulation
fixture, and daemon-enforced limits described below are implemented.

## Recommendation

Yes, with guardrails. Agent discovery is a cheap, useful primitive; messaging can
also unlock coordination between independently spawned heads. The risky part is
not transport but agency: two agents able to wake one another can create a
costly, confusing conversation with no human in the loop.

Build this into the always-seeded `hydra` MCP server rather than adding another
server. That server already knows the calling head by construction and relays
daemon-owned state through narrow file queues. No head should receive a daemon
API token or connect directly to another head's MCP process.

## Tools

The `hydra` server exposes three tools:

- `list_agents` lists live heads in the caller's project. Return stable ID,
  title, agent type, session state, current agent status/activity, branch and
  base branch, creation time, and whether it is the caller. Exclude prompts,
  conversation IDs, PIDs, absolute worktree paths, policy, and archived heads.
- `get_agent` returns the same record plus bounded, useful detail such as its
  latest status message, test summary, unread/open review counts, and armed
  merge/publish state. It remains a cached, read-only lookup and starts no work.
- `send_agent_message` takes a target ID and a short body, with optional
  `correlation_id` and `in_reply_to`. It returns `delivered` or `queued`; it does
  not wait for, imply, or synthesize a reply.

Keep `get_head_status` as the richer view of the caller's own tests, artifacts,
and services. The collaboration tools should not duplicate logs, diffs, review
comments, or full transcripts.

## Scope and delivery

The daemon resolves both source and target. The source identity comes from the
head-specific request directory, never from a tool argument; the target must be
a live, non-archived head in the same project. Cross-project messaging and
starting or resuming a stopped head are deliberately out of scope.

Add a small `agentq` request/result channel rather than stretching `reviewq`,
whose operations describe the calling head's own review and status. The daemon
answers discovery from `heads.ListHeads` and delivers messages through
`ChatQueueManager.Submit`, choosing immediate versus queued delivery from the
recipient's current state. This preserves ordering, transcript durability, and
mid-turn steering behavior.

Every message must be visibly attributed in both places:

- The recipient sees an agent-facing prefix naming the source ID and title.
- The chat event carries `origin: agent` and a separate `source_agent_id`, so the
  UI never renders it as something the user typed and the fixed origin enum does
  not encode dynamic IDs.
- The sender's tool result records target, correlation ID, and delivery state.

The message is the payload, not a notification about hidden state. Cap it (for
example, 4 KiB) and encourage paths, commit hashes, and review comment numbers
instead of pasted logs.

## Safety rules

Discovery is available by default because it is read-only and project-scoped.
Sending requires `policy.agent_messaging = true` at the project/default or
per-agent layer and defaults off. The tool is hidden when the effective policy
is off, and the daemon re-loads trusted config before every delivery.

Enforce limits in the daemon, not only in tool descriptions:

- Reject self-messages, unknown/stopped targets, oversized bodies, and invalid
  correlation metadata.
- Rate-limit per source/target pair and per project, and cap queued collaboration
  messages per recipient.
- Give each new message chain a daemon-issued correlation ID. Cap reply depth
  and messages per chain so two agents cannot sustain a ping-pong loop. A human
  message may start a fresh chain; an agent message may not reset its budget.
- Surface sender, recipient, timestamp, and delivery state in the transcript and
  daemon logs. Do not add read receipts or presence claims in the first version.
- Never let messaging bypass the recipient's lifecycle controls, sandbox, or MCP
  policy. Delivery is input to that agent, not authority borrowed from it.

## Implementation

1. **Built:** daemon-side `list_agents` and `get_agent`, with same-project live
   head filtering and metadata redaction tests.
2. **Built:** the separate `agentq` request channel and
   `send_agent_message`, guarded at delivery time by `policy.agent_messaging`.
   Policy changes take effect without restarting the calling head. Chat-mode
   delivery uses the durable queue; stopped, non-chat, self, oversized, and
   unknown targets are rejected.
3. **Built:** `agent` origin metadata plus `source_agent_id` in queued and durable
   events, a sender marker in chat, 4 KiB message and four-item recipient queue
   caps, six messages per chain, and six messages per pair per ten minutes. The
   simulation transcript includes a real attributed sibling-agent turn for
   browser verification.
4. **Deferred intentionally:** cross-project discovery, broadcast,
   subscriptions, durable inboxes, presence, and read receipts. Revisit these
   only after the initial tools demonstrate a concrete need.
