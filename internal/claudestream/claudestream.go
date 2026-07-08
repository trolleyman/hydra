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
	"strings"

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
	// IsAPIError marks a synthesized assistant message the CLI emits when a turn
	// fails mid-response (e.g. "API Error: Server error mid-response. The response
	// above may be incomplete."). It carries the same shape on stdout as in the
	// transcript, so the daemon can detect it live and flip the head into an error
	// status. The text of the error is in the message's single text block.
	IsAPIError bool `json:"isApiErrorMessage,omitempty"`
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
}

// Filter feeds chunk through the line reassembler and returns the bytes to
// persist (complete non-stream_event lines, newline-terminated). A line the CLI
// flagged as an API error fires OnAPIError as a side effect; a `result` line
// (turn end) fires OnResult.
func (f *RingFilter) Filter(chunk []byte) []byte {
	var out []byte
	for _, line := range f.lb.Feed(chunk) {
		ev, ok := ParseEvent(line)
		if ok && ev.Type == "stream_event" {
			continue
		}
		if ok && ev.IsAPIError && f.OnAPIError != nil {
			f.OnAPIError(APIErrorText(line))
		}
		if ok && ev.Type == "result" && f.OnResult != nil {
			f.OnResult()
		}
		out = append(out, line...)
		out = append(out, '\n')
	}
	return out
}

// Pending returns the buffered partial line not yet persisted. A new attacher
// gets ring bytes + Pending as its snapshot, so the live stream that follows
// (which continues mid-line from the reader's current position) joins without
// a corrupt seam.
func (f *RingFilter) Pending() []byte {
	return f.lb.buf
}
