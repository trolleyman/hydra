package http

import (
	"encoding/json"
	"fmt"
	"log"
	"sync/atomic"

	"github.com/gorilla/websocket"
	"github.com/trolleyman/hydra/internal/claudestream"
	"github.com/trolleyman/hydra/internal/session"
)

// Chat-mode framing for the terminal WebSocket (CHAT_MODE.md). A chat-mode
// head shares /ws/.../terminal with terminal heads, but every frame is text:
//
//	server -> client: the shared control events (status, diff_refresh), plus
//	  {"type":"claude_event","event":<verbatim stream-json object>} for each
//	  complete stdout line, and {"type":"replay_done"} once the scrollback
//	  replay has been relayed (history vs live marker).
//	client -> server: {"type":"user_message","content":[<content blocks>]} to
//	  deliver a user turn, and {"type":"interrupt"} to cancel the in-flight
//	  turn. Binary frames and resize messages are ignored (no PTY).

// chatClientMsg is one client -> server text frame on a chat-mode socket.
type chatClientMsg struct {
	Type string `json:"type"`
	// Content is the content-block array of a user_message, forwarded to the
	// CLI verbatim (the client owns the block shapes; the daemon only wraps
	// them in the stdin envelope).
	Content json.RawMessage `json:"content,omitempty"`
}

// chatEventFrame is the server -> client wrapper around one stream-json line.
type chatEventFrame struct {
	terminalEvent
	Event json.RawMessage `json:"event"`
}

// chatInterruptSeq numbers control_request interrupts so each request_id is
// unique across the daemon's lifetime.
var chatInterruptSeq atomic.Uint64

// handleChatClientMessage services one text frame from a chat client.
func (s *Server) handleChatClientMessage(sessionID string, data []byte) {
	var msg chatClientMsg
	if err := json.Unmarshal(data, &msg); err != nil {
		log.Printf("chat ws: bad client frame for %q: %v", sessionID, err)
		return
	}
	switch msg.Type {
	case "user_message":
		line, err := claudestream.UserMessageLine(msg.Content)
		if err != nil {
			log.Printf("chat ws: bad user_message content for %q: %v", sessionID, err)
			return
		}
		if err := s.Sessions.Write(sessionID, line); err != nil {
			log.Printf("chat ws: write user message to %q: %v", sessionID, err)
		}
	case "interrupt":
		id := fmt.Sprintf("hydra-interrupt-%d", chatInterruptSeq.Add(1))
		if err := s.Sessions.Write(sessionID, claudestream.InterruptLine(id)); err != nil {
			log.Printf("chat ws: write interrupt to %q: %v", sessionID, err)
		}
	case "resize":
		// Chat sessions have no PTY; nothing to resize.
	default:
		log.Printf("chat ws: unknown client frame type %q for %q", msg.Type, sessionID)
	}
}

// relayChatChunk feeds one output chunk through the line reassembler and
// relays each complete stream-json line as a claude_event frame. Non-protocol
// lines (pre-spawn-script output sharing the stdout pipe, a mid-line ring-wrap
// fragment at the start of a replay) are skipped. Returns false once the
// socket write fails.
func relayChatChunk(conn *safeConn, lb *claudestream.LineBuffer, chunk []byte, agentID string) bool {
	for _, line := range lb.Feed(chunk) {
		if _, ok := claudestream.ParseEvent(line); !ok {
			if len(line) > 0 {
				log.Printf("chat ws: skipping non-protocol line for %q (%d bytes)", agentID, len(line))
			}
			continue
		}
		frame, err := json.Marshal(chatEventFrame{
			terminalEvent: terminalEvent{Type: "claude_event"},
			Event:         json.RawMessage(line),
		})
		if err != nil {
			log.Printf("chat ws: marshal event frame for %q: %v", agentID, err)
			continue
		}
		if err := conn.WriteMessage(websocket.TextMessage, frame); err != nil {
			log.Printf("chat ws: error writing to WS for %q: %v", agentID, err)
			return false
		}
	}
	return true
}

// pumpChatOutput relays a chat session's output to the socket until the
// session exits or the socket dies. The scrollback replay (the whole
// conversation so far, thanks to --replay-user-messages) is relayed first,
// then replay_done, then live events.
func pumpChatOutput(conn *safeConn, att *session.Attachment, agentID string) {
	lb := &claudestream.LineBuffer{}
	// Attach queues the ring snapshot synchronously before returning, so a
	// non-blocking receive here reliably distinguishes "history exists" from
	// "nothing yet" - the client needs replay_done to know when the live
	// stream starts.
	select {
	case data, ok := <-att.Output:
		if ok && !relayChatChunk(conn, lb, data, agentID) {
			return
		}
	default:
	}
	sendTerminalEvent(conn, "replay_done")

	for {
		select {
		case <-att.Done:
			return
		case data, ok := <-att.Output:
			if !ok {
				return
			}
			if !relayChatChunk(conn, lb, data, agentID) {
				return
			}
		}
	}
}
