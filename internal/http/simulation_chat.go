package http

import (
	"encoding/json"
	"fmt"
	"maps"
	"strings"
	"sync"
	"time"

	"github.com/trolleyman/hydra/internal/api"
)

// The simulated Claude chat conversation, written directly in Hydra's
// normalized event shapes (internal/chat) - the only thing a chat socket
// speaks. Each entry is what internal/chat/claude.go produces from the
// corresponding provider line, so the simulation drives the same client
// reducer the daemon feeds.
//
// Two families of provider line deliberately have no entry here, because
// normalization drops them upstream and the client must never see them:
//   - the CLI's resume placeholders (the injected "Continue from where you left
//     off." / "No response requested." pair) and its image-downscale note, all
//     filtered by claudestream.IsHiddenChatMessage before the normalizer runs;
//   - a live plain-text `user` line, which normalizeClaude ignores because Hydra
//     already recorded that message at the input boundary. Only the durable
//     history path (normalizeClaudeHistory) turns one into a user_message, which
//     is why every user turn below is history, never live.

// simNorm is one normalized chat event in a canned conversation: its type, its
// payload, and an optional explicit timestamp (see simSequence - an entry
// without one lands a millisecond after its predecessor).
type simNorm struct {
	typ     string
	payload map[string]any
	ts      string
}

// at pins an event to a wall-clock timestamp. Used where the transcript's own
// timing matters: the commit chips interleave against these (see mergedItems).
func (e simNorm) at(ts string) simNorm {
	e.ts = ts
	return e
}

// set adds one payload field - the escape hatch for the fields only a handful
// of events carry (usage, stop_reason, an Edit's patch, a shell entry's cwd).
func (e simNorm) set(key string, value any) simNorm {
	payload := maps.Clone(e.payload)
	payload[key] = value
	return simNorm{typ: e.typ, payload: payload, ts: e.ts}
}

// sub marks an event as one of sub-agent agentID's own steps, the way the
// durable sidecar records them (agent_id + sidechain). The client folds these
// into that sub-agent's card instead of the main conversation.
func (e simNorm) sub(agentID string) simNorm {
	return e.set("sidechain", true).set("agent_id", agentID)
}

// under marks a step the way CURRENT CLIs mark a live sidechain line on stdout:
// parent_item_id only, with no agent id to key it by. The client has to fold it
// into the spawning tool's card through the placeholder route.
func (e simNorm) under(parentItemID string) simNorm {
	return e.set("sidechain", true).set("parent_item_id", parentItemID)
}

func simRaw(s string) json.RawMessage { return json.RawMessage(s) }

// simTextContent is the content-block array a text message carries, matching
// what Claude records (the client reads text out of these blocks, not a string).
func simTextContent(text string) []map[string]any {
	return []map[string]any{{"type": "text", "text": text}}
}

func simConversationStarted(model string, slashCommands []string) simNorm {
	return simNorm{typ: "conversation_started", payload: map[string]any{
		"conversation_id": "sim-chat", "model": model,
		"slash_commands": slashCommands,
		// "none" = subscription auth, so the chat hides the notional $ figure on
		// turn footers.
		"api_key_source": "none",
	}}
}

// simUser is a user turn. The uuid doubles as the reconciliation id, exactly as
// the history normalizer sets it.
func simUser(id, text string) simNorm {
	return simNorm{typ: "user_message", payload: map[string]any{
		"id": id, "uuid": id, "content": simTextContent(text),
	}}
}

func simAgentUser(id, source, text string) simNorm {
	return simNorm{typ: "user_message", payload: map[string]any{
		"id": id, "uuid": id, "content": simTextContent(text), "origin": "agent:" + source,
	}}
}

// simUserEcho is a user event whose content is a bare string rather than
// blocks - the shape the CLI uses for its local-command echoes.
func simUserEcho(id, text string) simNorm {
	return simNorm{typ: "user_message", payload: map[string]any{
		"id": id, "uuid": id, "content": text,
	}}
}

// simInjectedContext is CLI-injected context (an isMeta user turn): a compaction
// preamble or an auto-loaded skill body. Never typed, so the chat collapses it
// behind an expander rather than rendering a huge user bubble.
func simInjectedContext(id, text string) simNorm {
	return simNorm{typ: "context_message", payload: map[string]any{
		"uuid": id, "content": simTextContent(text), "is_meta": true,
	}}
}

// simSessionResumed is Hydra's own marker for replacing the agent process
// (chat.SessionResumed). Nothing in a provider's stream says this happened, and
// it matters to everything that outlived a turn - the Bash tool's shell above
// all, which comes back new at the worktree.
func simSessionResumed(worktree string) simNorm {
	return simNorm{typ: "session_resumed", payload: map[string]any{"worktree": worktree}}
}

// simShellCwd is the daemon's reading of where a Bash command left the shell
// (chat.ShellCwd), lifted off the CLI's transcript because its stdout carries no
// such thing. Its own event, arriving after the result it belongs to.
func simShellCwd(toolUseID, cwd string) simNorm {
	return simNorm{typ: "shell_cwd", payload: map[string]any{"tool_use_id": toolUseID, "cwd": cwd}}
}

func simSay(messageID, text string) simNorm {
	return simNorm{typ: "assistant_message", payload: map[string]any{
		"message_id": messageID, "text": text,
	}}
}

func simThink(messageID, text string) simNorm {
	return simNorm{typ: "reasoning_completed", payload: map[string]any{
		"message_id": messageID, "text": text,
	}}
}

// simThought is the measured duration of a thinking block, which the daemon
// records separately from the block itself (the CLI never reports it). Emitted
// ahead of the conversation, mirroring the import order in
// Manager.importClaudeHistory - the client needs the duration in hand before it
// builds the thinking item, and an EMPTY silently-reasoned block only stays
// visible at all because one of these exists for it.
func simThought(messageID string, durationMS int64) simNorm {
	return simNorm{typ: "reasoning_duration", payload: map[string]any{
		"message_id": messageID, "duration_ms": durationMS,
	}}
}

// simTool is a tool call. input is the provider's own block input, verbatim -
// keeping it as the provider sent it is what lets the chat's Raw panel show the
// real payload rather than something reconstructed field by field. Pass simRaw
// to transcribe a recorded block exactly, or a map where readability wins.
func simTool(id, name string, input any) simNorm {
	return simNorm{typ: "tool_started", payload: map[string]any{
		"id": id, "name": name, "input": input,
	}}
}

func simToolOut(id string, content any) simNorm {
	return simNorm{typ: "tool_completed", payload: map[string]any{
		"id": id, "content": content, "is_error": false,
	}}
}

func simToolErr(id string, content any) simNorm {
	return simNorm{typ: "tool_completed", payload: map[string]any{
		"id": id, "content": content, "is_error": true,
	}}
}

// simTurnDone ends a turn. usage/cost feed the turn footer.
func simTurnDone(usage json.RawMessage, costUSD float64) simNorm {
	payload := map[string]any{"status": "completed"}
	if usage != nil {
		payload["usage"] = usage
	}
	if costUSD > 0 {
		payload["cost_usd"] = costUSD
	}
	return simNorm{typ: "turn_completed", payload: payload}
}

func simTurnFailed() simNorm {
	return simNorm{typ: "turn_failed", payload: map[string]any{"status": "failed"}}
}

func simTurnInterrupted() simNorm {
	return simNorm{typ: "turn_interrupted", payload: map[string]any{"status": "interrupted"}}
}

// simNotice is harness bookkeeping the chat shows as a compact chip: a
// background command's completion, a queued message consumed mid-turn.
func simNotice(text string) simNorm {
	return simNorm{typ: "notice", payload: map[string]any{"text": text}}
}

// simSubStarted introduces a sub-agent and links it to the tool call that
// spawned it. parentID names the SUB-AGENT that spawned it (empty for a
// main-agent spawn), which is what folds a nested agent under its parent.
func simSubStarted(id, parentItemID, agentType, description, prompt, parentID string) simNorm {
	payload := map[string]any{
		"id": id, "parent_item_id": parentItemID, "agent_type": agentType,
		"description": description, "prompt": prompt, "status": "running",
	}
	if parentID != "" {
		payload["parent_id"] = parentID
	}
	return simNorm{typ: "subagent_started", payload: payload}
}

// simSubCompleted is the ONE canonical lifecycle event for a finished
// sub-agent. Every copy of its <task-notification> collapses to this, so a
// notification the CLI wrote twice still shows a single "finished" chip.
func simSubCompleted(id string) simNorm {
	return simNorm{typ: "subagent_completed", payload: map[string]any{"id": id, "status": "completed"}}
}

// simCommit is a commit chip. The daemon reconciles git against the
// conversation and appends one of these; the browser never fetches commits for
// the chat itself.
func simCommit(sha, shortSHA, subject, ts string) simNorm {
	return simNorm{typ: "commit_created", payload: map[string]any{
		"sha": sha, "short_sha": shortSHA, "subject": subject,
		"author_name": "Agent Claude", "author_email": "claude@hydra.ai",
		"timestamp": ts,
		"additions": 49, "deletions": 9,
	}}.at(ts)
}

// simBaseUpdate is the chip for an update-from-base that FAST-FORWARDED. The
// branch had nothing of its own to merge, so it now sits on main's own tip -
// and that commit's subject names whatever IT merged, some other head. The chip
// is therefore labelled from merged_ref, the ref that actually came in
// ("Merged main - 3 commits"), and expands to the commits it brought with it.
// See chat.appendAbsorbedBase.
func simBaseUpdate(ts string) simNorm {
	return simNorm{typ: "commit_created", payload: map[string]any{
		"sha": "5ca1ab1e0123456789abcdef0123456789abcdef", "short_sha": "5ca1ab1",
		"subject":     "Merge branch 'hydra/tighten-the-upload-timeout'",
		"author_name": "Agent Claude", "author_email": "claude@hydra.ai",
		"timestamp": ts,
		"is_merge":  true, "merged_ref": "main", "merged_count": 3,
		"merged_commits": []map[string]any{
			{"sha": "aa11bb22cc33dd44ee55ff6677889900aabbccdd", "short_sha": "aa11bb2", "subject": "Tighten the upload timeout to 30s"},
			{"sha": "bb22cc33dd44ee55ff6677889900aabbccddeeff", "short_sha": "bb22cc3", "subject": "Name the retry budget in the config docs"},
			{"sha": "cc33dd44ee55ff6677889900aabbccddeeff0011", "short_sha": "cc33dd4", "subject": "Merge branch 'hydra/tighten-the-upload-timeout'"},
		},
	}}.at(ts)
}

// simRetracted is the safety-retry eviction: a classifier flagged a turn, so
// the CLI retracts the blocks it already streamed and retries on a fallback
// model. The client must evict those message ids or the flagged text lingers.
func simRetracted(ids ...string) simNorm {
	return simNorm{typ: "messages_retracted", payload: map[string]any{"message_ids": ids}}
}

// simChatSlashCommands is what the CLI advertises on its init line; it feeds
// the composer's "/" autocomplete.
var simChatSlashCommands = []string{"compact", "context", "cost", "init", "pr-comments", "review", "security-review", "usage"}

// simChatPlan is the head's plan/to-do list as the daemon persists it (the
// projection carries it, so it survives a reload with no browser attached).
// Same four steps the TodoWrite call below writes.
const simChatPlan = `[
	{"content":"Read the current uploader","status":"completed","activeForm":"Reading the current uploader"},
	{"content":"Wire in the backoff retry loop","status":"in_progress","activeForm":"Wiring in the backoff retry loop"},
	{"content":"Add a test for the giving-up path","status":"pending","activeForm":"Adding a test for the giving-up path"},
	{"content":"Run go test and vet","status":"pending","activeForm":"Running go test and vet"}
]`

// simChatEvents is the simulated chat agent's durable conversation: the task
// prompt, thinking, markdown-rich replies, tool calls and their results (one an
// error), sub-agents nested two deep, commit chips and turn footers. Ordered
// oldest-first, exactly as the event log stores it.
var simChatEvents = []simNorm{
	// Thinking durations first, mirroring Manager.importClaudeHistory: the
	// sidecar is imported before the transcript, so the client has msg_sim_1's
	// and msg_sim_4's measured times before it builds either thinking item.
	// msg_sim_4's block is EMPTY - it stays visible as "Thought for Xs" only
	// because this event exists for it.
	simThought("msg_sim_1", 5000),
	simThought("msg_sim_4", 3000),
	simConversationStarted("claude-opus-4-8", simChatSlashCommands),
	// A context-compaction "session continued" preamble (item 39). The CLI does
	// NOT flag this one isMeta, so it normalizes to an ordinary user_message and
	// the chat recognises it by its opening line (detectContextNote), collapsing
	// it behind a "Continued from a previous conversation" pill. Sending it as
	// injected context instead would render it as a generic meta card.
	simUser("sim-compaction", "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. The user asked to add a retry loop with exponential backoff to the artifacts uploader, plus a giving-up test.\n2. We located the uploader in internal/artifacts/upload.go and drafted a jittered backoff helper.\n3. Next step: wire the retry loop into Put and add TestPutRetry.\n\nContinue from where you left off."),
	simUser("sim-real-0", simAgentChatPrompt).at("2026-07-09T18:00:00.000Z"),
	simThink("msg_sim_1", "The uploader lives in internal/artifacts/upload.go. A retry loop with jittered exponential backoff around the PUT, capped attempts, and a unit test faking a flaky server should cover it.\nThe giving-up path needs the fake server to fail more times than the attempt cap, then assert the last error surfaces.").at("2026-07-09T18:00:03.000Z"),
	simSay("msg_sim_1", "I'll add the retry around the upload call. The plan:\n\n## Approach\n\n- Wrap the `PUT` in a retry loop with **exponential backoff** (100ms base, x2, jitter)\n- Give up after *5 attempts* and surface the last error\n- Cover the giving-up path with a fake flaky server\n\nLet me look at the current uploader first."),
	// A /model switch: the CLI records it as a caveat + command echo + a
	// "Set model to ..." stdout sibling, each its own bare-string user event, at
	// this (correct, non-bottom) chronological position. The chat hides the first
	// two and renders the third as a compact confirmation.
	simUserEcho("sim-model-caveat", "<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.</local-command-caveat>"),
	simUserEcho("sim-model-cmd", "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>"),
	simUserEcho("sim-model-out", "<local-command-stdout>Set model to opus (claude-opus-4-8)</local-command-stdout>"),
	// A Skill launch: the tool_use renders as a Skill card with a short
	// "Launching skill" output; the SKILL.md body Claude auto-loads arrives as
	// injected context and folds into a collapsed "Skill loaded: <name>" card.
	simTool("toolu_sim_skill", "Skill", simRaw(`{"skill":"claude-api","args":"context window sizes per model"}`)),
	simToolOut("toolu_sim_skill", "Launching skill: claude-api"),
	simInjectedContext("sim-skill-body", "Base directory for this skill: /tmp/claude-1000/bundled-skills/2.1.212/1b3566cf/claude-api\n\n# Building LLM-Powered Applications with Claude\n\nThis skill helps you build LLM-powered applications with Claude. Choose the right surface based on your needs, detect the project language, then read the relevant language-specific documentation.\n\n## Before You Start\n\nScan the target file for non-Anthropic provider markers (import openai, OpenAI(, gpt-4). If you find any, stop and tell the user.\n\n## Output Requirement\n\nWhen the user asks you to add or implement a Claude feature, your code must call Claude through one of the official SDKs."),
	// A TodoWrite: feeds the floating plan panel (item 17) instead of a card.
	simTool("toolu_sim_todo", "TodoWrite", simRaw(`{"todos":[{"content":"Read the current uploader","status":"completed","activeForm":"Reading the current uploader"},{"content":"Wire in the backoff retry loop","status":"in_progress","activeForm":"Wiring in the backoff retry loop"},{"content":"Add a test for the giving-up path","status":"pending","activeForm":"Adding a test for the giving-up path"},{"content":"Run go test and vet","status":"pending","activeForm":"Running go test and vet"}]}`)),
	simToolOut("toolu_sim_todo", "Todos updated"),
	simTool("toolu_sim_1", "Read", simRaw(`{"file_path":"internal/artifacts/upload.go"}`)),
	simToolOut("toolu_sim_1", "func (u *Uploader) Put(ctx context.Context, key string, r io.Reader) error {\n\treq, err := u.newRequest(ctx, key, r)\n\tresp, err := u.client.Do(req)\n\tif err != nil {\n\t\treturn errtrace.Wrap(err)\n\t}\n\tdefer resp.Body.Close()\n\treturn nil\n}"),
	// A Read of an auto-memory file: renders as "Read memory <name>" with the
	// long ~/.claude/... path collapsed away (item 5).
	simTool("toolu_sim_mem", "Read", simRaw(`{"file_path":"/home/callum/.claude/projects/-home-callum-code-hydra/memory/branch-split-mirror-design.md"}`)),
	simToolOut("toolu_sim_mem", "<system-reminder>This memory is 7 days old. Memories are point-in-time observations, not live state - claims about code behavior or file:line citations may be outdated. Verify against current code before asserting as fact.</system-reminder>\n     1\t---\n     2\tname: branch-split-mirror-design\n     3\tdescription: proposed ff-only mirror design so the user can checkout hydra/<id>\n     4\tmetadata:\n     5\t  type: reference\n     6\t---\n     7\t\n     8\tProposed (unbuilt) design: the **worktree moves to an internal branch**, and hydra/<id> becomes a best-effort **ff-only mirror** of it.\n     9\t\n    10\tForce-update and auto-conflict-merge were both ruled out - a force-push would clobber a user's local commits, and an auto-merge could silently resolve a conflict the wrong way."),
	// A Read with offset+limit: the range shows after the filename in the header
	// (item 1); its .go output is syntax highlighted (item 3).
	simTool("toolu_sim_off", "Read", simRaw(`{"file_path":"internal/artifacts/upload.go","offset":100,"limit":40}`)),
	simToolOut("toolu_sim_off", "   100\tfunc sleepBackoff(attempt int) {\n   101\t\tbase := 100 * time.Millisecond\n   102\t\td := base << attempt\n   103\t\tjitter := time.Duration(rand.Int63n(int64(d) / 2))\n   104\t\ttime.Sleep(d + jitter)\n   105\t}"),
	// An image Read: the decoded image shows in the Output section (item 4).
	simTool("toolu_sim_img", "Read", simRaw(`{"file_path":"web/scripts/screenshots/out/agent-dark.png"}`)),
	simToolOut("toolu_sim_img", simRaw(`[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"`+simChatImageB64+`"}}]`)),
	// An Edit: its input panel shows unlabelled (item 14), rendered as a unified
	// diff. This one carries the CLI's structuredPatch, so the card shows the
	// file's real line numbers and the context lines around the edit.
	simTool("toolu_sim_edit", "Edit", simRaw(`{"file_path":"internal/artifacts/upload.go","old_string":"return u.put(ctx, key, r)","new_string":"for attempt := 0; attempt < maxAttempts; attempt++ {\n\tif err = u.put(ctx, key, r); err == nil { return nil }\n\tsleepBackoff(attempt)\n}"}`)),
	simToolOut("toolu_sim_edit", "The file internal/artifacts/upload.go has been updated.").
		set("patch", simRaw(`[{"oldStart":86,"oldLines":4,"newStart":86,"newLines":7,"lines":[" func (u *Uploader) Upload(ctx context.Context, key string, r io.Reader) error {"," \tvar err error","-return u.put(ctx, key, r)","+for attempt := 0; attempt < maxAttempts; attempt++ {","+\tif err = u.put(ctx, key, r); err == nil { return nil }","+\tsleepBackoff(attempt)","+}"," }"]}]`)),
	// A second Edit with NO patch (an older CLI, or the call still running): the
	// card falls back to diffing old_string against new_string, so shared lines
	// still read as context - but with no gutter, since a fragment cannot say
	// where in the file it sits.
	simTool("toolu_sim_edit2", "Edit", simRaw(`{"file_path":"internal/artifacts/upload.go","old_string":"// maxAttempts bounds the retry loop.\nconst maxAttempts = 3\n\nvar errGaveUp = errors.New(\"upload: gave up\")","new_string":"// maxAttempts bounds the retry loop (three tries, jittered backoff).\nconst maxAttempts = 5\n\nvar errGaveUp = errors.New(\"upload: gave up\")"}`)),
	simToolOut("toolu_sim_edit2", "The file internal/artifacts/upload.go has been updated."),
	// A Write: its content renders as a numbered, syntax-highlighted code block
	// (like a Read), not raw JSON.
	simTool("toolu_sim_write", "Write", simRaw(`{"file_path":"internal/artifacts/backoff.go","content":"package artifacts\n\nimport (\n\t\"math/rand\"\n\t\"time\"\n)\n\n// sleepBackoff sleeps for a jittered exponential delay: base 100ms, doubled per\n// attempt, plus up to 50% jitter.\nfunc sleepBackoff(attempt int) {\n\tbase := 100 * time.Millisecond\n\td := base << attempt\n\tjitter := time.Duration(rand.Int63n(int64(d) / 2))\n\ttime.Sleep(d + jitter)\n}"}`)).at("2026-07-09T18:01:00.000Z"),
	simToolOut("toolu_sim_write", "File created successfully at: internal/artifacts/backoff.go"),
	// This commit's timestamp sits between the Write above and the TaskCreate
	// below, so its chip interleaves between the two cards.
	simCommit("cafebabe0123456789abcdef0123456789abcdef", "cafebab", "Add jittered backoff helper to the uploader", "2026-07-09T18:01:30.000Z"),
	// A TaskCreate: its subject shows in the header in the regular (sans) font,
	// like a path - not monospace.
	simTool("toolu_sim_taskcreate", "TaskCreate", simRaw(`{"subject":"Add a giving-up test for the uploader","description":"Assert that when **every** attempt fails, `+"`Put`"+` surfaces the last error - a fake server that fails more times than the attempt cap."}`)).at("2026-07-09T18:02:00.000Z"),
	simToolOut("toolu_sim_taskcreate", "Task #1 created successfully: Add a giving-up test for the uploader"),
	simTool("toolu_sim_taskcreate2", "TaskCreate", simRaw(`{"subject":"Thread MaxAttempts through the uploader config","description":"So callers can tune the retry cap without recompiling."}`)),
	simToolOut("toolu_sim_taskcreate2", "Task #2 created successfully: Thread MaxAttempts through the uploader config"),
	simTool("toolu_sim_taskcreate3", "TaskCreate", simRaw(`{"subject":"Run go test and vet","description":"Confirm the retry + giving-up paths pass and nothing else regressed."}`)),
	simToolOut("toolu_sim_taskcreate3", "Task #3 created successfully: Run go test and vet"),
	simTool("toolu_sim_taskupd1", "TaskUpdate", simRaw(`{"taskId":"1","status":"completed"}`)),
	simToolOut("toolu_sim_taskupd1", "Updated task #1 status"),
	simTool("toolu_sim_taskupd2", "TaskUpdate", simRaw(`{"taskId":"2","status":"in_progress"}`)),
	simToolOut("toolu_sim_taskupd2", "Updated task #2 status"),
	// Loading a deferred tool's schema before calling it. The header shows what is
	// being looked up, not the wire name: a `select:` list renders as the bare tool
	// names with MCP ones as "hydra::git_add" (summarizeToolSearchQuery).
	simTool("toolu_sim_toolsearch", "ToolSearch", simRaw(`{"query":"select:mcp__hydra__git_add,mcp__hydra__git_commit","max_results":2}`)),
	// The result carries no text at all - one `tool_reference` block per loaded
	// tool - which is why the card rendered "(no output)" until parseToolResult
	// learned to name them.
	simToolOut("toolu_sim_toolsearch", simRaw(`[{"type":"tool_reference","tool_name":"mcp__hydra__git_add"},{"type":"tool_reference","tool_name":"mcp__hydra__git_commit"}]`)),
	// The mcp__hydra__git_* tools - Hydra's own git plumbing, which replaces raw
	// git for a sandboxed head. Each renders as the ACTION it takes rather than as
	// its argument JSON (summarizeGitInput / GIT_TOOL_LABELS in AgentChat.tsx): a
	// commit shows just its subject line, not the whole escaped multi-line message;
	// a stage shows the file and line range; a reset shows "mixed -> HEAD~1".
	// The commit below uses staged:true, the mode that commits the partial index
	// the git_add above built - the other modes re-stage whole files and would
	// silently widen it.
	simTool("toolu_sim_gitadd", "mcp__hydra__git_add", simRaw(`{"files":[{"path":"internal/artifacts/upload.go","ranges":[[12,18]]}]}`)).at("2026-07-09T18:03:00.000Z"),
	simToolOut("toolu_sim_gitadd", "Staged: internal/artifacts/upload.go (lines 12-18)"),
	simTool("toolu_sim_gitcommit", "mcp__hydra__git_commit", simRaw(`{"message":"Retry uploads with jittered exponential backoff\n\nPut now retries a failed upload up to maxAttempts times, sleeping a\njittered exponential delay between tries, and surfaces the last error\nonce every attempt is exhausted.","staged":true}`)),
	simToolOut("toolu_sim_gitcommit", "Committed 4f2ab19c on hydra/retry-uploads: Retry uploads with jittered exponential backoff"),
	// The conflict path, which is where the output cleanup shows: the summary
	// names the conflicting files up front, and git's post-abort "hint:" block is
	// stripped - it told you to resolve and run a --continue, but the pick was
	// already rolled back, so following it was impossible.
	simTool("toolu_sim_gitpick", "mcp__hydra__git_cherry_pick", simRaw(`{"commit":"0a5501ec"}`)),
	simToolErr("toolu_sim_gitpick", "cherry-pick of 0a5501ec hit conflicts in internal/heads/heads.go, internal/tui/model.go and was aborted - your branch is unchanged.\nAuto-merging internal/heads/heads.go\nCONFLICT (content): Merge conflict in internal/heads/heads.go\nAuto-merging internal/tui/model.go\nCONFLICT (content): Merge conflict in internal/tui/model.go\nerror: could not apply 0a5501ec... use slug as agent ID instead of random characters"),
	simTool("toolu_sim_gitreset", "mcp__hydra__git_reset", simRaw(`{"to":"HEAD~1","mode":"mixed"}`)),
	simToolOut("toolu_sim_gitreset", "Reset (mixed) hydra/retry-uploads to HEAD~1 (4f2ab19c)."),
	// A multi-file git_add (the single-file form above hides its panel, since the
	// header already says everything) and a rebase plan - the two cards whose
	// bodies are lists rather than a sentence.
	simTool("toolu_sim_gitadd2", "mcp__hydra__git_add", simRaw(`{"files":[{"path":"internal/artifacts/upload.go"},{"path":"internal/artifacts/backoff.go"},{"path":"internal/artifacts/upload_test.go","ranges":[[40,58]]}]}`)),
	simToolOut("toolu_sim_gitadd2", "Staged: internal/artifacts/upload.go, internal/artifacts/backoff.go, internal/artifacts/upload_test.go (lines 40-58)"),
	simTool("toolu_sim_gitrebase", "mcp__hydra__git_rebase", simRaw(`{"base":"HEAD~3","plan":[{"commit":"4f2ab19c","action":"reword","message":"Retry uploads with jittered exponential backoff"},{"commit":"9c1d0e77","action":"fixup"},{"commit":"b3e5a210","action":"pick"}]}`)),
	simToolOut("toolu_sim_gitrebase", "Rebased 3 commits above HEAD~3 on hydra/retry-uploads (now at 7d41c8ba)."),
	// Hydra's own review comments, read back and answered. The result is the exact
	// text reviewstore.RenderForAgent writes, which the card parses back into the
	// comments themselves (lib/reviewCommentsText): the anchor as a file with its
	// icon and lowlit directory, the handle as a quiet mono "#19", the comparison
	// as branch pills, and the frozen excerpt with the commented line accented.
	simTool("toolu_sim_reviewread", "mcp__hydra__get_review_comments", simRaw(`{"numbers":[19,20]}`)),
	simToolOut("toolu_sim_reviewread", "#19 internal/artifacts/upload.go:118 - user, on main -> latest commit\n"+
		"```diff\n--- internal/artifacts/upload.go\n+++ internal/artifacts/upload.go\n"+
		"@@ -112,7 +112,11 @@ func (u *Uploader) Put(ctx context.Context, key string, body io.Reader) error {\n"+
		" \tfor attempt := 1; attempt <= u.maxAttempts; attempt++ {\n"+
		" \t\tif err := u.put(ctx, key, body); err == nil {\n"+
		" \t\t\treturn nil\n"+
		" \t\t}\n"+
		"+\t\ttime.Sleep(backoff(attempt))\n"+
		"# ^ Comment\n"+
		" \t}\n"+
		" \treturn u.lastErr\n"+
		"```\n"+
		"This sleeps on the LAST attempt too - so a giving-up call waits a full backoff for nothing. Should the loop break before it?\n\n"+
		"#20 internal/artifacts/upload.go:118 (reply to #19) [resolved] - reviewer, on main -> 4f2ab19c\n"+
		"Agreed, and the test at `upload_test.go:61` would have caught it if it asserted elapsed time."),
	simTool("toolu_sim_reviewreply", "mcp__hydra__reply_to_review_comment", simRaw(`{"number":19,"body":`+
		`"Fixed: the sleep now happens only when another attempt is going to run.\n\n`+
		"```go\\nif attempt == u.maxAttempts {\\n\\tbreak\\n}\\ntime.Sleep(backoff(attempt))\\n```"+
		`\n\nThe giving-up path returns as soon as the last attempt fails, and `+"`TestPutGivesUp`"+
		` now asserts it takes under a millisecond."}`)),
	simToolOut("toolu_sim_reviewreply", "Saved as #21, threaded under #19. The user can see it in Hydra's diff viewer."),
	simTool("toolu_sim_reviewadd", "mcp__hydra__add_review_comment", simRaw(`{"path":"internal/artifacts/backoff.go","line":24,"body":"The jitter here is **full** jitter (0..d), not equal jitter (d/2..d). Worth a line saying so - the difference matters when many uploads retry together."}`)),
	simToolOut("toolu_sim_reviewadd", "Saved as #22 on internal/artifacts/backoff.go:24. The user can see it in Hydra's diff viewer; refer to it by its number from here on."),
	// A message queued while the turn ran and consumed INTO it. The CLI records
	// only its queued_command attachment - there is no user event - so the
	// normalizer turns it into a notice rather than losing it.
	simNotice("Queued while you were working: prefer a helper named backoffRetry."),
	// A sub-agent (Task tool) run: the Task call in the main flow, the sub-agent's
	// own steps, then the Task result. The chat folds the steps into a
	// SubagentCard on the Task card instead of leaking them into the main
	// conversation (the whole point of this feature).
	simTool("toolu_sim_task", "Task", simRaw(`{"description":"Audit upload retry tests","subagent_type":"Explore","prompt":"Search the internal/artifacts package for existing retry/backoff tests and report what is covered and where the gaps are - especially whether the giving-up path (all attempts exhausted) is asserted anywhere."}`)),
	simSubStarted("sim_sub_1", "toolu_sim_task", "Explore", "Audit upload retry tests", "Search the internal/artifacts package for existing retry/backoff tests and report what is covered and where the gaps are - especially whether the giving-up path (all attempts exhausted) is asserted anywhere.", ""),
	simUser("sim-sub-1-prompt", "Search the internal/artifacts package for existing retry/backoff tests and report what is covered and where the gaps are - especially whether the giving-up path (all attempts exhausted) is asserted anywhere.").sub("sim_sub_1"),
	simThink("msg_sub_1", "I'll grep the package for retry test functions, then read the upload test file to see which paths are covered.").sub("sim_sub_1"),
	simTool("toolu_sub_grep", "Grep", simRaw(`{"pattern":"func Test.*Retry","path":"internal/artifacts"}`)).sub("sim_sub_1"),
	simToolOut("toolu_sub_grep", "internal/artifacts/upload_test.go:41:func TestPutRetry(t *testing.T) {").sub("sim_sub_1"),
	// The rest of the sub-agent's run. A sub-agent's inner timeline folds by the
	// same rule as the main one (SubagentTimeline -> planStepRows), so it needs
	// more than one call in a row to be worth anything as a test of it.
	simTool("toolu_sub_read_test", "Read", simRaw(`{"file_path":"internal/artifacts/upload_test.go","offset":30,"limit":40}`)).sub("sim_sub_1"),
	simToolOut("toolu_sub_read_test", "func TestPutRetry(t *testing.T) {\n\tsrv := flakyServer(t, 1) // fails once, then succeeds\n\tif err := Put(ctx, srv.URL, blob); err != nil {\n\t\tt.Fatalf(\"expected success after one retry: %v\", err)\n\t}\n}").sub("sim_sub_1"),
	simTool("toolu_sub_read_impl", "Read", simRaw(`{"file_path":"internal/artifacts/upload.go"}`)).sub("sim_sub_1"),
	simToolOut("toolu_sub_read_impl", "func Put(ctx context.Context, url string, blob []byte) error {\n\tfor attempt := 0; attempt < maxAttempts; attempt++ {\n\t\tif err := put(ctx, url, blob); err == nil {\n\t\t\treturn nil\n\t\t}\n\t}\n\treturn nil // <- swallows the last error\n}").sub("sim_sub_1"),
	simTool("toolu_sub_bash", "Bash", simRaw(`{"command":"go test ./internal/artifacts/ -run TestPutRetry -v","description":"Run the one retry test that exists"}`)).sub("sim_sub_1"),
	simToolOut("toolu_sub_bash", "=== RUN   TestPutRetry\n--- PASS: TestPutRetry (0.01s)\nPASS\nok  \tgithub.com/trolleyman/hydra/internal/artifacts\t0.014s").sub("sim_sub_1"),
	simTool("toolu_sub_grep2", "Grep", simRaw(`{"pattern":"maxAttempts|MaxAttempts","path":"internal","output_mode":"content"}`)).sub("sim_sub_1"),
	simToolOut("toolu_sub_grep2", "internal/artifacts/upload.go:18:const maxAttempts = 5\ninternal/config/config.go:88:\tMaxAttempts int").sub("sim_sub_1"),
	simTool("toolu_sub_grep3", "Grep", simRaw(`{"pattern":"ErrGaveUp|exhausted","path":"internal/artifacts"}`)).sub("sim_sub_1"),
	simToolErr("toolu_sub_grep3", "No matches found").sub("sim_sub_1"),
	simSay("msg_sub_3", "Found a single retry test. It exercises the succeed-after-a-failure path but never the exhausted-attempts path.").sub("sim_sub_1"),
	simToolOut("toolu_sim_task", "## Coverage summary\n\n- `TestPutRetry` (upload_test.go:41) covers **succeed after one transient failure**.\n\n**Gap:** nothing asserts the *giving-up* path - when every attempt fails, the last error should surface. Worth adding a case where the fake server fails more times than the attempt cap."),
	// A SendMessage back to that (now finished) sub-agent: the card renders the
	// recipient, summary and message as prose - not the raw JSON, which echoes
	// the same id/message three times - and its JSON reply as one sentence. The
	// reply resumed the agent, so the sub goes back to "working" (its Task card
	// settled long ago, hence SubagentView.reopened) until it notifies again.
	simTool("toolu_sim_sendmsg", "SendMessage", simRaw(`{"to":"sim_sub_1","summary":"Also check the artifacts uploader's giving-up path","message":"One more thing before you write up: check whether internal/artifacts asserts the giving-up path anywhere (all attempts exhausted, last error surfaced), and include file:line references in your report.","type":"message","recipient":"sim_sub_1","content":"One more thing before you write up: check whether internal/artifacts a…"}`)),
	simToolOut("toolu_sim_sendmsg", "{\"success\":true,\"message\":\"Agent \\\"sim_sub_1\\\" had no active task; resumed from transcript in the background with your message. You'll be notified when it finishes. Output: /tmp/claude-sim/tasks/sim_sub_1.output\",\"resumedAgentId\":\"sim_sub_1\",\"pin\":{\"id\":\"sim_sub_1\",\"name\":\"sim_sub_1\",\"ref\":\"acf68b\"}}"),
	// A second sub-agent whose steps carry only parent_item_id - no agent id, and
	// no subagent_started ahead of them. The chat must fold it into its Task card
	// through the placeholder route instead of rendering the prompt echo as a
	// user message.
	simTool("toolu_sim_task2", "Task", simRaw(`{"description":"Check retry docs","subagent_type":"Explore","prompt":"Scan docs/ for retry/backoff guidance and summarize what it prescribes."}`)),
	simUser("sim-sub-2-prompt", "Scan docs/ for retry/backoff guidance and summarize what it prescribes.").under("toolu_sim_task2"),
	simToolOut("toolu_sim_task2", "docs/retry.md prescribes jittered exponential backoff for client uploads; nothing documents the giving-up semantics."),
	// EnterPlanMode: a zero-argument tool call. Its empty `{}` input renders no
	// input panel and no "Output" header - just the entered-plan-mode text.
	simTool("toolu_sim_enterplan", "EnterPlanMode", simRaw(`{}`)),
	simToolOut("toolu_sim_enterplan", "Entered plan mode. You should now focus on exploring the codebase and designing an implementation approach.\n\nIn plan mode, you should:\n1. Thoroughly explore the codebase to understand existing patterns\n2. Identify similar features and architectural approaches\n3. Consider multiple approaches and their trade-offs\n4. Use AskUserQuestion if you need to clarify the approach\n5. Design a concrete implementation strategy\n6. When ready, use ExitPlanMode to present your plan for approval\n\nRemember: DO NOT write or edit any files yet. This is a read-only exploration and planning phase."),
	// ExitPlanMode: renders the plan markdown in a dedicated card headed by the
	// plan file's basename (not its long absolute path).
	simTool("toolu_sim_exitplan", "ExitPlanMode", simRaw(`{"plan":"# Plan: add jittered backoff to the uploader\n\n## Context\nThe uploader retries once and gives up. We want a bounded, jittered exponential backoff loop.\n\n## Approach\n1. Add a `+"`sleepBackoff(attempt)`"+` helper (base 100ms, doubled per attempt, +/- 50% jitter).\n2. Wrap `+"`Put`"+` in a `+"`for attempt < maxAttempts`"+` loop, returning early on success.\n3. Thread `+"`MaxAttempts`"+` through the uploader config so callers can tune the cap.\n\n## Verification\n- `+"`TestPutRetry`"+` covers succeed-after-one-failure.\n- Add a case asserting the **giving-up** path surfaces the last error.","planFilePath":"/home/callum/.claude/plans/compressed-sleeping-flame.md"}`)),
	simToolOut("toolu_sim_exitplan", "User has approved your plan. You can now start coding."),
	// A background COMMAND's completion notification. It carries an output-file
	// and is not an agent, so it stays an expandable notice rather than becoming
	// a sub-agent lifecycle event.
	simNotice("<task-notification>\n<task-id>bx2i97jd3</task-id>\n<status>completed</status>\n<summary>Background command \"go test ./... 2&gt;&amp;1\" completed (exit code 0)</summary>\n</task-notification>"),
	// A RESUMED background/async sub-agent that finished before a daemon
	// stop+resume. The import order is the hazard: the main transcript (the Agent
	// launch, its launch-boilerplate result, its completion) is normalized first,
	// and the sub's own sidecar only afterwards - so the completion is processed
	// BEFORE the sub-agent exists. Its card must still settle to "finished"
	// rather than hang on "working" forever.
	simTool("toolu_sim_resumed_bg", "Task", simRaw(`{"description":"Find preview proxy code","subagent_type":"scout","prompt":"Find the preview reverse-proxy handler and where response headers are copied."}`)),
	simToolOut("toolu_sim_resumed_bg", "Async agent launched successfully. (This tool result is internal metadata - never quote or paste any part of it into a user-facing reply.)\nagentId: sim_sub_resumed_bg (internal ID - do not mention to user.)\nThe agent is working in the background. You will be notified automatically when it completes."),
	simSubCompleted("sim_sub_resumed_bg"),
	simSubStarted("sim_sub_resumed_bg", "toolu_sim_resumed_bg", "scout", "Find preview proxy code", "Find the preview reverse-proxy handler and where response headers are copied.", ""),
	simTool("toolu_sim_resumed_grep", "Grep", simRaw(`{"pattern":"httputil.ReverseProxy","path":"internal"}`)).sub("sim_sub_resumed_bg"),
	simToolOut("toolu_sim_resumed_grep", "internal/preview/spawn.go:223: in.proxy = httputil.NewSingleHostReverseProxy(target)").sub("sim_sub_resumed_bg"),
	simTool("toolu_sim_resumed_read", "Read", simRaw(`{"file_path":"internal/preview/spawn.go","offset":210,"limit":30}`)).sub("sim_sub_resumed_bg"),
	simToolOut("toolu_sim_resumed_read", "target, err := url.Parse(fmt.Sprintf(\"http://127.0.0.1:%d\", port))\nif err != nil {\n\treturn nil, err\n}\nin.proxy = httputil.NewSingleHostReverseProxy(target)").sub("sim_sub_resumed_bg"),
	simTool("toolu_sim_resumed_grep2", "Grep", simRaw(`{"pattern":"ModifyResponse|Director","path":"internal/preview"}`)).sub("sim_sub_resumed_bg"),
	simToolErr("toolu_sim_resumed_grep2", "No matches found").sub("sim_sub_resumed_bg"),
	simSay("msg_sim_resumed_bg_2", "The reverse proxy is built at internal/preview/spawn.go:223 (stock NewSingleHostReverseProxy, no ModifyResponse); headers pass through untouched.").sub("sim_sub_resumed_bg"),
	// A NESTED sub-agent: a background sub-agent that spawns its OWN background
	// sub-agent. The nested spawn's Agent call + launch boilerplate live in the
	// PARENT's timeline and must upgrade into the child's SubagentCard there (not
	// render as raw prompt JSON), with the child folded under the parent in the
	// view selector. The completion sequence mirrors what really happens: the
	// parent's premature "finished" (it stopped while its child still ran), the
	// child's completion, then the parent's real completion after the coordinator
	// nudged it - and because every copy collapses to one lifecycle event, ONE
	// parent chip remains.
	simTool("toolu_sim_nest", "Agent", simRaw(`{"description":"Audit retry stack end to end","subagent_type":"general-purpose","prompt":"Audit the whole retry stack: delegate a config-parsing scan to a scout, then combine it with the uploader findings into one report."}`)),
	simToolOut("toolu_sim_nest", "Async agent launched successfully. (This tool result is internal metadata - never quote or paste any part of it into a user-facing reply.)\nagentId: sim_sub_nest (internal ID - do not mention to user.)\nThe agent is working in the background. You will be notified automatically when it completes."),
	simSubStarted("sim_sub_nest", "toolu_sim_nest", "general-purpose", "Audit retry stack end to end", "Audit the whole retry stack: delegate a config-parsing scan to a scout, then combine it with the uploader findings into one report.", ""),
	simUser("sim-nest-prompt", "Audit the whole retry stack: delegate a config-parsing scan to a scout, then combine it with the uploader findings into one report.").sub("sim_sub_nest"),
	// Two calls of its own BEFORE the nested spawn, so the parent's timeline has a
	// folded run above the child's card as well as below it.
	simTool("toolu_sim_nest_read", "Read", simRaw(`{"file_path":"internal/artifacts/backoff.go"}`)).sub("sim_sub_nest"),
	simToolOut("toolu_sim_nest_read", "func sleepBackoff(attempt int) {\n\td := base << attempt\n\ttime.Sleep(d/2 + time.Duration(rand.Int63n(int64(d))))\n}").sub("sim_sub_nest"),
	simTool("toolu_sim_nest_grep", "Grep", simRaw(`{"pattern":"sleepBackoff","path":"internal"}`)).sub("sim_sub_nest"),
	simToolOut("toolu_sim_nest_grep", "internal/artifacts/upload.go:37:\t\tsleepBackoff(attempt)").sub("sim_sub_nest"),
	simTool("toolu_sim_nest_child", "Agent", simRaw(`{"description":"Scan config parsing","subagent_type":"scout","prompt":"Find where retry settings are parsed from config and report the file:line references."}`)).sub("sim_sub_nest"),
	simToolOut("toolu_sim_nest_child", "Async agent launched successfully. (This tool result is internal metadata - never quote or paste any part of it into a user-facing reply.)\nagentId: sim_sub_nest_child (internal ID - do not mention to user.)\nThe agent is working in the background. You will be notified automatically when it completes.").sub("sim_sub_nest"),
	simSubStarted("sim_sub_nest_child", "toolu_sim_nest_child", "scout", "Scan config parsing", "Find where retry settings are parsed from config and report the file:line references.", "sim_sub_nest"),
	simSay("msg_sim_nest_2", "The config scan is running in the background - I'll fold its findings into the audit once it reports.").sub("sim_sub_nest"),
	simUser("sim-nest-child-prompt", "Find where retry settings are parsed from config and report the file:line references.").sub("sim_sub_nest_child"),
	simTool("toolu_sim_nest_child_grep", "Grep", simRaw(`{"pattern":"max_attempts","path":"internal/config"}`)).sub("sim_sub_nest_child"),
	simToolOut("toolu_sim_nest_child_grep", "internal/config/config.go:88: MaxAttempts int").sub("sim_sub_nest_child"),
	simTool("toolu_sim_nest_child_read", "Read", simRaw(`{"file_path":"internal/config/config.go","offset":84,"limit":12}`)).sub("sim_sub_nest_child"),
	simToolOut("toolu_sim_nest_child_read", "\t// Retry caps how many times a transient upload failure is retried.\n\tMaxAttempts int").sub("sim_sub_nest_child"),
	simTool("toolu_sim_nest_child_grep2", "Grep", simRaw(`{"pattern":"cfg.Retry.MaxAttempts","path":"internal"}`)).sub("sim_sub_nest_child"),
	simToolOut("toolu_sim_nest_child_grep2", "internal/artifacts/upload.go:22:\tmax := cfg.Retry.MaxAttempts").sub("sim_sub_nest_child"),
	simSay("msg_sim_nest_child_2", "Retry settings are parsed at internal/config/config.go:88 (MaxAttempts); nothing validates a zero/negative cap.").sub("sim_sub_nest_child"),
	// The parent stopped (waiting on its child) -> the harness notified
	// "finished" prematurely, and again for real further down. Both collapse to
	// this one event.
	simSubCompleted("sim_sub_nest"),
	simSubCompleted("sim_sub_nest_child"),
	simTool("toolu_sim_nest_read2", "Read", simRaw(`{"file_path":"internal/config/config.go","offset":80,"limit":20}`)).sub("sim_sub_nest"),
	simToolOut("toolu_sim_nest_read2", "type Retry struct {\n\tMaxAttempts int\n\tBase        string\n}").sub("sim_sub_nest"),
	simTool("toolu_sim_nest_bash", "Bash", simRaw(`{"command":"go test ./internal/config/ -run TestRetryDefaults","description":"Check the config defaults are covered"}`)).sub("sim_sub_nest"),
	simToolOut("toolu_sim_nest_bash", "testing: warning: no tests to run\nPASS\nok  \tgithub.com/trolleyman/hydra/internal/config\t0.004s [no tests to run]").sub("sim_sub_nest"),
	simTool("toolu_sim_nest_grep2", "Grep", simRaw(`{"pattern":"MaxAttempts <= 0","path":"internal"}`)).sub("sim_sub_nest"),
	simToolErr("toolu_sim_nest_grep2", "No matches found").sub("sim_sub_nest"),
	simSay("msg_sim_nest_3", "Audit complete: the uploader retries with jittered backoff (internal/artifacts/backoff.go), config caps it via MaxAttempts (internal/config/config.go:88), and the unvalidated zero cap is the one real gap.").sub("sim_sub_nest"),
	// A chained command with a description: the collapsed card shows the
	// description, the expanded card the ;/&&-split highlighted script. Its
	// result lands much further down (an ANSI failure), so the card also proves a
	// tool can stay open across a stretch of conversation.
	simTool("toolu_sim_2", "Bash", simRaw(`{"command":"go vet ./internal/artifacts/ && go test ./internal/artifacts/ -run TestPutRetry -count=1; echo exit=$?","description":"Vet the package and run the retry test"}`)),
	// The shape agents write constantly: a `cd <worktree>` no-op, a subshell that
	// ignores a failure, and a heredoc carrying a throwaway script. The card drops
	// the no-op cd, splits the chain, keeps the subshell on one line, and leaves
	// the heredoc body exactly as written (semicolons and all).
	simTool("toolu_sim_heredoc", "Bash", simRaw(`{"command":"cd /repo/.hydra/local/worktrees/feat-uploader-retry && (fuser -k 26788/tcp >/dev/null 2>&1; true) && cd web && cat > scripts/probe.ts <<'EOF'\nimport { chromium } from 'playwright'\nconst page = await (await chromium.launch()).newPage()\nawait page.goto('http://localhost:26788/')\nconsole.log(await page.title());\nEOF\nnode scripts/probe.ts && echo done","description":"Probe the rendered page with a throwaway script"}`)),
	simToolOut("toolu_sim_heredoc", "Hydra\ndone"),
	// Where that command left the shell, READ off the CLI's transcript by the
	// daemon (internal/chat/shellcwd.go) rather than worked out from the script.
	// The chat prefers it over its own walk of the `cd`s, which is a fallback
	// for logs recorded before this existed.
	simShellCwd("toolu_sim_heredoc", "/repo/.hydra/local/worktrees/feat-uploader-retry/web"),
	// The command after it: the shell is STILL in web/ (one shell per session),
	// which is why this runs a bare `bun test` - so the card shows the tracked
	// `cd web` above it. Without that line the command reads as if it ran at the
	// worktree root, where it would not work at all.
	simTool("toolu_sim_cwd", "Bash", simRaw(`{"command":"bun test src/lib/upload.test.ts","description":"Run the uploader tests"}`)),
	simToolOut("toolu_sim_cwd", " 12 pass\n  0 fail"),
	// A Bash call that is really a Read - the shape every agent without a Read
	// tool has to spell in shell. The card stays a Bash card, showing the command
	// that ran, and its output renders as numbered, Go-highlighted source rather
	// than anonymous terminal text - see web/src/lib/fileViewCommand.ts.
	simTool("toolu_sim_sed", "Bash", simRaw(`{"command":"sed -n 40,53p internal/chat/claude.go"}`)),
	simToolOut("toolu_sim_sed", "type claudeMessage struct {\n\tType    string          `json:\"type\"`\n\tSubtype string          `json:\"subtype,omitempty\"`\n\tMessage json.RawMessage `json:\"message,omitempty\"`\n\tUsage   json.RawMessage `json:\"usage,omitempty\"`\n}\n\n// isAPIErrorMessage reports whether an assistant event is the CLI's own\n// \"API Error\" placeholder rather than a model reply.\nfunc isAPIErrorMessage(msg claudeMessage) bool {\n\tif msg.Type != \"assistant\" {\n\t\treturn false\n\t}\n\treturn strings.HasPrefix(text(msg), \"API Error\")"),
	// Two reads in one call, separated by the `echo` marker agents use to tell
	// them apart. The card splits the output back at that marker and gives each
	// file its own numbered block.
	simTool("toolu_sim_sed2", "Bash", simRaw(`{"command":"sed -n 1,4p web/src/lib/lineRange.ts; echo '--- 8< ---'; sed -n 10,16p web/src/lib/lineRange.ts"}`)),
	simToolOut("toolu_sim_sed2", "// Line-range selection shared by the repository file view and the diff viewer:\n// a URL hash like #L5 (one line) or #L5-L10 (a range), GitHub-style. start is\n// always <= end.\n\n--- 8< ---\nexport function parseLineRange(hash: string): LineRange | null {\n  const m = /^#?L(\\d+)(?:-L?(\\d+))?/.exec(hash || '')\n  if (!m) return null\n  const a = parseInt(m[1], 10)\n  const b = m[2] ? parseInt(m[2], 10) : a\n  return { start: Math.min(a, b), end: Math.max(a, b) }\n}"),
	// An investigation script: a `cd`, greps, a tail, and the `echo` headings an
	// agent writes between them. Not a pure read, so the card stays a Bash card -
	// but its OUTPUT is split back at those headings and each stretch rendered as
	// what produced it: grep's own line numbers in the gutter with the file's
	// language, the tail highlighted as markdown, the headings coloured as the
	// strings they are. See web/src/lib/shellSections.ts.
	// The bare `echo`s are the spacing ones an agent writes between its sections:
	// too short to anchor on, but a step of known length all the same, which is
	// what lets the search ABOVE each one keep its own lines.
	simTool("toolu_sim_probe", "Bash", simRaw(`{"command":"cd /repo/.hydra/local/worktrees/feat-uploader-retry\ngrep -n \"rclone\" mise/config.toml || echo \"no rclone in mise/config.toml\"\necho \"=== retry helpers ===\"\ngrep -n \"backoff\\\\|attempt\" internal/artifacts/upload.go | head\necho\necho \"=== docs tail ===\"\ntail -6 docs/artifacts.md\necho\necho \"=== docs headings ===\"\ngrep -n '^#' docs/artifacts.md","description":"Check rclone config, the retry helpers and the docs structure"}`)),
	simToolOut("toolu_sim_probe", "no rclone in mise/config.toml\n=== retry helpers ===\n88:// sleepBackoff waits out the jittered exponential delay for one attempt.\n100:func sleepBackoff(attempt int) {\n101:\tbase := 100 * time.Millisecond\n102:\td := base << attempt\n118:\tfor attempt := 0; attempt < maxAttempts; attempt++ {\n\n=== docs tail ===\nArtifacts are generated per head and diffed against the base ref, so a run\nonly uploads what actually changed.\n\n## TODO\n- Retry the upload on a 5xx\n- Surface the attempt count in the panel\n\n=== docs headings ===\n1:# Artifacts\n12:## Generating\n40:## TODO"),
	// The same sectioning over the OTHER two shapes it knows. git reporting on
	// the repository (a short status, a commit header, a diffstat) is coloured
	// the way git's own porcelain colours it - see web/src/lib/gitOutput.ts - and
	// the last step's `| grep -v` only drops lines, so what survives is still the
	// search's matches and still gets the gutter and the file's language.
	simTool("toolu_sim_gitprobe", "Bash", simRaw(`{"command":"git status --short\necho \"== merge commit contents ==\"\ngit show --stat HEAD | tail -12\necho \"== remaining callers ==\"\ngrep -rn \"sleepBackoff\" internal | grep -v _test.go | head -5","description":"Check the worktree, the merge commit and who still calls the helper"}`)),
	simToolOut("toolu_sim_gitprobe", " M internal/artifacts/upload.go\nA  internal/artifacts/backoff.go\n?? scratch/probe.ts\n== merge commit contents ==\ncommit 5d671ab0a7401035 (HEAD -> hydra/retry-uploads)\nMerge: 5d671ab0 a7401035\nAuthor: Callum Tolley <cgtrolley@gmail.com>\nDate:   Wed Jul 29 12:00:47 2026 +0100\n\n    Merge branch 'main'\n\n docs/artifacts.md              |  7 +-\n internal/artifacts/backoff.go  | 15 +++++++\n internal/artifacts/upload.go   | 32 ++++++++------\n 3 files changed, 45 insertions(+), 9 deletions(-)\n== remaining callers ==\ninternal/artifacts/upload.go:119:\t\tsleepBackoff(attempt)\ninternal/artifacts/backoff.go:9:func sleepBackoff(attempt int) {"),
	// Two git reports back to back with no separator, the second of which printed
	// NOTHING - `git stash list` with no stashes. Neither is bounded by anything
	// the script says, so the boundary between them is not knowable; it also does
	// not matter, since lib/gitOutput reads the shape off the line. They are one
	// producer, and the diffstat keeps git's colours rather than the card falling
	// back to a wall of terminal text over a boundary nobody needed.
	simTool("toolu_sim_gitpair", "Bash", simRaw(`{"command":"git diff --stat\ngit stash list","description":"Review the full working diff"}`)),
	simToolOut("toolu_sim_gitpair", " internal/artifacts/backoff.go  |  15 +++++++\n internal/artifacts/upload.go   |  32 ++++++++------\n internal/http/simulation.go    |   6 ++\n docs/artifacts.md              |   7 +-\n 4 files changed, 52 insertions(+), 12 deletions(-)"),
	// The "where am I" script, and the one bound that saves it. It has no
	// separator in it, and it ends on a build command web/src/lib/shellSections
	// can say nothing at all about - so the only thing standing between the git
	// report at the top and one undifferentiated wall of terminal text is the
	// `| tail -2`, which says the build printed two lines and no more. See
	// ScriptStep.cap.
	simTool("toolu_sim_gitwhere", "Bash", simRaw(`{"command":"git status --short\ngit log --oneline -3\nmage build 2>&1 | tail -2","description":"Check the worktree, the last few commits and that it still builds"}`)),
	simToolOut("toolu_sim_gitwhere", " M internal/artifacts/upload.go\n?? scratch/probe.ts\na56e8a7d Merge branch 'main'\nd10b2b2c Stop spending a model turn on a resolved comment\n2672df7c Merge branch 'main'\n--- Done ---\n$ go build ./..."),
	// Two searches of the same file back to back, with no separator between them
	// - the second asking a narrower question than the first. Where one's matches
	// stop and the other's start is not knowable, but it does not need to be:
	// both stretches are lines of the file they name, so the pair renders as one
	// section with grep's `-A` context lines numbered alongside the matches.
	simTool("toolu_sim_ctxprobe", "Bash", simRaw(`{"command":"grep -n \"func (u \\*Uploader) Put\" -A 6 internal/artifacts/upload.go\ngrep -n \"func sleepBackoff\" -A 4 internal/artifacts/backoff.go\necho \"=== sim ===\"\ngrep -n \"func simUpload\" -A 3 internal/http/simulation.go","description":"Check whether the uploader can retry"}`)),
	simToolOut("toolu_sim_ctxprobe", "112:func (u *Uploader) Put(ctx context.Context, key string, r io.Reader) error {\n113-\tvar err error\n114-\t// The reader is replayed per attempt, so it has to be seekable.\n115-\tfor attempt := 0; attempt < maxAttempts; attempt++ {\n116-\t\tif err = u.put(ctx, key, r); err == nil {\n117-\t\t\treturn nil\n118-\t\t}\n9:func sleepBackoff(attempt int) {\n10-\tbase := 100 * time.Millisecond\n11-\td := base << attempt\n12-\tjitter := time.Duration(rand.Int63n(int64(d / 2)))\n13-\ttime.Sleep(d/2 + jitter)\n=== sim ===\n41:func simUpload(key string) simResult {\n42-\treturn simResult{Key: key, Bytes: 4096}\n43-}"),
	// The ignore family, end to end. A `.gitignore` is a file of PATTERNS, so it
	// is highlighted as one (web/src/lib/ignoreHighlight.ts): the negation and
	// the wildcards are marked and the path text is left alone. The
	// `git check-ignore -v` at the end prints the rule that caught each path -
	// coloured by web/src/lib/gitOutput.ts, with the pattern itself in those same
	// ignore colours, so a `*` reads as a wildcard wherever it turns up.
	simTool("toolu_sim_ignore", "Bash", simRaw(`{"command":"sed -n '12,18p' .gitignore\necho \"=== web/public/fonts/.gitignore ===\"\ncat web/public/fonts/.gitignore\necho \"=== which rule catches them ===\"\ngit check-ignore -v web/public/fonts/iosevka-400-normal.woff2 web/.iosevka-build.json","description":"Read both ignore files, and ask git which rule wins"}`)),
	simToolOut("toolu_sim_ignore", "# Self-hosted webfonts (Iosevka, the Nerd Fonts symbol fallback).\n# Not committed - `cd web && npm run build-fonts` fetches them.\n/web/public/fonts/iosevka-*.woff2\n/web/public/fonts/nerd-symbols-*.woff2\n/web/public/fonts/google.css\n/web/public/fonts/google/\n/web/.iosevka-build.json\n=== web/public/fonts/.gitignore ===\n# Generated font files - see web/scripts/build-fonts.ts.\niosevka-*.woff2\n!iosevka-400-normal.woff2\ngoogle.css\ngoogle/\n=== which rule catches them ===\nweb/public/fonts/.gitignore:2:iosevka-*.woff2\tweb/public/fonts/iosevka-400-normal.woff2\n.gitignore:18:/web/.iosevka-build.json\tweb/.iosevka-build.json"),
	// A `du` sorted biggest-first, and a search of a whole DIRECTORY. The sizes
	// are marked against the paths they measure (web/src/lib/diskOutput.ts); the
	// `| sort` in front of the `| head` is a filter that reorders lines and
	// leaves them byte for byte. The search names one operand and prints a
	// `path:` in front of every line, which is what says where each line came
	// from and which language to colour it as.
	simTool("toolu_sim_du", "Bash", simRaw(`{"command":"du -sh ~/.cache/* 2>/dev/null | sort -rh | head -5\necho \"=== who reads the cache dir ===\"\nrg \"CacheDir\" internal/ | head -3","description":"Check what sharing ~/.cache actually buys"}`)),
	simToolOut("toolu_sim_du", "18G\t/home/callum/.cache/go\n2.5G\t/home/callum/.cache/Google\n658M\t/home/callum/.cache/aube\n646M\t/home/callum/.cache/ms-playwright\n484M\t/home/callum/.cache/uv\n=== who reads the cache dir ===\ninternal/paths/paths.go:func CacheDir(root string) string {\ninternal/heads/seed.go:\tcache := paths.CacheDir(root)\ninternal/sandbox/linux.go:\t\tro = append(ro, paths.CacheDir(o.Root))"),
	// A script whose output can NOT be sectioned - every step is a build command
	// this cannot describe, and the log carries ANSI colour, where a section
	// boundary would be a guess. The `echo` headings in it are still the strings
	// the script says they are, so they are still coloured as such: they are the
	// reader's only map of a long build log.
	simTool("toolu_sim_buildlog", "Bash", simRaw(`{"command":"echo \"=== run 1 (should be no-op) ===\"\nmage build 2>&1 | head -4\necho \"=== touch a web file, run 2 ===\"\ntouch web/src/main.tsx\nmage build 2>&1 | head -4","description":"Test whether BuildWeb emits output when web changed"}`)),
	simToolOut("toolu_sim_buildlog", "=== run 1 (should be no-op) ===\n\x1b[2m$ mage build\x1b[0m\n\x1b[32m✓\x1b[0m go build: up to date\n\x1b[32m✓\x1b[0m web build: up to date\n=== touch a web file, run 2 ===\n\x1b[2m$ mage build\x1b[0m\n\x1b[33mWARN\x1b[0m web/dist is stale - rebuilding\nvite v8.1.5 \x1b[32mbuilding for production...\x1b[0m\n\x1b[32m✓\x1b[0m 412 modules transformed."),
	// One read, several stretches of one file - how an agent quotes the places it
	// is about to edit. Each stretch is numbered from its own start.
	simTool("toolu_sim_sedmulti", "Bash", simRaw(`{"command":"sed -n '1,3p;40,43p' docs/artifacts.md"}`)),
	simToolOut("toolu_sim_sedmulti", "# Artifacts\n\nArtifacts are files a head produces that are worth keeping: screenshots, a\n## TODO\n- Retry the upload on a 5xx\n- Surface the attempt count in the panel\n- Collect the generator's own log"),
	// A test run and a build, which is the output an agent stares at hardest.
	// Neither is attributable to a command - the same diagnostics come out of
	// `go build`, `mage`, `make` or a test runner - so they are read by the LINE
	// (web/src/lib/buildOutput.ts): the location says where, the verdict says
	// whether it passed, and the prose between them stays prose.
	simTool("toolu_sim_tests", "Bash", simRaw(`{"command":"go test ./internal/artifacts/ ./internal/chat/ 2>&1 | head -12\necho \"=== and the frontend ===\"\ncd web && aube run lint 2>&1 | tail -4","description":"Run the tests and the frontend typecheck"}`)),
	simToolOut("toolu_sim_tests", "=== RUN   TestPutRetry\n    upload_test.go:41: expected 5 attempts, got 1\n--- FAIL: TestPutRetry (0.02s)\nFAIL\ngithub.com/trolleyman/hydra/internal/artifacts\t0.512s\nok  \tgithub.com/trolleyman/hydra/internal/chat\t0.606s\n?   \tgithub.com/trolleyman/hydra/internal/tui\t[no test files]\n=== and the frontend ===\nweb/src/lib/upload.ts:42:11: error TS2345: Argument of type 'number' is not assignable to parameter of type 'string'.\nweb/src/lib/upload.ts:58:3: warning: 'attempt' is assigned a value but never used\nFound 2 errors in 1 file."),
	// A `head`/`tail` over SEVERAL files. The `==> name <==` banners say which
	// stretch is which - better than the command does, since its operands are a
	// glob - so each stretch is highlighted as the file its banner names and
	// numbered from the line the command asked for.
	simTool("toolu_sim_banners", "Bash", simRaw(`{"command":"head -4 internal/artifacts/*.go","description":"Skim the top of each artifacts file"}`)),
	simToolOut("toolu_sim_banners", "==> internal/artifacts/backoff.go <==\npackage artifacts\n\nimport (\n\t\"math/rand\"\n\n==> internal/artifacts/upload.go <==\npackage artifacts\n\nimport (\n\t\"context\""),
	// A blame, and the two disk listings. A blame prints the FILE, so it keeps
	// its own line numbers and its language behind git's prefix; `df` and `ls -l`
	// are tables whose measurement column is the point (web/src/lib/diskOutput.ts).
	simTool("toolu_sim_blame", "Bash", simRaw(`{"command":"git blame -L 9,12 internal/artifacts/backoff.go\necho \"=== room left on the disk ===\"\ndf -h /\necho \"=== and what is in there ===\"\nls -l internal/artifacts/","description":"Check who wrote the backoff, and what is left on disk"}`)),
	simToolOut("toolu_sim_blame", "5d671ab0 (Callum Tolley 2026-07-29 12:00:47 +0100  9) func sleepBackoff(attempt int) {\n5d671ab0 (Callum Tolley 2026-07-29 12:00:47 +0100 10) \tbase := 100 * time.Millisecond\na7401035 (Callum Tolley 2026-07-29 16:57:41 +0100 11) \td := base << attempt\na7401035 (Callum Tolley 2026-07-29 16:57:41 +0100 12) \tjitter := time.Duration(rand.Int63n(int64(d / 2)))\n=== room left on the disk ===\nFilesystem      Size  Used Avail Use% Mounted on\n/dev/nvme0n1p2  1.8T  1.2T  522G  70% /\n=== and what is in there ===\ntotal 24\n-rw-rw-r-- 1 callum callum  4096 Jul 29 16:57 backoff.go\n-rw-rw-r-- 1 callum callum 12288 Jul 29 16:57 upload.go"),
	// What a search says ABOUT the files rather than what it found in them: a
	// count per file, then the files that matched (web/src/lib/searchSummary.ts).
	simTool("toolu_sim_summary", "Bash", simRaw(`{"command":"grep -rc \"sleepBackoff\" internal/artifacts\necho \"=== which files mention it at all ===\"\nrg -l \"sleepBackoff\" internal | sort","description":"Count the callers, then list the files"}`)),
	simToolOut("toolu_sim_summary", "internal/artifacts/backoff.go:1\ninternal/artifacts/upload.go:3\ninternal/artifacts/store.go:0\n=== which files mention it at all ===\ninternal/artifacts/backoff.go\ninternal/artifacts/upload.go\ninternal/http/simulation.go"),
	// A run of steps hung off one `cd`, wrapped in a `{ ... }` group - which is
	// how an agent writes that, and which used to be read as ONE opaque producer,
	// burying the `echo` heading inside it and costing every step in the group its
	// attribution. The group stands on its own as a step of the script, so its
	// contents ARE the steps.
	//
	// The lines come out of a `.log`, which Prism has a grammar for: the
	// timestamps, the levels and the paths in the message are the furniture, and
	// marking them is most of what makes a wall of log readable. The last line is
	// the Bash tool's own note that it put the shell back where it started - no
	// step printed that, so it reads as the harness note it is.
	simTool("toolu_sim_group", "Bash", simRaw(`{"command":"cd /home/callum/code/hydra/hydra-stalls 2>/dev/null &&\n{ grep -E \"STALL|done -\" watch.log | tail -12\necho \"=== captures ===\"\nls -d stall-* 2>/dev/null\n}","description":"Check for new watch captures"}`)),
	simToolOut("toolu_sim_group", "15:13:42 STALL: io full avg10=5.03% - capturing 1/5 into stall-20260730-151342\n15:18:42 done - /home/callum/code/hydra/hydra-stalls/stall-20260730-151342\n15:20:16 STALL: io full avg10=11.79% - capturing 2/5 into stall-20260730-152016\n=== captures ===\nstall-20260730-151342\nstall-20260730-152016\nShell cwd was reset to /home/callum/code/hydra/.hydra/local/worktrees/feat-uploader-retry"),
	// A script whose last step FAILED, which is most of the scripts an agent
	// writes about a file it turns out not to have. The stderr mixed into the
	// output is the only part of it that announces who wrote it (`sed: ...`), so
	// those lines are taken out of the attribution and coloured as the errors
	// they are (web/src/lib/buildOutput.ts): the searches above keep their gutter,
	// their lowlit paths and their Go highlighting, the heading is still the
	// string the script printed, and the read that died claims none of it -
	// rather than the whole card falling back to one wall of terminal text
	// because one step of it went wrong.
	//
	// The two searches also print DIFFERENT prefixes - the first names one file
	// so grep numbers its lines bare (`9:`), the second names two so every line
	// carries its own path - and they are one section, which is what
	// parseMatchLines reads both shapes for.
	simTool("toolu_sim_failedstep", "Bash", simRaw(`{"command":"rg -n \"sleepBackoff\" internal/artifacts/backoff.go | head -3\nrg -n \"sleepBackoff\" -A2 internal/artifacts/upload.go internal/artifacts/store.go\necho ===\nsed -n 1,40p internal/artifacts/retry.go","description":"Find the backoff callers, then read the retry helper"}`)),
	simToolErr("toolu_sim_failedstep", "Exit code 2\n9:func sleepBackoff(attempt int) {\n11:\td := base << attempt // sleepBackoff doubles it per attempt\ninternal/artifacts/upload.go:88:// sleepBackoff waits out the jittered exponential delay for one attempt.\ninternal/artifacts/upload.go:119:\t\tsleepBackoff(attempt)\ninternal/artifacts/upload.go-120-\t\tif err = u.put(ctx, key, r); err == nil {\ninternal/artifacts/upload.go-121-\t\t\treturn nil\n===\nsed: can't read internal/artifacts/retry.go: No such file or directory"),
	// ANSI-coloured output: the chat renders the SGR codes as colours/styles
	// rather than raw escape garbage (item 20). This settles the chained command
	// opened well above.
	simToolErr("toolu_sim_2", "[2m$ go vet ./internal/artifacts/ && go test ./internal/artifacts/[0m\n[31m--- FAIL: TestPutRetry[0m (0.02s)\n    [2mupload_test.go:41:[0m expected [1m5[0m attempts, got [1m1[0m\n[31mFAIL[0m\texit=1"),
	// A turn-ending message carrying usage + stop_reason: the chat synthesizes a
	// per-turn footer from it, showing "↓ N tokens" with the full input/cache
	// breakdown on hover. Mirrors the real shape - one event PER CONTENT BLOCK
	// (an empty silent-reasoning thinking block, then the text), each carrying
	// the same envelope. The chat must count the usage once and render ONE footer
	// at the turn boundary, not one per event interleaved around the text.
	simThink("msg_sim_4", "").
		set("usage", simRaw(`{"input_tokens":210,"output_tokens":845,"cache_read_input_tokens":18200,"cache_creation_input_tokens":512}`)).
		set("stop_reason", "end_turn"),
	simSay("msg_sim_4", "The new test fails as expected against the old code - now wiring the backoff loop in:\n\n```go\nfor attempt := 0; attempt < maxAttempts; attempt++ {\n    if err = u.put(ctx, key, r); err == nil {\n        return nil\n    }\n    sleepBackoff(attempt)\n}\n```\n\nThe resulting backoff schedule:\n\n| Attempt | Base delay | With jitter | Outcome |\n| ------- | ---------: | :---------: | ------- |\n| 1 | 100ms | 50-150ms | retry |\n| 2 | 200ms | 100-300ms | retry |\n| 3 | 400ms | 200-600ms | retry |\n| 4 | 800ms | 400-1200ms | retry |\n| 5 | 1600ms | 800-2400ms | give up, surface last error |\n\nHere is the probe I timed it with - a ```bash block carrying two OTHER languages inside it, which is what the embedded-language highlighting (web/src/lib/shellEmbed.ts) exists for: the inline Python and the `PY` heredoc colour as Python, while the quoted-delimiter heredoc stays inert text instead of lighting up `if`/`then`/`echo` as shell keywords.\n\n```bash\npython3 -c 'import json, sys\nfor line in sys.stdin:\n    e = json.loads(line)\n    if e[0] == 1:\n        print(e)'\n\ncat <<PY > /tmp/probe.py\nimport os\nprint(os.getcwd())\nPY\n\ncat <<'EOF'\nPlain text: the words if, then, echo and printf are not shell here.\nEOF\n```\n\nDone - the retry loop is in and `TestPutRetry` passes. Anything else you'd like covered?").
		set("usage", simRaw(`{"input_tokens":210,"output_tokens":845,"cache_read_input_tokens":18200,"cache_creation_input_tokens":512}`)).
		set("stop_reason", "end_turn"),
	// An interrupted turn: the user stops the reply mid-stream. The chat renders
	// the interruption chip plus a QUIET footer, not an error box - the chip
	// already tells the story.
	simUser("sim-int-user", "Hold on - could you also make the attempt cap configurable?"),
	simSay("msg_sim_int", "Sure - I'll thread a MaxAttempts option through the uploader config and"),
	simTurnInterrupted(),
	simTurnFailed(),
	// The head was stopped there and attached again later, so the process - and
	// the conversation in it - was restored from the transcript. Drawn as a rule
	// across the chat, because the break is otherwise invisible and it decides
	// what survives: the Bash tool's shell is a new one, back at the worktree.
	simSessionResumed("/repo/.hydra/local/worktrees/feat-uploader-retry"),
	// A user turn that referenced an uploaded image + the CLI's image
	// placeholder: renders as an attachment chip, not a raw path/placeholder
	// (items 41, 43). The CLI's own downscale note is filtered upstream, so
	// nothing appears for it.
	simUser("sim-upload", "Here is the mock, what do you think?\n\n/home/callum/code/hydra/.hydra/local/uploads/1783466659236080610-image1.png\n[Image: original 800x600, displayed at 400x300. Multiply coordinates by 2 to map to original image.]"),
	simSay("msg_sim_5", "Looks good - the layout reads clearly."),
	// An assistant reply that embeds screenshots IT took, by the paths it wrote
	// them to (inside the head's private /tmp). The chat markdown renderer
	// resolves those through the agent-files endpoint and shows the pictures
	// inline - see MarkdownImage / HandleAgentFileBlob. TWO of them, which is the
	// real shape of a before/after report and what makes the lightbox a gallery:
	// the two are one message, so left/right step between them and stop there
	// (see lib/markdownGallery).
	simSay("msg_sim_shot", "I drove the built app to check it renders:\n\n![The popover, before](/tmp/hydra-sim/popover-before@2x.png)\n\n![The popover, rendered](/tmp/hydra-sim/popover@2x.png)\n\nNo console errors."),
	// The same markdown syntax pointing at a RECORDING rather than a still: the
	// renderer picks a <video> over an <img> off the extension and the same
	// agent-files endpoint serves it (see MarkdownRenderer.MarkdownMedia /
	// HandleAgentFileBlob). A still can't show a transition, so this is how an
	// agent demos one.
	simSay("msg_sim_clip", "And the transition itself, recorded while the popover opens:\n\n![The popover opening](/tmp/hydra-sim/popover-open.webm)\n\nIt settles in about 200ms."),
	// A background Bash command plus its completion notification. The CLI writes
	// that notification twice (a queue-operation record and an attachment); only
	// the attachment carries a uuid, so both survive normalization and the client
	// dedups the pair by content into ONE notice chip. It carries an
	// <output-file>, so the chip expands to show the command's output (answered
	// by the sim's task_output handler).
	simTool("toolu_sim_bgcmd", "Bash", simRaw(`{"command":"go test ./... 2>&1","description":"Run the full test suite","run_in_background":true}`)),
	simToolOut("toolu_sim_bgcmd", "Command running in background with ID: bash_sim_bg1. Output is being written to: /tmp/claude-1000/sim-project/sim-chat/tasks/bash_sim_bg1.output. You will be notified when it completes. To check interim output, use Read on that file path."),
	// A ScheduleWakeup while waiting on the background run: its prompt is PROSE,
	// so the collapsed header shows it in the sans font, not monospace.
	simTool("toolu_sim_wakeup", "ScheduleWakeup", simRaw(`{"delaySeconds":1500,"prompt":"Fallback wakeup: check on the background test run and report the outcome.","reason":"Fallback in case the completion notification doesn't arrive"}`)),
	simToolOut("toolu_sim_wakeup", "Next wakeup scheduled for 21:25:00 (in 1500s). Nothing more to do this turn - the harness re-invokes you when the wakeup fires or a task-notification arrives."),
	simNotice(simBackgroundCmdNotification),
	simNotice(simBackgroundCmdNotification),
	// A long Read near the bottom of the conversation: its output overflows the
	// card's capped panel (so the panel gets its OWN scrollbar), and one source
	// line is far wider than the pane (so the gutter panel's per-line wrapping
	// shows). Exercises pinned-at-bottom follow while such a card expands.
	simTool("toolu_sim_long", "Read", simRaw(`{"file_path":"internal/artifacts/upload_test.go"}`)),
	simToolOut("toolu_sim_long", "     1\tpackage artifacts\n     2\t\n     3\timport (\n     4\t\t\"context\"\n     5\t\t\"errors\"\n     6\t\t\"net/http\"\n     7\t\t\"net/http/httptest\"\n     8\t\t\"strings\"\n     9\t\t\"testing\"\n    10\t)\n    11\t\n    12\t// flakyServer fails the first n PUTs with a 503, then succeeds - the shape of a transient outage the retry loop exists for, so every test in this file drives the uploader through it rather than stubbing the client.\n    13\tfunc flakyServer(t *testing.T, failures int) *httptest.Server {\n    14\t\tn := 0\n    15\t\treturn httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {\n    16\t\t\tif n < failures {\n    17\t\t\t\tn++\n    18\t\t\t\tw.WriteHeader(http.StatusServiceUnavailable)\n    19\t\t\t\treturn\n    20\t\t\t}\n    21\t\t\tw.WriteHeader(http.StatusOK)\n    22\t\t}))\n    23\t}\n    24\t\n    25\tfunc TestPutRetry(t *testing.T) {\n    26\t\tsrv := flakyServer(t, 1)\n    27\t\tdefer srv.Close()\n    28\t\tu := NewUploader(srv.URL)\n    29\t\tif err := u.Put(context.Background(), \"k\", strings.NewReader(\"v\")); err != nil {\n    30\t\t\tt.Fatalf(\"expected success after one transient failure, got %v\", err)\n    31\t\t}\n    32\t}\n    33\t\n    34\tfunc TestPutGivesUp(t *testing.T) {\n    35\t\tsrv := flakyServer(t, 10)\n    36\t\tdefer srv.Close()\n    37\t\tu := NewUploader(srv.URL)\n    38\t\terr := u.Put(context.Background(), \"k\", strings.NewReader(\"v\"))\n    39\t\tif !errors.Is(err, ErrExhausted) {\n    40\t\t\tt.Fatalf(\"want ErrExhausted, got %v\", err)\n    41\t\t}\n    42\t}"),
	// A tool call with NO result before the turn ends: it must NOT stay stuck
	// showing "running" once the turn's result arrives / history replays (item 42).
	simTool("toolu_sim_stuck", "Read", simRaw(`{"file_path":"web/src/components/settings/NotificationsSection.tsx"}`)),
	simTurnDone(simRaw(`{"input_tokens":312,"output_tokens":1526,"cache_read_input_tokens":21400,"cache_creation_input_tokens":1800}`), 0.2145),
	// This commit lands after that turn's footer, before the closing mini-turn.
	simCommit("beefcafe0123456789abcdef0123456789abcdef", "beefcaf", "Cover the giving-up path with a test", "2026-07-09T18:05:30.000Z"),
	// ... and then the branch took main in, by fast-forward.
	simBaseUpdate("2026-07-09T18:05:40.000Z"),
	// A sibling head's attributed collaboration message. It stays on the user
	// side because it is input to this agent, but carries its own sender marker.
	simAgentUser("sim-agent-message", "api-tests", "[Message from Hydra agent api-tests (API test coverage); correlation_id=agent-chain-demo; message_id=agent-message-demo; chain=1/6]\n\nThe retry endpoint contract tests are ready in commit 9f24c10. Please cherry-pick it before your final verification."),
	simSay("msg_sim_agent_reply", "Got it. I will incorporate `9f24c10` and keep the shared correlation id if I need to reply."),
	// A standalone reply that is mostly an ordered list - exercises the block
	// markdown renderer's <ol> styling (list-decimal, pl-5) so the demo proves
	// 1./2./3. indent with hanging wrapped lines, and a trailing unordered list
	// shows bullets indent the same way.
	simUser("sim-recap", "Recap what changed - numbered.").at("2026-07-09T18:06:00.000Z"),
	simSay("msg_sim_list", "All three changes are in:\n\n1. **Retry loop** - wrapped `Put` in a bounded backoff loop that stops after 5 attempts and returns early on the first success, so a transient failure no longer sinks the whole upload.\n2. **Jitter** - each delay carries +/- 50% jitter, so a burst of clients that all failed at once don't retry in lockstep and stampede the server on the way back up.\n3. **Give-up path** - once the attempts are exhausted the loop surfaces the last error instead of swallowing it, now covered by `TestPutRetry`.\n\nBullets indent the same way:\n\n- base delay doubles each attempt (100ms, 200ms, 400ms...)\n- the cap is configurable through `MaxAttempts`\n\nAll green."),
	simTurnDone(simRaw(`{"input_tokens":180,"output_tokens":260,"cache_read_input_tokens":22100,"cache_creation_input_tokens":256}`), 0.021),
}

// simBackgroundCmdNotification is the completion record the CLI writes for a
// background command - twice, in two different envelopes, which is why it
// appears twice above.
const simBackgroundCmdNotification = "<task-notification>\n<task-id>bash_sim_bg1</task-id>\n<tool-use-id>toolu_sim_bgcmd</tool-use-id>\n<output-file>/tmp/claude-1000/sim-project/sim-chat/tasks/bash_sim_bg1.output</output-file>\n<status>completed</status>\n<summary>Background command \"Run the full test suite\" completed (exit code 0)</summary>\n</task-notification>"

// simOlderChatEvents is a canned run of older conversation, kept OUT of the
// initial window so the load-older infinite scroll has something to page in
// (item 25). Oldest-first, like the log itself.
var simOlderChatEvents = buildSimOlderChatEvents()

func buildSimOlderChatEvents() []simNorm {
	var out []simNorm
	for i := range 20 {
		if i%2 == 0 {
			out = append(out, simUser(fmt.Sprintf("sim-old-%d", i), fmt.Sprintf("Older question #%d - loaded by scrolling up.", i/2+1)))
		} else {
			out = append(out, simSay(fmt.Sprintf("old-m%d", i), fmt.Sprintf("Older reply #%d from earlier in the conversation.", i/2+1)))
		}
		// A commit chip that exists ONLY in the paged-in history, so scrolling up
		// has to place it back among these older messages. Two of them, either
		// side of the halfway mark, because the bug they guard against was an
		// ordering one: chips arriving newest-page-first were appended to a list
		// the interleave reads in order, so every paged-in chip fell out of the
		// merge in one clump at the load boundary instead of at its own place.
		// They must also not animate in - they are backfill, like the messages
		// around them.
		switch i {
		case 6:
			out = append(out, simCommit("0dd0dd0d0123456789abcdef0123456789abcdef", "0dd0dd0", "Sketch the uploader's retry budget", "2026-07-09T17:59:00.007Z"))
		case 14:
			out = append(out, simCommit("1ee1ee1e0123456789abcdef0123456789abcdef", "1ee1ee1", "Pull the backoff constants into one place", "2026-07-09T17:59:00.016Z"))
		}
	}
	return out
}

// simChatLog is the whole durable conversation, older history first, with every
// event sequenced and timestamped the way the store would have.
var simChatLog = simSequence(append(append([]simNorm{}, simOlderChatEvents...), simChatEvents...))

// simChatWindow is how many of the newest events the daemon sends before
// replay_done; the rest are paged in on scroll. Matches pumpChatOutput.
const simChatWindow = 100

// simSequence assigns each event its seq and timestamp, producing the same
// ChatEvent the daemon would have stored. An event with no explicit timestamp
// lands one millisecond after its predecessor, so ordering is stable and the
// commit chips still interleave where their `at` puts them.
func simSequence(events []simNorm) []api.ChatEvent {
	out := make([]api.ChatEvent, 0, len(events))
	cur := time.Date(2026, 7, 9, 17, 59, 0, 0, time.UTC)
	for i, ev := range events {
		if ev.ts != "" {
			if parsed, err := time.Parse(time.RFC3339, ev.ts); err == nil {
				cur = parsed
			}
		} else {
			cur = cur.Add(time.Millisecond)
		}
		payload, err := json.Marshal(ev.payload)
		if err != nil {
			continue
		}
		out = append(out, api.ChatEvent{
			Seq: uint64(i + 1), Type: ev.typ, Timestamp: cur, Payload: payload,
		})
	}
	return out
}

// simChatProjection is the current-state snapshot a chat socket opens with: the
// plan, the "/" autocomplete list and every sub-agent's lifecycle state. Its
// active turn starts before attachment, exercising the restored elapsed clock.
func simChatProjection() api.ChatProjection {
	subagents := map[string]api.ChatSubagentState{}
	for _, ev := range simChatLog {
		var payload struct {
			ID           string `json:"id"`
			ParentID     string `json:"parent_id"`
			ParentItemID string `json:"parent_item_id"`
			AgentType    string `json:"agent_type"`
			Description  string `json:"description"`
			Prompt       string `json:"prompt"`
			Status       string `json:"status"`
		}
		if json.Unmarshal(ev.Payload, &payload) != nil || payload.ID == "" {
			continue
		}
		switch ev.Type {
		case "subagent_started":
			state := api.ChatSubagentState{
				Id: payload.ID, ParentId: payload.ParentID, ParentItemId: payload.ParentItemID,
				AgentType: payload.AgentType, Description: payload.Description,
				Prompt: payload.Prompt, Status: payload.Status,
			}
			// A completion normalized BEFORE the event that introduces the
			// sub-agent (the resumed background case) must still win.
			if prior, ok := subagents[payload.ID]; ok && prior.Status != "" {
				state.Status = prior.Status
			}
			subagents[payload.ID] = state
		case "subagent_completed":
			state := subagents[payload.ID]
			state.Id = payload.ID
			state.Status = "completed"
			subagents[payload.ID] = state
		}
	}
	startedAt := simNow().Add(-42 * time.Second)
	return api.ChatProjection{
		Version:       1,
		Through:       uint64(len(simChatLog)),
		Model:         "claude-opus-4-8",
		SlashCommands: simChatSlashCommands,
		Plan:          simRaw(simChatPlan),
		Subagents:     subagents,
		Turn:          &api.ChatTurnState{Id: "sim-active-turn", Status: "running", StartedAt: &startedAt},
	}
}

// simChatSeqCounter hands live events sequence numbers above the canned log's,
// so a client that reloads mid-session never sees a seq go backwards.
var simChatSeqCounter = struct {
	mu   sync.Mutex
	next int
}{next: len(simChatLog) + 1}

func nextSimChatSeq() int {
	simChatSeqCounter.mu.Lock()
	defer simChatSeqCounter.mu.Unlock()
	simChatSeqCounter.next++
	return simChatSeqCounter.next - 1
}

// sendSimNorm relays one normalized event as a live chat_event frame.
func sendSimNorm(conn *safeConn, ev simNorm) {
	sendSimChatEvent(conn, int64(nextSimChatSeq()), ev.typ, ev.payload)
}

// --- Live streaming -----------------------------------------------------------
//
// A response arrives as deltas that open a preview, then the completed message
// that settles it in place. Usage rides its own events: one carrying a
// message_id opens a message's count, the rest tick it up - which is what the
// live "working" indicator counts.

func simUsageStart(messageID string, inputTokens int) simNorm {
	return simNorm{typ: "usage_updated", payload: map[string]any{
		"message_id": messageID,
		"usage":      map[string]any{"input_tokens": inputTokens, "output_tokens": 1},
	}}
}

func simUsageTick(outputTokens int) simNorm {
	return simNorm{typ: "usage_updated", payload: map[string]any{
		"usage": map[string]any{"output_tokens": outputTokens},
	}}
}

// simStreamText types one reply out word by word, then settles it as the
// completed message - the same block, in place, with no flicker between.
func simStreamText(conn *safeConn, msgID, text string, delay time.Duration) int {
	sendSimNorm(conn, simUsageStart(msgID, 1400))
	tokens := 1
	for chunk := range strings.SplitSeq(text, " ") {
		sendSimNorm(conn, simNorm{typ: "assistant_delta", payload: map[string]any{"message_id": msgID, "text": chunk + " "}})
		tokens += 2
		sendSimNorm(conn, simUsageTick(tokens))
		time.Sleep(delay)
	}
	sendSimNorm(conn, simSay(msgID, text))
	return tokens
}

// simStreamThinking streams a live thinking block, settles it, then emits the
// backend-measured duration so the card lands on "Thought for Xs".
func simStreamThinking(conn *safeConn, msgID, thinking string, dur time.Duration) {
	sendSimNorm(conn, simUsageStart(msgID, 1400))
	sendSimNorm(conn, simNorm{typ: "reasoning_delta", payload: map[string]any{"message_id": msgID, "text": thinking}})
	time.Sleep(dur)
	sendSimNorm(conn, simThink(msgID, thinking))
	sendSimNorm(conn, simThought(msgID, dur.Milliseconds()))
}

// simToolStep emits a tool call, pauses as if it were running, then lands its
// result so the card settles out of the running state. failed marks the result
// an error, so the card lands red (and a fold that swallowed it still reports
// it - see stepSummary in the chat).
func simToolStep(conn *safeConn, toolID, name string, input any, result string, dur time.Duration, failed bool) {
	sendSimNorm(conn, simTool(toolID, name, input))
	time.Sleep(dur)
	if failed {
		sendSimNorm(conn, simToolErr(toolID, result))
		return
	}
	sendSimNorm(conn, simToolOut(toolID, result))
}

// streamSimReply streams a short canned reply and ends the turn - the generic
// answer every simulated chat gives to a message it has no script for.
func streamSimReply(conn *safeConn, msgID, replyText string) {
	// A short live thinking block first, so the card flips "Thinking..." ->
	// "Thought for Xs" live and the duration survives a reload.
	simStreamThinking(conn, msgID, "Reading the request, then drafting the reply.", 1200*time.Millisecond)
	tokens := simStreamText(conn, msgID, replyText, 90*time.Millisecond)
	sendSimNorm(conn, simTurnDone(simRaw(fmt.Sprintf(`{"input_tokens":1200,"output_tokens":%d,"cache_read_input_tokens":9800,"cache_creation_input_tokens":640}`, tokens)), 0.0042))
}

// simChatHistoryPage is the batch of canned history older than cursor (0 =
// newest), oldest-first, with the cursor to ask for next and whether the log's
// start has been reached. Mirrors chat.Store.Before.
func simChatHistoryPage(cursor, limit int) (events []api.ChatEvent, next string, done bool) {
	if limit <= 0 || limit > 500 {
		limit = simChatWindow
	}
	end := len(simChatLog)
	if cursor > 0 && cursor-1 < end {
		end = cursor - 1
	}
	start := max(end-limit, 0)
	events = simChatLog[start:end]
	if len(events) > 0 {
		next = fmt.Sprintf("%d", events[0].Seq)
	}
	return events, next, start == 0
}

// sendSimChatHistory answers the initial window and every load_events_before.
func sendSimChatHistory(conn *safeConn, cursor, limit int) {
	events, next, done := simChatHistoryPage(cursor, limit)
	writeFrame(conn, api.ChatHistoryFrame{
		Type: api.ChatHistory, Events: events, NextCursor: next, Done: done,
	})
}

// sendSimSubagentEvents answers a load_subagent with that sub-agent's own steps,
// wherever they sit in the log - the client opens a sub-agent's tab without
// having paged the main conversation back to where it ran.
func sendSimSubagentEvents(conn *safeConn, subID string) {
	events := []api.ChatEvent{}
	for _, ev := range simChatLog {
		var payload struct {
			AgentID string `json:"agent_id"`
		}
		if json.Unmarshal(ev.Payload, &payload) == nil && payload.AgentID == subID {
			events = append(events, ev)
		}
	}
	writeFrame(conn, api.ChatSubagentEventsFrame{
		Type: api.SubagentEvents, AgentId: subID, Events: events,
	})
}

// handleSimChatWS speaks the chat framing (see chat_ws.go) for the simulated
// chat-mode agent: the state snapshot and newest history window, replay_done,
// then answer each user_message with a scripted turn, so the input path can be
// exercised end to end.
func handleSimChatWS(conn *safeConn) {
	sendStatusUpdate(conn, "running")
	writeFrame(conn, api.ChatStateSnapshotFrame{Type: api.StateSnapshot, State: simChatProjection()})
	sendSimChatHistory(conn, 0, simChatWindow)
	sendReplayDone(conn)
	// Replay any queued messages held from a prior connection (survives a
	// reconnect, like the daemon's persisted queue).
	sendSimQueueFrame(conn, "sim-chat")

	// A model_refusal_fallback: a safety classifier flags a turn under one model,
	// so the CLI streams its blocks live, then RETRACTS them and retries under a
	// fallback model. Those flagged blocks already rendered, so the reducer must
	// evict the retracted ids or they linger as a duplicate at the bottom of the
	// chat. Net-zero when the fix works; a regression leaves FLAGGED-* visible.
	sendSimNorm(conn, simThink("msg_sim_refusal_flagged", "FLAGGED-THINKING: this block should be retracted by the fallback.").set("uuid", "sim-refusal-flagged-think"))
	sendSimNorm(conn, simSay("msg_sim_refusal_flagged", "FLAGGED-TEXT: this reply should be retracted by the fallback.").set("uuid", "sim-refusal-flagged-text"))
	sendSimNorm(conn, simRetracted("sim-refusal-flagged-think", "sim-refusal-flagged-text"))

	turn := 0
	// processTurn echoes one user turn and streams its reply (ending in a turn
	// event). A slash command answers with local output instead.
	processTurn := func(content json.RawMessage, clientID string) {
		turn++
		if clientID == "" {
			clientID = fmt.Sprintf("sim-live-user-%d", turn)
		}
		sendSimChatEvent(conn, int64(nextSimChatSeq()), "user_message", map[string]any{
			"id": clientID, "content": content,
		})
		text := firstTextBlock(content)
		if strings.HasPrefix(text, "/") {
			sendSimNorm(conn, simUserEcho(fmt.Sprintf("sim-live-cmd-%d", turn), fmt.Sprintf("<local-command-stdout>Simulated output of %s.</local-command-stdout>", strings.Fields(text)[0])))
			return
		}
		switch {
		case strings.Contains(strings.ToLower(text), "nested"):
			simLiveNestedRun(conn)
		case strings.Contains(strings.ToLower(text), "subagent"):
			simLiveSubagentRun(conn)
		case strings.Contains(strings.ToLower(text), "background"):
			simLiveBackgroundRun(conn)
		default:
			streamSimReply(conn, fmt.Sprintf("msg_sim_reply_%d", turn), "Simulated reply: message received. This mock streams a few token deltas, then the complete assistant turn.")
		}
	}

	// Per-"!command" stop channels, so a shell_stop frame can cut a streaming run
	// short (mirrors the daemon cancelling the sandboxed process).
	shellStops := map[string]chan struct{}{}
	var shellStopsMu sync.Mutex

	for {
		msg, ok := readSimChatClientMsg(conn)
		if !ok {
			return
		}
		switch msg.Type {
		case "shell_command":
			cmd, id := msg.Command, msg.Id
			stop := make(chan struct{})
			shellStopsMu.Lock()
			shellStops[id] = stop
			shellStopsMu.Unlock()
			go func() {
				defer func() {
					shellStopsMu.Lock()
					delete(shellStops, id)
					shellStopsMu.Unlock()
				}()
				simRunShellCommand(conn, cmd, id, stop)
			}()
		case "shell_stop":
			shellStopsMu.Lock()
			if ch, ok := shellStops[msg.Id]; ok {
				close(ch)
				delete(shellStops, msg.Id)
			}
			shellStopsMu.Unlock()
		case "set_model":
			// The daemon records the change as a model_changed event. The CLI's own
			// "Set model to ..." echo is a plain user line, which normalization
			// drops - the composer's optimistic confirmation is what the user sees.
			sendSimChatEvent(conn, int64(nextSimChatSeq()), "model_changed", map[string]any{"model": msg.Model})
		case "interrupt":
			sendSimNorm(conn, simTurnInterrupted())
			sendSimNorm(conn, simTurnFailed())
			// The daemon treats that as a turn end, so held messages auto-send
			// instead of staying queued (one turn each).
			for _, qm := range simQueuePopAll("sim-chat") {
				processTurn(qm.Content, qm.ID)
			}
		case "dequeue":
			simQueueRemove("sim-chat", msg.Id)
		case "load_events_before":
			cursor := 0
			if _, err := fmt.Sscanf(msg.Cursor, "%d", &cursor); err != nil {
				cursor = 0
			}
			sendSimChatHistory(conn, cursor, msg.Limit)
		case "load_subagent":
			sendSimSubagentEvents(conn, msg.SubId)
		case "task_output":
			// The expandable background-command chip fetching the task's output
			// file (see chat_ws.go sendChatTaskOutput). Canned tail for the demo.
			out := "ok  \tgithub.com/trolleyman/hydra/internal/artifacts\t0.41s\nok  \tgithub.com/trolleyman/hydra/internal/git\t1.02s\nok  \tgithub.com/trolleyman/hydra/internal/heads\t2.35s\nok  \tgithub.com/trolleyman/hydra/internal/http\t3.87s\nok  \tgithub.com/trolleyman/hydra/internal/sandbox\t0.66s\nPASS\nexit=0"
			writeFrame(conn, api.ChatTaskOutputFrame{
				Type: api.ChatTaskOutputFrameTypeTaskOutput, File: msg.File, Content: out,
			})
		case "user_message":
			// A message the client marked queued (a turn was running) is HELD, to
			// be drained when the current turn ends - here, right after the next
			// processed turn, one per turn (each queued message is its own turn).
			if msg.Queued {
				simQueueAppend("sim-chat", simQueuedMsg{ID: msg.Id, Content: msg.Content})
				continue
			}
			processTurn(msg.Content, msg.Id)
			for _, qm := range simQueuePopAll("sim-chat") {
				processTurn(qm.Content, qm.ID)
			}
		}
	}
}

// simLiveSubagentRun plays a LIVE sub-agent: the Task call, the sub-agent
// appearing, a working pause, its inner step settling and its completion -
// exercising the running states and the "finished" notice with its View link.
func simLiveSubagentRun(conn *safeConn) {
	sendSimNorm(conn, simTool("toolu_sim_live_task", "Task", simRaw(`{"description":"Live docs sweep","subagent_type":"Explore","prompt":"Sweep docs/ for retry guidance and report back."}`)))
	sendSimNorm(conn, simSubStarted("sim_sub_live", "toolu_sim_live_task", "Explore", "Live docs sweep", "Sweep docs/ for retry guidance and report back.", ""))
	// An inner tool step that starts "running" and must clear live once its
	// result lands (sub-agent step cards must not stay stuck running).
	sendSimNorm(conn, simTool("toolu_sim_live_grep", "Grep", simRaw(`{"pattern":"backoff","path":"docs"}`)).sub("sim_sub_live"))
	time.Sleep(1500 * time.Millisecond)
	sendSimNorm(conn, simToolOut("toolu_sim_live_grep", "docs/retry.md:12: jittered exponential backoff").sub("sim_sub_live"))
	sendSimNorm(conn, simSay("msg_sim_live_sub_2", "Swept docs/: retry guidance lives in docs/retry.md (jittered exponential backoff); the giving-up path is undocumented.").sub("sim_sub_live"))
	time.Sleep(800 * time.Millisecond)
	// The parent tool result echoes the sub's final message verbatim - the chat
	// must not then show that message twice (once as a step, once as the report).
	sendSimNorm(conn, simToolOut("toolu_sim_live_task", "Swept docs/: retry guidance lives in docs/retry.md (jittered exponential backoff); the giving-up path is undocumented."))
	sendSimNorm(conn, simSubCompleted("sim_sub_live"))
	sendSimNorm(conn, simTurnDone(nil, 0))
}

// simLiveBackgroundRun plays a LIVE background/async sub-agent: the launch, the
// LAUNCHING turn ending while the sub still works (which must NOT settle the
// background card), then the sub's own steps and its completion while the
// parent is idle.
func simLiveBackgroundRun(conn *safeConn) {
	sendSimNorm(conn, simTool("toolu_sim_bg_task", "Task", simRaw(`{"description":"Background docs sweep","subagent_type":"Explore","prompt":"Sweep docs/ in the background and report the retry guidance you find."}`)))
	// The launch boilerplate alone settles nothing - it is what marks the card
	// background in the first place.
	sendSimNorm(conn, simToolOut("toolu_sim_bg_task", "Async agent launched successfully. (This tool result is internal metadata - never quote or paste any part of it into a user-facing reply.)\nagentId: sim_sub_bg (internal ID - do not mention to user.)\nThe agent is working in the background. You will be notified automatically when it completes."))
	sendSimNorm(conn, simSubStarted("sim_sub_bg", "toolu_sim_bg_task", "Explore", "Background docs sweep", "Sweep docs/ in the background and report the retry guidance you find.", ""))
	// The launching turn ends here, while the background sub is still working.
	sendSimNorm(conn, simTurnDone(nil, 0))
	sendSimNorm(conn, simUser("sim-bg-prompt", "Sweep **docs/** in the background and report:\n\n1. Which files mention `backoff`\n2. Whether the *giving-up* path is documented\n\nReturn file paths with line numbers.").sub("sim_sub_bg"))
	sendSimNorm(conn, simTool("toolu_sim_bg_grep", "Grep", simRaw(`{"pattern":"backoff","path":"docs"}`)).sub("sim_sub_bg"))
	time.Sleep(1200 * time.Millisecond)
	sendSimNorm(conn, simToolOut("toolu_sim_bg_grep", "docs/retry.md:12: jittered exponential backoff").sub("sim_sub_bg"))
	sendSimNorm(conn, simSay("msg_sim_bg_2", "Background sweep done: docs/retry.md prescribes jittered exponential backoff; the giving-up path is undocumented.").sub("sim_sub_bg"))
	time.Sleep(1500 * time.Millisecond)
	sendSimNorm(conn, simSubCompleted("sim_sub_bg"))
}

// simLiveNestedRun plays a LIVE nested background run: a background sub-agent
// that spawns its OWN background child, notifies "finished" prematurely while
// the child still runs (the card must read "waiting on sub-agents"), then
// completes for real once the child reports.
func simLiveNestedRun(conn *safeConn) {
	sendSimNorm(conn, simTool("toolu_sim_lnest", "Agent", simRaw(`{"description":"Live nested audit","subagent_type":"general-purpose","prompt":"Audit the retry stack; delegate the config scan to a scout."}`)))
	sendSimNorm(conn, simToolOut("toolu_sim_lnest", "Async agent launched successfully. (This tool result is internal metadata - never quote or paste any part of it into a user-facing reply.)\nagentId: sim_sub_lnest (internal ID - do not mention to user.)\nThe agent is working in the background. You will be notified automatically when it completes."))
	sendSimNorm(conn, simSubStarted("sim_sub_lnest", "toolu_sim_lnest", "general-purpose", "Live nested audit", "Audit the retry stack; delegate the config scan to a scout.", ""))
	sendSimNorm(conn, simTurnDone(nil, 0))
	sendSimNorm(conn, simUser("sim-lnest-prompt", "Audit the retry stack; delegate the config scan to a scout.").sub("sim_sub_lnest"))
	time.Sleep(800 * time.Millisecond)
	sendSimNorm(conn, simTool("toolu_sim_lnest_child", "Agent", simRaw(`{"description":"Live config scan","subagent_type":"scout","prompt":"Find where retry settings are parsed from config."}`)).sub("sim_sub_lnest"))
	sendSimNorm(conn, simToolOut("toolu_sim_lnest_child", "Async agent launched successfully. (This tool result is internal metadata - never quote or paste any part of it into a user-facing reply.)\nagentId: sim_sub_lnest_child (internal ID - do not mention to user.)\nThe agent is working in the background. You will be notified automatically when it completes.").sub("sim_sub_lnest"))
	sendSimNorm(conn, simSubStarted("sim_sub_lnest_child", "toolu_sim_lnest_child", "scout", "Live config scan", "Find where retry settings are parsed from config.", "sim_sub_lnest"))
	sendSimNorm(conn, simSay("msg_sim_lnest_2", "Config scan delegated - waiting on its findings.").sub("sim_sub_lnest"))
	sendSimNorm(conn, simUser("sim-lnest-child-prompt", "Find where retry settings are parsed from config.").sub("sim_sub_lnest_child"))
	sendSimNorm(conn, simTool("toolu_sim_lnest_grep", "Grep", simRaw(`{"pattern":"max_attempts","path":"internal/config"}`)).sub("sim_sub_lnest_child"))
	time.Sleep(2500 * time.Millisecond)
	sendSimNorm(conn, simToolOut("toolu_sim_lnest_grep", "internal/config/config.go:88: MaxAttempts int").sub("sim_sub_lnest_child"))
	sendSimNorm(conn, simSay("msg_sim_lnest_child_2", "Retry settings parse at internal/config/config.go:88 (MaxAttempts).").sub("sim_sub_lnest_child"))
	sendSimNorm(conn, simSubCompleted("sim_sub_lnest_child"))
	time.Sleep(1500 * time.Millisecond)
	// The parent resumed (nudged), folded the findings in and finished for real.
	sendSimNorm(conn, simSay("msg_sim_lnest_3", "Audit complete: backoff loop is sound; the config cap (config.go:88) lacks zero-value validation.").sub("sim_sub_lnest"))
	sendSimNorm(conn, simSubCompleted("sim_sub_lnest"))
}

// simRunShellCommand mimics the daemon running a composer "!command": stream the
// output live via shell_output frames, then settle into a normalized
// user_message whose payload carries the `shell` object the client renders as a
// card. "!big ..." streams a long log so the scrollable output can be eyeballed.
func simRunShellCommand(conn *safeConn, cmd, id string, stop <-chan struct{}) {
	time.Sleep(500 * time.Millisecond)
	var lines []string
	exit := 0
	switch {
	case strings.Contains(cmd, "fail"):
		lines = []string{"go: running tests...", "--- FAIL: TestThing (0.00s)", "    thing_test.go:12: expected 3, got 4", "FAIL", "exit status 1"}
		exit = 1
	case strings.Contains(cmd, "big") || strings.Contains(cmd, "large"):
		lines = append(lines, "\x1b[1mRunning full suite...\x1b[0m")
		for i := 1; i <= 120; i++ {
			lines = append(lines, fmt.Sprintf("ok  \tgithub.com/trolleyman/hydra/internal/pkg%03d\t%d.%02ds", i, i%5, i%100))
		}
		lines = append(lines, "\x1b[32mPASS\x1b[0m", "ok  \tall packages\t42.7s")
	default:
		lines = []string{"\x1b[1mrunning...\x1b[0m", "PASS", "ok  \tgithub.com/trolleyman/hydra/internal/heads\t2.35s", "ok  \tgithub.com/trolleyman/hydra/internal/http\t0.19s"}
	}
	var full strings.Builder
	stopped := false
	for _, ln := range lines {
		select {
		case <-stop:
			stopped = true
		default:
		}
		if stopped {
			break
		}
		chunk := ln + "\n"
		full.WriteString(chunk)
		writeFrame(conn, api.ChatShellOutputFrame{Type: api.ShellOutput, Id: id, Chunk: chunk})
		time.Sleep(35 * time.Millisecond)
	}
	shell := map[string]any{"command": cmd, "output": full.String(), "exit_code": exit, "truncated": false}
	if stopped {
		shell["stopped"] = true
	}
	sendSimChatEvent(conn, int64(nextSimChatSeq()), "user_message", map[string]any{
		"id":      id,
		"content": simTextContent("I ran a shell command from the chat.\n\nCommand:\n```\n" + cmd + "\n```"),
		"shell":   shell,
	})
}
