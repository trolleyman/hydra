// Package claudestream holds the Go side of the Claude Code CLI's stream-json
// protocol, used by chat-mode heads: building the stdin
// lines Hydra writes to the CLI and minimally decoding the stdout lines it
// relays to the web client.
//
// The daemon deliberately does NOT deeply parse the protocol - stdout lines are
// relayed verbatim to the chat client, which owns rendering. Only the envelope
// (type/subtype/session_id) is peeked at. Unknown event types are passed
// through untouched: the protocol is versioned with the CLI and new event
// kinds appear over time (thinking_tokens, rate_limit_event, ...).
package claudestream

import (
	"bytes"
	"encoding/json"
	"regexp"
	"strings"
	"time"

	"braces.dev/errtrace"
)

// Event is the loosely-parsed envelope of one stream-json stdout line (or one
// transcript-file line - same shape). Fields beyond these are intentionally
// not modeled; the raw line is what gets relayed. UUID identifies the logged
// conversation record: a stdout user/assistant event and its transcript line
// carry the SAME uuid (spike-verified), which is what makes transcript
// backfill + ring replay dedupable.
type Event struct {
	Type      string `json:"type"`
	Subtype   string `json:"subtype,omitempty"`
	SessionID string `json:"session_id,omitempty"`
	UUID      string `json:"uuid,omitempty"`
	// IsSidechain marks transcript entries from a sub-agent (Task tool) run;
	// those are not part of the main conversation and are skipped by backfill.
	IsSidechain bool `json:"isSidechain,omitempty"`
	// AgentID identifies which sub-agent a sidechain entry belongs to (the Claude
	// Task tool assigns each spawned sub-agent a hex id, carried on every one of
	// its stdout/transcript lines). Empty on main-conversation lines. The chat
	// client groups sidechain events by this id into a per-sub-agent card, and
	// the daemon uses it to resolve the sub-agent's meta.json (its parent Task
	// tool_use id, agent type and description) - see the subagent_meta relay.
	AgentID string `json:"agentId,omitempty"`
	// ParentToolUseID is how CURRENT CLIs (2.1.x) mark a sub-agent line on live
	// stdout: the Task tool_use that spawned it. Those lines carry NO
	// isSidechain/agentId (only transcript-file lines do), so a non-empty value
	// here is the live-stream sidechain signal. null unmarshals to "" (main
	// conversation).
	ParentToolUseID string `json:"parent_tool_use_id,omitempty"`
	// IsAPIError marks a synthesized assistant message the CLI emits when a turn
	// fails mid-response (e.g. "API Error: Server error mid-response. The response
	// above may be incomplete."). It carries the same shape on stdout as in the
	// transcript, so the daemon can detect it live and flip the head into an error
	// status. The text of the error is in the message's single text block.
	IsAPIError bool `json:"isApiErrorMessage,omitempty"`
	// Model is the active model id, carried on the `system`/`init` line the CLI
	// emits at the start of every (re)connect. The daemon reads it to persist the
	// head's current model so the chat selector shows the right one on load,
	// without the client having to observe and echo it back.
	Model string `json:"model,omitempty"`
}

// apiErrorMessage is the minimal decode of an isApiErrorMessage assistant line,
// used to pull out the human-readable error text.
type apiErrorMessage struct {
	Message struct {
		Content []textBlock `json:"content"`
	} `json:"message"`
}

// APIErrorText extracts the error text from a stream-json line that ParseEvent
// flagged IsAPIError (its message's text blocks, joined). Returns "" if the line
// carries no text, so callers can fall back to a generic message.
func APIErrorText(line []byte) string {
	var m apiErrorMessage
	if err := json.Unmarshal(line, &m); err != nil {
		return ""
	}
	var parts []string
	for _, b := range m.Message.Content {
		if b.Type == "text" && b.Text != "" {
			parts = append(parts, b.Text)
		}
	}
	return strings.TrimSpace(strings.Join(parts, "\n"))
}

// ParseEvent peeks at one stdout line's envelope. ok is false when the line is
// not a JSON object with a type (e.g. stray pre-spawn-script output sharing the
// stdout pipe), in which case the line must not be relayed as a protocol event.
func ParseEvent(line []byte) (Event, bool) {
	line = bytes.TrimSpace(line)
	if len(line) == 0 || line[0] != '{' {
		return Event{}, false
	}
	var ev Event
	if err := json.Unmarshal(line, &ev); err != nil || ev.Type == "" {
		return Event{}, false
	}
	return ev, true
}

// ResumeContinuePrompt is the synthetic user turn Claude injects into a resumed
// conversation whose last turn was INTERRUPTED (the process was killed
// mid-response, e.g. a daemon restart mid-turn): an isMeta
// "Continue from where you left off." message. Because the CLI runs headless
// (replyOnResume defaults false in -p mode), it pairs this with a
// synthetic-model "No response requested." assistant reply that marks the
// prompt as deliberately unanswered - so the agent does NOT actually continue.
// The pair is written to the transcript (spike-verified against claude 2.1.204:
// getResumePrompt() = CLAUDE_CODE_RESUME_PROMPT || this string), and Claude's
// own UI hides both as internal placeholders. See IsHiddenChatMessage.
const ResumeContinuePrompt = "Continue from where you left off."

// syntheticModel is the model value the CLI stamps on placeholder assistant
// messages it fabricates locally ("No response requested.", "(no content)", ...)
// rather than receiving from the API.
const syntheticModel = "<synthetic>"

// imageResizeNotice matches the bookkeeping record the CLI writes every time it
// downscales an image before sending it (a Read of a screenshot, a pasted
// attachment): an isMeta user message reading "[Image: original 2088x160,
// displayed at 2000x153. Multiply coordinates by 1.04 to map to original
// image.]". It is addressed to the MODEL - it explains how to map a coordinate
// in the image it saw back onto the file - and carries nothing a reader can act
// on. Anchored on the two dimension pairs rather than the whole sentence so a
// reworded tail still matches.
var imageResizeNotice = regexp.MustCompile(`^\[Image: original \d+x\d+, displayed at \d+x\d+\.`)

// hiddenMsgProbe is the minimal decode used by IsHiddenChatMessage.
type hiddenMsgProbe struct {
	Type    string `json:"type"`
	IsMeta  bool   `json:"isMeta"`
	Message struct {
		Model   string          `json:"model"`
		Content json.RawMessage `json:"content"`
	} `json:"message"`
}

// IsHiddenChatMessage reports whether a stream-json / transcript line is one of
// the CLI's internal placeholders that its own UI hides, and which the chat view
// therefore must not render:
//
//   - any assistant message stamped with the synthetic model (the local
//     "No response requested." / "(no content)" placeholders),
//   - the isMeta ResumeContinuePrompt user turn the CLI injects when resuming an
//     interrupted turn, and
//   - the isMeta image-downscale notice it writes after every image it sends
//     (see imageResizeNotice).
//
// Without this the first two surface as a spurious "Continue from where you left
// off." user bubble answered by "No response requested." - noise the user can't
// act on (the agent is separately nudged to continue for real, see
// heads.nudgeResumedChatAgent) - and the third as an "Injected context" card.
// All three appear ONLY in transcript backfill (a resumed process replays
// nothing on stdout; the CLI logs the image notice without emitting it), which
// is what makes them worth dropping rather than tolerating: the backfill is a
// one-shot append onto an existing event log, so an entry the live stream never
// carried lands at the TAIL of the conversation - a mid-turn note about an
// image read minutes ago, stuck to the end of a finished answer. The predicate
// is cheap, so it is applied on every relay path. A line that isn't a JSON
// object returns false (relayed unchanged).
func IsHiddenChatMessage(line []byte) bool {
	line = bytes.TrimSpace(line)
	if len(line) == 0 || line[0] != '{' {
		return false
	}
	var p hiddenMsgProbe
	if err := json.Unmarshal(line, &p); err != nil {
		return false
	}
	switch p.Type {
	case "assistant":
		return p.Message.Model == syntheticModel
	case "user":
		if !p.IsMeta {
			return false
		}
		text := messageContentText(p.Message.Content)
		return text == ResumeContinuePrompt || imageResizeNotice.MatchString(text)
	}
	return false
}

// messageContentText extracts the plain text of a user/assistant message's
// content, which is either a JSON string or an array of content blocks (only
// text blocks contribute). Returns "" for anything else.
func messageContentText(content json.RawMessage) string {
	content = bytes.TrimSpace(content)
	if len(content) == 0 {
		return ""
	}
	if content[0] == '"' {
		var s string
		if json.Unmarshal(content, &s) != nil {
			return ""
		}
		return strings.TrimSpace(s)
	}
	var blocks []textBlock
	if json.Unmarshal(content, &blocks) != nil {
		return ""
	}
	var parts []string
	for _, b := range blocks {
		if b.Type == "text" {
			parts = append(parts, b.Text)
		}
	}
	return strings.TrimSpace(strings.Join(parts, "\n"))
}

// controlRequest is the minimal decode of a control_request stdout line the CLI
// emits when --permission-prompt-tool stdio routes a tool call through the client
// for approval. Only the can_use_tool subtype is modeled; note the subtype lives
// NESTED under `request` (unlike a top-level event subtype), so ParseEvent won't
// surface it - ParseToolPermissionRequest decodes this shape instead.
type controlRequest struct {
	Type      string `json:"type"`
	RequestID string `json:"request_id"`
	Request   struct {
		Subtype   string          `json:"subtype"`
		ToolName  string          `json:"tool_name"`
		ToolUseID string          `json:"tool_use_id"`
		Input     json.RawMessage `json:"input"`
	} `json:"request"`
}

// ToolPermissionRequest is a parsed can_use_tool control_request: the CLI asking
// the client to approve ToolName's call. RequestID is the channel the answer goes
// back on (via ApproveToolLine / ControlResponseLine); Input is the tool input,
// echoed back verbatim as updatedInput on an allow. ToolUseID is the tool_use
// block the request belongs to - the id its eventual tool_result quotes, which
// is how the ask tracker knows the request was answered.
type ToolPermissionRequest struct {
	RequestID string
	ToolName  string
	ToolUseID string
	Input     json.RawMessage
}

// ParseToolPermissionRequest decodes one stdout line as a can_use_tool
// control_request, reporting ok=false for any other line (a different control
// subtype, a non-control event, or malformed JSON). Used to detect the
// ExitPlanMode plan-approval gate a chat-mode head hits headless.
func ParseToolPermissionRequest(line []byte) (ToolPermissionRequest, bool) {
	var cr controlRequest
	if err := json.Unmarshal(line, &cr); err != nil {
		return ToolPermissionRequest{}, false
	}
	if cr.Type != "control_request" || cr.Request.Subtype != "can_use_tool" ||
		cr.RequestID == "" || cr.Request.ToolName == "" {
		return ToolPermissionRequest{}, false
	}
	return ToolPermissionRequest{
		RequestID: cr.RequestID,
		ToolName:  cr.Request.ToolName,
		ToolUseID: cr.Request.ToolUseID,
		Input:     cr.Request.Input,
	}, true
}

// controlResponse is the minimal decode of a control_response payload (the
// object a chat client sends back, unwrapped from its stdin envelope).
type controlResponse struct {
	RequestID string `json:"request_id"`
}

// ControlResponseRequestID reads the request_id a client's control_response
// answers, or "" if the payload isn't shaped like one. The daemon uses it to
// check the answer against the requests the CLI is actually still blocked on
// before writing it to stdin.
func ControlResponseRequestID(payload json.RawMessage) string {
	var cr controlResponse
	if json.Unmarshal(payload, &cr) != nil {
		return ""
	}
	return cr.RequestID
}

// ApproveToolLine builds the control_response stdin line that ALLOWS a
// can_use_tool request, mirroring what the chat client sends to answer an
// AskUserQuestion: subtype "success", behavior "allow", with the original tool
// input echoed back as updatedInput (a nil/invalid input becomes `{}`). Used to
// auto-approve ExitPlanMode so a chat-mode head doesn't hang on the plan gate.
func ApproveToolLine(requestID string, input json.RawMessage) []byte {
	updatedInput := json.RawMessage(bytes.TrimSpace(input))
	if len(updatedInput) == 0 || !json.Valid(updatedInput) {
		updatedInput = json.RawMessage("{}")
	}
	payload, _ := json.Marshal(map[string]any{
		"subtype":    "success",
		"request_id": requestID,
		"response": map[string]any{
			"behavior":     "allow",
			"updatedInput": updatedInput,
		},
	})
	line, _ := ControlResponseLine(payload)
	return line
}

// userMessage is the stdin envelope for one user turn
// (--input-format stream-json).
type userMessage struct {
	Type    string      `json:"type"`
	Message userPayload `json:"message"`
}

type userPayload struct {
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
}

type textBlock struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// UserMessageLine wraps a content-block array (as raw JSON, e.g. forwarded
// verbatim from the chat client) into the newline-terminated stdin line that
// delivers one user turn. content must be a JSON array of content blocks.
func UserMessageLine(content json.RawMessage) ([]byte, error) {
	if !json.Valid(content) {
		return nil, errtrace.Errorf("invalid content JSON")
	}
	trimmed := bytes.TrimSpace(content)
	if len(trimmed) == 0 || trimmed[0] != '[' {
		return nil, errtrace.Errorf("content must be a JSON array of content blocks")
	}
	line, err := json.Marshal(userMessage{
		Type:    "user",
		Message: userPayload{Role: "user", Content: trimmed},
	})
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	return append(line, '\n'), nil
}

// TextUserMessageLine builds the stdin line for a plain-text user turn (the
// initial task prompt, the resume nudge).
func TextUserMessageLine(text string) []byte {
	content, _ := json.Marshal([]textBlock{{Type: "text", Text: text}})
	line, _ := UserMessageLine(content)
	return line
}

// TextUserContent builds the content-block array (a single text block) for a
// plain-text user turn - the shape QueuedMessage.Content / a chat user_message
// frame carries, ready to hand to heads.ChatQueueManager.Submit.
func TextUserContent(text string) json.RawMessage {
	content, _ := json.Marshal([]textBlock{{Type: "text", Text: text}})
	return content
}

// InterruptLine builds the control_request line that cancels the in-flight
// turn without killing the process. This mirrors what the Agent SDK sends; a
// CLI version that doesn't understand it ignores the line.
func InterruptLine(requestID string) []byte {
	line, _ := json.Marshal(map[string]any{
		"type":       "control_request",
		"request_id": requestID,
		"request":    map[string]any{"subtype": "interrupt"},
	})
	return append(line, '\n')
}

// SetModelLine builds the control_request line that switches the session's
// model in place, like the /model slash command (spike-verified: the CLI
// answers with a control_response and a "Set model to ..." user echo, and the
// change persists in the transcript across resumes). model is a CLI alias
// ("sonnet") or full id.
func SetModelLine(requestID, model string) []byte {
	line, _ := json.Marshal(map[string]any{
		"type":       "control_request",
		"request_id": requestID,
		"request":    map[string]any{"subtype": "set_model", "model": model},
	})
	return append(line, '\n')
}

// ControlResponseLine wraps a client-built control response payload (e.g. the
// AskUserQuestion answers - a can_use_tool allow with updatedInput) into the
// stdin line the CLI expects. The payload is forwarded verbatim; the client
// owns its shape, exactly like user_message content blocks. response must be
// a JSON object.
func ControlResponseLine(response json.RawMessage) ([]byte, error) {
	if !json.Valid(response) {
		return nil, errtrace.Errorf("invalid control response JSON")
	}
	trimmed := bytes.TrimSpace(response)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return nil, errtrace.Errorf("control response must be a JSON object")
	}
	line, err := json.Marshal(map[string]any{
		"type":     "control_response",
		"response": json.RawMessage(trimmed),
	})
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	return append(line, '\n'), nil
}

// LineBuffer reassembles complete newline-terminated lines from an arbitrary
// byte-chunk stream (the session fan-out delivers whatever read sizes the pipe
// produced, and the scrollback-ring replay may even start mid-line after a
// wrap - callers drop lines that fail ParseEvent).
type LineBuffer struct {
	buf []byte
}

// maxBufferedLine caps the partial-line buffer so a malfunctioning child that
// never emits a newline cannot grow memory unboundedly. Complete protocol
// lines can legitimately be large (a tool_result carrying a file), so the cap
// is generous; an over-cap partial is dropped.
const maxBufferedLine = 8 * 1024 * 1024

// Feed appends a chunk and returns any now-complete lines (without their
// trailing newline).
func (b *LineBuffer) Feed(chunk []byte) [][]byte {
	b.buf = append(b.buf, chunk...)
	var lines [][]byte
	for {
		idx := bytes.IndexByte(b.buf, '\n')
		if idx < 0 {
			break
		}
		line := make([]byte, idx)
		copy(line, b.buf[:idx])
		b.buf = b.buf[idx+1:]
		lines = append(lines, line)
	}
	if len(b.buf) > maxBufferedLine {
		b.buf = nil
	}
	return lines
}

// RingFilter decides which chat-session output bytes are worth persisting in
// the scrollback ring. With --include-partial-messages the stdout stream is
// dominated by stream_event partial-delta lines; they matter live (token
// streaming) but replaying them is pure waste - the complete assistant/user
// events carry the same content - and storing them would wrap the ring
// several times faster, evicting real history. The filter reassembles lines
// and keeps everything EXCEPT stream_event lines.
//
// Not safe for concurrent use; the session read loop calls it under the
// session lock, and Pending is read under the same lock (see Session.attach).
type RingFilter struct {
	lb LineBuffer
	// OnLine observes every complete protocol line in read order, including
	// stream_event token deltas. Hydra's normalized adapter needs those deltas
	// for live rendering even though the scrollback ring intentionally retains
	// only completed events. The callback runs under the session lock and should
	// enqueue work rather than doing disk IO itself.
	OnLine func(line []byte)
	// OnAPIError, if set, is called (synchronously, once per line) with the error
	// text whenever a complete assistant line flagged isApiErrorMessage passes
	// through - the signal that a turn failed mid-response. It runs under the
	// session lock, so the callback must be cheap (the session dispatches the real
	// work - writing the head's error status - off the read goroutine).
	OnAPIError func(msg string)
	// OnResult, if set, is called once per `result` line - the end of a user
	// turn. The chat message queue uses it to drain the next queued message. Like
	// OnAPIError it runs under the session lock, so it must be cheap (the session
	// dispatches the real work off the read goroutine).
	OnResult func()
	// OnStep, if set, is called once per completed main-conversation assistant
	// line - the end of a thinking block, a tool_use being issued, a text block.
	// The chat message queue uses it to dump queued messages at step
	// boundaries instead of waiting for the turn to end: the CLI injects a
	// mid-turn stdin user message into the running turn at its next step
	// boundary, exactly like typing in the interactive terminal
	// (spike-verified). Sidechain (sub-agent) and isApiErrorMessage lines
	// don't count - only the main turn making progress does. Deliberately NOT
	// fired on `user` lines: those include the interrupt echo, whose drain
	// would eat the pending-interrupt mark before its own result consumed it,
	// and the CLI's echoes of drained messages. Same under-the-session-lock
	// cheapness rule as the other hooks.
	OnStep func()
	// OnPlanApproval, if set, is called (once per matching line) with the
	// request_id and tool input of a can_use_tool control_request for
	// ExitPlanMode - the plan-approval gate a chat-mode head hits when it leaves
	// plan mode. Chat heads run with --permission-prompt-tool stdio, so this gate
	// arrives as a control_request the client must answer; nothing does, so the
	// head would hang forever. The daemon wires this to auto-approve it (the same
	// stance the terminal-mode PermissionRequest hook takes: a Hydra head already
	// runs autonomously in a throwaway sandbox, so there's nothing for the plan
	// gate to guard). Same under-the-session-lock cheapness rule as the other
	// hooks - the callback dispatches the actual stdin write off the read
	// goroutine.
	OnPlanApproval func(requestID string, input json.RawMessage)
	// Plan, if set, incrementally folds each complete line into the head's
	// plan/to-do list (TaskCreate/TaskUpdate/TodoWrite and their results) - the
	// daemon-owned durable copy, maintained whether or not any browser is
	// attached. OnPlanChange fires (once per line that changed the plan) with
	// the new PlanEntry JSON; the daemon wires it to persist onto Agent.Plan.
	// Same under-the-session-lock cheapness rule as the other hooks - the
	// tracker's substring pre-filter dismisses almost every line without JSON
	// work, and the callback dispatches the DB write off the read goroutine.
	Plan         *PlanTracker
	OnPlanChange func(planJSON string)
	// OnModel, if set, is called with the active model id whenever a
	// system:init line carries one - session start and every /model change.
	// The daemon wires it to persist the head's current model. Living here
	// (not the per-connection relay) means it fires with no browser attached,
	// so a mid-session /model change survives a daemon restart even if nobody
	// reattached in between. Same under-the-session-lock cheapness rule as the
	// other hooks.
	OnModel func(model string)
	// OnThinking, if set, fires once per completed thinking block with the block's
	// message id and the wall-clock duration Hydra measured for it (from the
	// block's content_block_start to its content_block_stop on the live stream).
	// The daemon wires this to persist the duration to a small per-head sidecar,
	// so a reload/resume can show "Thought for Xs" without the browser having to
	// time it. Same under-the-session-lock cheapness rule as the other hooks - the
	// callback dispatches the disk write off the read goroutine. Filter ALSO emits
	// a synthetic hydra_thinking line (see Filter's injected return) so an
	// already-attached client gets the duration live.
	OnThinking func(messageID string, durationMS int64)
	// timer measures thinking-block durations from the stream_event partial deltas
	// that Filter otherwise drops. Lazily initialised on first stream_event.
	timer thinkingTimer
	// pendingInjected holds synthetic hydra_thinking lines measured mid-chunk,
	// released to attachers only once the chunk stream reaches a line boundary
	// (see Filter) so they never splice into a half-buffered line.
	pendingInjected []byte
	// pendingAsks are the AskUserQuestion can_use_tool requests this process is
	// still blocked on, in arrival order - see PendingAsks.
	pendingAsks []PendingAsk
}

// PendingAsk is one AskUserQuestion the CLI is waiting on an answer to.
// RequestID is the control channel the answer must quote; ToolUseID identifies
// the question card it belongs to.
type PendingAsk struct {
	RequestID string `json:"requestId"`
	ToolUseID string `json:"toolUseId"`
}

// PendingAsks returns the AskUserQuestion requests the CLI is STILL blocked on,
// as of the last line filtered. This is the authority on whether a question
// card can be answered: the request_id is durable (it is stored and replayed
// with the transcript on every reload) but the request behind it lives only as
// long as the turn that raised it, so a control_response quoting a dropped one
// is discarded in silence. A request leaves the set when its tool_result
// arrives (answered) or when the turn ends (a `result` line - an interrupt or a
// mid-question /model switch both land here), and the whole set dies with the
// process, since a new one gets a fresh filter.
//
// Same concurrency rule as Pending: read under the session lock, on the
// read-loop side.
func (f *RingFilter) PendingAsks() []PendingAsk {
	if len(f.pendingAsks) == 0 {
		return nil
	}
	out := make([]PendingAsk, len(f.pendingAsks))
	copy(out, f.pendingAsks)
	return out
}

// dropAsk removes an answered request from the pending set.
func (f *RingFilter) dropAsk(toolUseID string) {
	for i, a := range f.pendingAsks {
		if a.ToolUseID == toolUseID {
			f.pendingAsks = append(f.pendingAsks[:i], f.pendingAsks[i+1:]...)
			return
		}
	}
}

// askResultLine is the minimal decode used to spot the tool_result that answers
// a pending ask.
type askResultLine struct {
	Message struct {
		Content []struct {
			Type      string `json:"type"`
			ToolUseID string `json:"tool_use_id"`
		} `json:"content"`
	} `json:"message"`
}

// trackAsks folds one parsed line into the pending-ask set (see PendingAsks).
// Cheap by construction: the set is empty for all but the seconds a question is
// actually open, and the tool_result decode is gated on a substring probe.
func (f *RingFilter) trackAsks(ev Event, line []byte) {
	switch {
	case ev.Type == "control_request":
		req, ok := ParseToolPermissionRequest(line)
		if ok && req.ToolName == "AskUserQuestion" && req.ToolUseID != "" {
			f.pendingAsks = append(f.pendingAsks, PendingAsk{RequestID: req.RequestID, ToolUseID: req.ToolUseID})
		}
	case len(f.pendingAsks) == 0:
		// Nothing open: no line can retire anything.
	case ev.Type == "result":
		// The turn is over, so every request it was blocked on is gone with it.
		f.pendingAsks = nil
	case ev.Type == "user" && bytes.Contains(line, toolResultMarker):
		var res askResultLine
		if json.Unmarshal(line, &res) != nil {
			return
		}
		for _, b := range res.Message.Content {
			if b.Type == "tool_result" && b.ToolUseID != "" {
				f.dropAsk(b.ToolUseID)
			}
		}
	}
}

// nowFunc is the clock thinkingTimer reads; a package var so tests can pin it.
// The production stream is live, so real wall-clock time is what we want.
var nowFunc = time.Now

// thinkingTimer tracks the currently-streaming assistant message id and the
// start time of each in-flight thinking content block, so it can report a
// block's duration when its content_block_stop arrives. Not safe for concurrent
// use; it runs under the session lock inside RingFilter.Filter.
type thinkingTimer struct {
	msgID string
	// starts maps a thinking block's stream content-block index to when its
	// content_block_start was seen. Only thinking blocks get an entry, so a
	// content_block_stop with no entry is a non-thinking block we ignore.
	starts map[int]time.Time
}

// streamEventEnvelope is the minimal decode of a stream_event line: enough to
// follow message boundaries and thinking content-block start/stop. Everything
// else in the partial-delta stream is ignored.
type streamEventEnvelope struct {
	Event struct {
		Type    string `json:"type"`
		Index   int    `json:"index"`
		Message struct {
			ID string `json:"id"`
		} `json:"message"`
		ContentBlock struct {
			Type string `json:"type"`
		} `json:"content_block"`
	} `json:"event"`
}

// feed advances the timer with one stream_event line. When a thinking block's
// content_block_stop is seen it returns that block's message id and duration
// (ok=true); otherwise ok=false. A message_start resets the per-message index
// map (indices are scoped to one message).
func (t *thinkingTimer) feed(line []byte) (messageID string, durationMS int64, ok bool) {
	var env streamEventEnvelope
	if err := json.Unmarshal(line, &env); err != nil {
		return "", 0, false
	}
	switch env.Event.Type {
	case "message_start":
		t.msgID = env.Event.Message.ID
		t.starts = nil
	case "content_block_start":
		if env.Event.ContentBlock.Type == "thinking" {
			if t.starts == nil {
				t.starts = map[int]time.Time{}
			}
			t.starts[env.Event.Index] = nowFunc()
		}
	case "content_block_stop":
		start, isThinking := t.starts[env.Event.Index]
		if !isThinking {
			return "", 0, false
		}
		delete(t.starts, env.Event.Index)
		// A message with no message_start (shouldn't happen on a live stream, but
		// be defensive) has no id to key on - skip rather than record an orphan.
		if t.msgID == "" {
			return "", 0, false
		}
		return t.msgID, nowFunc().Sub(start).Milliseconds(), true
	}
	return "", 0, false
}

// thinkingLine builds the synthetic hydra_thinking stream line Filter injects so
// an attached client learns a thinking block's measured duration live. The
// client keys it by message_id (the same id its settled assistant event carries)
// and shows "Thought for Xs"; on reload the daemon replays these from the head's
// sidecar (see the http backfill).
func thinkingLine(messageID string, durationMS int64) []byte {
	line, _ := json.Marshal(map[string]any{
		"type":        "hydra_thinking",
		"message_id":  messageID,
		"duration_ms": durationMS,
	})
	return append(line, '\n')
}

// Filter feeds chunk through the line reassembler and returns the bytes to
// persist (kept: complete non-stream_event lines, newline-terminated) plus any
// synthetic lines to also stream live to attachers (injected: hydra_thinking
// duration events - NOT persisted in the ring, since the daemon's per-head
// sidecar is what a reconnect replays them from). A line the CLI flagged as an
// API error fires OnAPIError; a `result` line (turn end) fires OnResult; a
// completed thinking block fires OnThinking (for the sidecar write).
func (f *RingFilter) Filter(chunk []byte) (kept, injected []byte) {
	var out []byte
	for _, line := range f.lb.Feed(chunk) {
		ev, ok := ParseEvent(line)
		if f.OnLine != nil && len(bytes.TrimSpace(line)) > 0 {
			f.OnLine(line)
		}
		if ok && ev.Type == "stream_event" {
			// stream_event partials aren't persisted, but they carry the thinking
			// block timing: measure it here and, on completion, queue a synthetic
			// hydra_thinking line (live) + fire OnThinking (durable sidecar write).
			if msgID, durMS, done := f.timer.feed(line); done {
				f.pendingInjected = append(f.pendingInjected, thinkingLine(msgID, durMS)...)
				if f.OnThinking != nil {
					f.OnThinking(msgID, durMS)
				}
			}
			continue
		}
		if ok && ev.IsAPIError && f.OnAPIError != nil {
			f.OnAPIError(APIErrorText(line))
		}
		if ok && ev.Type == "result" && f.OnResult != nil {
			f.OnResult()
		}
		if ok && ev.Type == "assistant" && !ev.IsSidechain && !ev.IsAPIError && f.OnStep != nil {
			f.OnStep()
		}
		if ok && ev.Type == "control_request" && f.OnPlanApproval != nil {
			if req, isReq := ParseToolPermissionRequest(line); isReq && req.ToolName == "ExitPlanMode" {
				f.OnPlanApproval(req.RequestID, req.Input)
			}
		}
		if ok {
			f.trackAsks(ev, line)
		}
		if ok && f.Plan != nil && f.Plan.Feed(line) && f.OnPlanChange != nil {
			f.OnPlanChange(f.Plan.JSON())
		}
		if ok && ev.Type == "system" && ev.Subtype == "init" && ev.Model != "" && f.OnModel != nil {
			f.OnModel(ev.Model)
		}
		out = append(out, line...)
		out = append(out, '\n')
	}
	// Flush queued hydra_thinking lines to attachers only at a line boundary -
	// i.e. when this chunk left no partial line buffered. Attachers receive the
	// RAW chunk stream and reassemble it themselves (same bytes this filter sees),
	// so their reassembler is at a boundary exactly when ours is; injecting a
	// synthetic line mid-partial would splice into the half-line and corrupt both.
	// A held line just waits for the next chunk that lands on a boundary.
	if len(f.lb.buf) == 0 && len(f.pendingInjected) > 0 {
		injected = f.pendingInjected
		f.pendingInjected = nil
	}
	return out, injected
}

// Pending returns the buffered partial line not yet persisted. A new attacher
// gets ring bytes + Pending as its snapshot, so the live stream that follows
// (which continues mid-line from the reader's current position) joins without
// a corrupt seam.
func (f *RingFilter) Pending() []byte {
	return f.lb.buf
}
