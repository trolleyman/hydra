package http

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"github.com/trolleyman/hydra/internal/claudestream"
	"github.com/trolleyman/hydra/internal/heads"
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
	// ID is the client-generated id of a user_message / dequeue target, so a
	// queued message can be reconciled and recalled (see ChatQueueManager).
	ID string `json:"id,omitempty"`
	// Queued is set on a user_message the client is sending while a turn runs:
	// the daemon HOLDS it (queues) rather than delivering it now, and drains it
	// when the turn ends. False (or absent) delivers it immediately.
	Queued bool `json:"queued,omitempty"`
	// Before is the uuid of the client's current oldest history line on a
	// load_before (infinite scroll) request - the daemon returns the batch
	// older than it.
	Before string `json:"before,omitempty"`
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

// chatQueueFrame is the server -> client snapshot of a head's queued messages,
// sent right after replay_done so a (re)attaching client renders the pending
// bubbles (the queue survives disconnects/restarts daemon-side).
type chatQueueFrame struct {
	terminalEvent
	Messages []heads.QueuedMessage `json:"messages"`
}

// chatEventFrame is the server -> client wrapper around one stream-json line.
type chatEventFrame struct {
	terminalEvent
	Event json.RawMessage `json:"event"`
}

// chatSubagentMetaFrame links a sub-agent (Task tool) to the Task tool_use that
// spawned it, so the chat client can fold the sub-agent's sidechain activity
// into that Task card and label it. Sent once per sub-agent, ahead of (or during
// backfill, alongside) its sidechain events. Fields come from the sub-agent's
// meta.json sidecar; the client tolerates it arriving after the events too.
type chatSubagentMetaFrame struct {
	terminalEvent
	AgentID     string `json:"agentId"`
	ToolUseID   string `json:"toolUseId,omitempty"`
	AgentType   string `json:"agentType,omitempty"`
	Description string `json:"description,omitempty"`
}

// subagentResolver emits one subagent_meta frame per distinct sidechain
// agent_id seen on a connection. The meta sidecar may not exist the instant the
// first sidechain line arrives (Claude writes it around sub-agent spawn), so an
// unresolved id is left un-seen and retried on its next line. claudeProjectDir
// is ~/.claude/projects/<worktree-slug>; sessionID scopes the subagents/ dir.
type subagentResolver struct {
	claudeProjectDir string
	seen             map[string]struct{}
}

func newSubagentResolver(claudeProjectDir string) *subagentResolver {
	return &subagentResolver{claudeProjectDir: claudeProjectDir, seen: map[string]struct{}{}}
}

// resolve sends the subagent_meta frame for agentID (once) if its meta sidecar
// can be read. Returns false only on a socket write failure.
func (r *subagentResolver) resolve(conn *safeConn, agentID, sessionID string) bool {
	if r == nil || agentID == "" || r.claudeProjectDir == "" || sessionID == "" {
		return true
	}
	if _, done := r.seen[agentID]; done {
		return true
	}
	meta, ok := claudestream.ReadSubagentMeta(r.claudeProjectDir, sessionID, agentID)
	if !ok {
		return true // not flushed yet; retry on this sub-agent's next line
	}
	r.seen[agentID] = struct{}{}
	return sendSubagentMeta(conn, agentID, meta)
}

// sendSubagentMeta relays one subagent_meta frame. meta may be nil (backfill of
// a sub-agent whose sidecar is missing) - the frame still links the id so the
// client folds the standalone card, just without a type/description label.
func sendSubagentMeta(conn *safeConn, agentID string, meta *claudestream.SubagentMeta) bool {
	f := chatSubagentMetaFrame{terminalEvent: terminalEvent{Type: "subagent_meta"}, AgentID: agentID}
	if meta != nil {
		f.ToolUseID, f.AgentType, f.Description = meta.ToolUseID, meta.AgentType, meta.Description
	}
	frame, err := json.Marshal(f)
	if err != nil {
		log.Printf("chat ws: marshal subagent_meta for %q: %v", agentID, err)
		return true
	}
	if err := conn.WriteMessage(websocket.TextMessage, frame); err != nil {
		return false
	}
	return true
}

// chatInterruptSeq numbers control_request interrupts so each request_id is
// unique across the daemon's lifetime.
var chatInterruptSeq atomic.Uint64

// handleChatClientMessage services one text frame from a chat client.
// projectRoot locates the head's on-disk message queue; worktree locates its
// transcript for load-older; conn is needed to answer a load_before.
func (s *Server) handleChatClientMessage(conn *safeConn, projectRoot, worktree, sessionID string, data []byte) {
	var msg chatClientMsg
	if err := json.Unmarshal(data, &msg); err != nil {
		log.Printf("chat ws: bad client frame for %q: %v", sessionID, err)
		return
	}
	switch msg.Type {
	case "load_before":
		// Infinite scroll: send the batch of conversation history older than the
		// client's current oldest line (msg.Before is that line's uuid).
		sendChatHistoryBefore(conn, worktree, sessionID, msg.Before)
		return
	case "user_message":
		if !json.Valid(msg.Content) {
			log.Printf("chat ws: bad user_message content for %q", sessionID)
			return
		}
		// Route through the queue manager: a message sent while a turn runs
		// (Queued) is held daemon-side and drained when the turn ends; otherwise
		// it goes straight to the CLI. Falls back to a direct write if queueing
		// is disabled.
		if s.ChatQueues != nil {
			s.ChatQueues.Submit(projectRoot, sessionID, heads.QueuedMessage{ID: msg.ID, Content: msg.Content}, msg.Queued)
			return
		}
		line, err := claudestream.UserMessageLine(msg.Content)
		if err != nil {
			log.Printf("chat ws: bad user_message content for %q: %v", sessionID, err)
			return
		}
		if err := s.Sessions.Write(sessionID, line); err != nil {
			log.Printf("chat ws: write user message to %q: %v", sessionID, err)
		}
	case "dequeue":
		// Recall a still-queued message (Up-arrow edit): drop it from the queue.
		if s.ChatQueues != nil && msg.ID != "" {
			s.ChatQueues.Dequeue(projectRoot, sessionID, msg.ID)
		}
	case "interrupt":
		id := fmt.Sprintf("hydra-interrupt-%d", chatInterruptSeq.Add(1))
		if err := s.Sessions.Write(sessionID, claudestream.InterruptLine(id)); err != nil {
			log.Printf("chat ws: write interrupt to %q: %v", sessionID, err)
		} else if s.ChatQueues != nil {
			// The CLI answers an interrupt by ending the turn with a `result`
			// line but fires NO Stop hook, so status.json would stay "running"
			// forever. Mark the interrupt; the turn-end drain consumes it and
			// writes the resting status itself (see ChatQueueManager.OnTurnEnd).
			s.ChatQueues.MarkInterrupted(sessionID)
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
// already delivered by the transcript backfill. Relayed uuids are added to
// skip so the sub-agent transcript tailer never re-delivers a line an (older)
// CLI also put on stdout. Returns false once the socket write fails.
func relayChatChunk(conn *safeConn, lb *claudestream.LineBuffer, chunk []byte, agentID string, skip map[string]struct{}, subs *subagentResolver) bool {
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
			skip[ev.UUID] = struct{}{}
		}
		// A sub-agent line: emit its Task-tool linkage (once) ahead of the event
		// so the client can fold it into the right card as it renders.
		if ev.IsSidechain && ev.AgentID != "" {
			if !subs.resolve(conn, ev.AgentID, ev.SessionID) {
				return false
			}
		}
		if !sendChatEventLine(conn, line, agentID) {
			return false
		}
	}
	return true
}

// subagentPollInterval is how often a chat connection scans the session's
// subagents/ dir for transcript growth. Current CLIs don't put a sub-agent's
// inner steps on the main stdout (see claudestream.SubagentTailer), so this
// tail is the only live source of sub-agent activity.
const subagentPollInterval = 700 * time.Millisecond

// tailSubagentGrowth polls the sub-agent transcripts of dir's newest session
// and sends each Poll's growth on out until stop closes. Runs as a goroutine
// per chat connection; the pump goroutine owns all socket writes and dedup.
func tailSubagentGrowth(dir string, stop <-chan struct{}, out chan<- []claudestream.SubagentGrowth) {
	tail := claudestream.NewSubagentTailer(dir, claudestream.DefaultBackfillBytes)
	ticker := time.NewTicker(subagentPollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			growth := tail.Poll()
			if len(growth) == 0 {
				continue
			}
			select {
			case out <- growth:
			case <-stop:
				return
			}
		}
	}
}

// tailNotifications polls the newest session's main transcript for
// <task-notification> records and sends each Poll's growth on out until stop
// closes. Runs as a goroutine per chat connection; the pump goroutine owns all
// socket writes and dedup. These records (a background/async sub-agent's
// completion) are never on the parent stdout, so this is the only live source
// for settling a finished background sub-agent's card.
func tailNotifications(dir string, stop <-chan struct{}, out chan<- [][]byte) {
	tail := claudestream.NewNotificationTailer(dir)
	ticker := time.NewTicker(subagentPollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			lines := tail.Poll()
			if len(lines) == 0 {
				continue
			}
			select {
			case out <- lines:
			case <-stop:
				return
			}
		}
	}
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
// It also backfills each sub-agent (Task tool) transcript recorded for the
// session (the subagents/*.jsonl siblings, not the main transcript, carry
// sub-agent activity), each preceded by its subagent_meta frame.
func backfillChatHistory(conn *safeConn, agentID, dir string, subs *subagentResolver) map[string]struct{} {
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
	// Sub-agent history lives in per-session subagents/*.jsonl siblings; relay
	// each with its meta so the client rebuilds the sub-agent cards on reconnect.
	sessionID := strings.TrimSuffix(filepath.Base(transcript), ".jsonl")
	subTranscripts, subUUIDs := claudestream.TailSubagentTranscripts(dir, sessionID, claudestream.DefaultBackfillBytes)
	for u := range subUUIDs {
		uuids[u] = struct{}{}
	}
	for _, sub := range subTranscripts {
		if subs != nil {
			subs.seen[sub.AgentID] = struct{}{}
		}
		if !sendSubagentMeta(conn, sub.AgentID, sub.Meta) {
			return uuids
		}
		for _, line := range sub.Lines {
			if !sendChatEventLine(conn, line, agentID) {
				return uuids
			}
		}
	}
	return uuids
}

// chatTranscriptPath resolves the head's newest Claude transcript file, or ""
// when there's no worktree/dir/file yet.
func chatTranscriptPath(worktree string) string {
	return claudestream.LatestTranscript(claudeProjectDir(worktree))
}

// chatHistoryFrame answers a load_before: a batch of older conversation lines
// (oldest-first, ready to prepend) plus done=true once the transcript start is
// reached. Sent as raw claude_event lines so the client reduces them exactly
// like the initial replay.
type chatHistoryFrame struct {
	terminalEvent
	Events []json.RawMessage `json:"events"`
	Done   bool              `json:"done"`
}

// sendChatHistoryBefore relays the conversation batch older than beforeUUID (the
// client's current oldest line) for infinite scroll. A missing transcript or
// empty before-uuid yields an empty, done frame so the client stops asking.
func sendChatHistoryBefore(conn *safeConn, worktree, agentID, beforeUUID string) {
	frame := chatHistoryFrame{terminalEvent: terminalEvent{Type: "history_before"}, Done: true}
	transcript := chatTranscriptPath(worktree)
	if transcript != "" && beforeUUID != "" {
		lines, done, err := claudestream.HistoryBefore(transcript, beforeUUID, claudestream.HistoryBatchBytes)
		if err != nil {
			log.Printf("chat ws: history before for %q: %v", agentID, err)
		} else {
			frame.Done = done
			for _, line := range lines {
				frame.Events = append(frame.Events, json.RawMessage(line))
			}
		}
	}
	data, err := json.Marshal(frame)
	if err != nil {
		return
	}
	_ = conn.WriteMessage(websocket.TextMessage, data)
}

// claudeProjectDir resolves the Claude project directory recording a
// worktree's transcripts (~/.claude/projects/<worktree-slug>), or "" when it
// can't be determined.
func claudeProjectDir(worktree string) string {
	home, err := os.UserHomeDir()
	if err != nil || worktree == "" {
		return ""
	}
	return filepath.Join(home, ".claude", "projects", paths.ClaudeProjectsSlug(worktree))
}

// pumpChatOutput relays a chat session's output to the socket until the
// session exits or the socket dies: transcript backfill first (durable
// history), then the scrollback-ring replay (recent events the transcript may
// not carry, deduped by uuid), then replay_done, then the queued-message
// snapshot, then live events - merged with live sub-agent transcript growth
// (the tail goroutine; current CLIs keep sub-agent steps off the main stdout).
func (s *Server) pumpChatOutput(conn *safeConn, att *session.Attachment, projectRoot, agentID, worktree string) {
	dir := claudeProjectDir(worktree)
	subs := newSubagentResolver(dir)
	skip := backfillChatHistory(conn, agentID, dir, subs)
	if skip == nil {
		skip = map[string]struct{}{}
	}

	lb := &claudestream.LineBuffer{}
	// Attach queues the ring snapshot synchronously before returning, so a
	// non-blocking receive here reliably distinguishes "history exists" from
	// "nothing yet" - the client needs replay_done to know when the live
	// stream starts.
	select {
	case data, ok := <-att.Output:
		if ok && !relayChatChunk(conn, lb, data, agentID, skip, subs) {
			return
		}
	default:
	}
	sendTerminalEvent(conn, "replay_done")

	// Replay the head's queued (not-yet-sent) messages so this client renders
	// the pending bubbles, then - if the head is sitting idle - kick the queue
	// so a restored-from-disk queue drains even without a live turn to end it.
	if s.ChatQueues != nil {
		if frame, err := json.Marshal(chatQueueFrame{
			terminalEvent: terminalEvent{Type: "queue"},
			Messages:      s.ChatQueues.List(projectRoot, agentID),
		}); err == nil {
			_ = conn.WriteMessage(websocket.TextMessage, frame)
		}
		s.ChatQueues.OnAttach(projectRoot, agentID)
	}

	// Live sub-agent activity: tail the session's subagents/*.jsonl growth (its
	// inner steps) and the main transcript's <task-notification> records (a
	// background/async sub-agent's completion) in goroutines and relay both here,
	// so all socket writes and uuid dedup stay on this goroutine.
	var subGrowth chan []claudestream.SubagentGrowth
	var notif chan [][]byte
	if dir != "" {
		subGrowth = make(chan []claudestream.SubagentGrowth, 1)
		notif = make(chan [][]byte, 1)
		stop := make(chan struct{})
		defer close(stop)
		go tailSubagentGrowth(dir, stop, subGrowth)
		go tailNotifications(dir, stop, notif)
	}

	for {
		select {
		case <-att.Done:
			return
		case growth := <-subGrowth:
			for _, g := range growth {
				for _, line := range g.Lines {
					ev, ok := claudestream.ParseEvent(line)
					if !ok {
						continue
					}
					if ev.UUID != "" {
						if _, dup := skip[ev.UUID]; dup {
							continue
						}
						skip[ev.UUID] = struct{}{}
					}
					if !subs.resolve(conn, g.AgentID, g.SessionID) {
						return
					}
					if !sendChatEventLine(conn, line, agentID) {
						return
					}
				}
			}
		case lines := <-notif:
			// A background/async sub-agent's completion notification, off the main
			// transcript (never on stdout). Relay it verbatim - the client folds it
			// into a notice and settles the matching sub-agent card. Dedup the
			// attachment copy by uuid against stdout/backfill; the queue-operation
			// copy has none, so the client dedups the duplicate by content.
			for _, line := range lines {
				if ev, ok := claudestream.ParseEvent(line); ok && ev.UUID != "" {
					if _, dup := skip[ev.UUID]; dup {
						continue
					}
					skip[ev.UUID] = struct{}{}
				}
				if !sendChatEventLine(conn, line, agentID) {
					return
				}
			}
		case data, ok := <-att.Output:
			if !ok {
				return
			}
			if !relayChatChunk(conn, lb, data, agentID, skip, subs) {
				return
			}
		}
	}
}
