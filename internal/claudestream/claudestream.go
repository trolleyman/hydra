// Package claudestream holds the Go side of the Claude Code CLI's stream-json
// protocol, used by chat-mode heads (see CHAT_MODE.md): building the stdin
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

	"braces.dev/errtrace"
)

// Event is the loosely-parsed envelope of one stream-json stdout line. Fields
// beyond these are intentionally not modeled; the raw line is what gets
// relayed.
type Event struct {
	Type      string `json:"type"`
	Subtype   string `json:"subtype,omitempty"`
	SessionID string `json:"session_id,omitempty"`
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
