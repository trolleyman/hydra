# Agent collaboration MCP

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

Start with three tools:

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
- The chat event carries an origin such as `agent:<source-id>`, so the UI never
  renders it as something the user typed.
- The sender's tool result records target, correlation ID, and delivery state.

The message is the payload, not a notification about hidden state. Cap it (for
example, 4 KiB) and encourage paths, commit hashes, and review comment numbers
instead of pasted logs.

## Safety rules

Discovery can be available by default because it is read-only and
project-scoped. Sending should initially require an explicit per-project or
per-agent collaboration policy, defaulting off.

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

## Build order

1. Add daemon-side discovery plus `list_agents` and `get_agent`, with tests for
   project scoping and metadata redaction.
2. Add `agentq`, attributed chat events, and `send_agent_message` behind an
   opt-in policy. Test queue ordering, stopped targets, attribution, and limits.
3. Add chain budgets and a small UI treatment linking an agent-origin message to
   its sender. Exercise two simulation heads end-to-end, including a deliberate
   reply loop that Hydra cuts off.
4. After observing real use, decide whether cross-project discovery, broadcast,
   subscriptions, or durable inboxes solve demonstrated needs. Do not include
   them in the initial protocol.

