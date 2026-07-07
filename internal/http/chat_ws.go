package http

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync/atomic"

	"github.com/gorilla/websocket"
	"github.com/trolleyman/hydra/internal/claudestream"
	"github.com/trolleyman/hydra/internal/paths"
	"github.com/trolleyman/hydra/internal/session"
)

// Chat-mode framing for the terminal WebSocket. A chat-mode
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
	// Model is the set_model target (a CLI alias like "sonnet").
	Model string `json:"model,omitempty"`
	// Response is a control_response payload (e.g. AskUserQuestion answers),
	// forwarded verbatim like Content.
	Response json.RawMessage `json:"response,omitempty"`
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
	case "set_model":
		if msg.Model == "" {
			log.Printf("chat ws: set_model without a model for %q", sessionID)
			return
		}
		id := fmt.Sprintf("hydra-set-model-%d", chatInterruptSeq.Add(1))
		if err := s.Sessions.Write(sessionID, claudestream.SetModelLine(id, msg.Model)); err != nil {
			log.Printf("chat ws: write set_model to %q: %v", sessionID, err)
		}
	case "control_response":
		// The client answers a CLI control_request (AskUserQuestion) with a
		// payload the daemon forwards verbatim.
		line, err := claudestream.ControlResponseLine(msg.Response)
		if err != nil {
			log.Printf("chat ws: bad control_response for %q: %v", sessionID, err)
			return
		}
		if err := s.Sessions.Write(sessionID, line); err != nil {
			log.Printf("chat ws: write control_response to %q: %v", sessionID, err)
		}
	case "resize":
		// Chat sessions have no PTY; nothing to resize.
	default:
		log.Printf("chat ws: unknown client frame type %q for %q", msg.Type, sessionID)
	}
}

// sendChatEventLine relays one stream-json line as a claude_event frame.
// Returns false once the socket write fails.
func sendChatEventLine(conn *safeConn, line []byte, agentID string) bool {
	frame, err := json.Marshal(chatEventFrame{
		terminalEvent: terminalEvent{Type: "claude_event"},
		Event:         json.RawMessage(line),
	})
	if err != nil {
		log.Printf("chat ws: marshal event frame for %q: %v", agentID, err)
		return true
	}
	if err := conn.WriteMessage(websocket.TextMessage, frame); err != nil {
		log.Printf("chat ws: error writing to WS for %q: %v", agentID, err)
		return false
	}
	return true
}

// relayChatChunk feeds one output chunk through the line reassembler and
// relays each complete stream-json line as a claude_event frame. Non-protocol
// lines (pre-spawn-script output sharing the stdout pipe, a mid-line ring-wrap
// fragment at the start of a replay) are skipped, as are lines whose uuid was
// already delivered by the transcript backfill. Returns false once the socket
// write fails.
func relayChatChunk(conn *safeConn, lb *claudestream.LineBuffer, chunk []byte, agentID string, skip map[string]struct{}) bool {
	for _, line := range lb.Feed(chunk) {
		ev, ok := claudestream.ParseEvent(line)
		if !ok {
			if len(line) > 0 {
				log.Printf("chat ws: skipping non-protocol line for %q (%d bytes)", agentID, len(line))
			}
			continue
		}
		if ev.UUID != "" {
			if _, dup := skip[ev.UUID]; dup {
				continue
			}
		}
		if !sendChatEventLine(conn, line, agentID) {
			return false
		}
	}
	return true
}

// backfillChatHistory relays the head's conversation history from its Claude
// transcript file (~/.claude/projects/<cwd-slug>/<session>.jsonl) as
// claude_event frames. The scrollback ring only covers the current process
// (and only its recent tail); the transcript is the durable record - notably,
// a resumed process replays NOTHING on stdout, so without this a reconnect
// after any relaunch would show an empty conversation. Returns the uuid set
// of every transcript entry seen, which the ring replay uses to skip lines
// the backfill already delivered (stdout events and transcript lines share
// uuids). Best-effort: a missing dir/file (fresh head) backfills nothing.
func backfillChatHistory(conn *safeConn, agentID, worktree string) map[string]struct{} {
	home, err := os.UserHomeDir()
	if err != nil || worktree == "" {
		return nil
	}
	dir := filepath.Join(home, ".claude", "projects", paths.ClaudeProjectsSlug(worktree))
	transcript := claudestream.LatestTranscript(dir)
	if transcript == "" {
		return nil
	}
	lines, uuids, err := claudestream.TailTranscript(transcript, claudestream.DefaultBackfillBytes)
	if err != nil {
		log.Printf("chat ws: backfill transcript for %q: %v", agentID, err)
		return nil
	}
	for _, line := range lines {
		if !sendChatEventLine(conn, line, agentID) {
			return uuids
		}
	}
	return uuids
}

// pumpChatOutput relays a chat session's output to the socket until the
// session exits or the socket dies: transcript backfill first (durable
// history), then the scrollback-ring replay (recent events the transcript may
// not carry, deduped by uuid), then replay_done, then live events.
func pumpChatOutput(conn *safeConn, att *session.Attachment, agentID, worktree string) {
	skip := backfillChatHistory(conn, agentID, worktree)

	lb := &claudestream.LineBuffer{}
	// Attach queues the ring snapshot synchronously before returning, so a
	// non-blocking receive here reliably distinguishes "history exists" from
	// "nothing yet" - the client needs replay_done to know when the live
	// stream starts.
	select {
	case data, ok := <-att.Output:
		if ok && !relayChatChunk(conn, lb, data, agentID, skip) {
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
			if !relayChatChunk(conn, lb, data, agentID, skip) {
				return
			}
		}
	}
}
