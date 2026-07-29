package http

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"braces.dev/errtrace"
	"github.com/gorilla/websocket"
	"github.com/trolleyman/hydra/internal/chat"
	"github.com/trolleyman/hydra/internal/claudestream"
	"github.com/trolleyman/hydra/internal/heads"
	"github.com/trolleyman/hydra/internal/paths"
	"github.com/trolleyman/hydra/internal/session"
)

// Chat-mode framing for the terminal WebSocket. A chat-mode
// head shares /ws/.../terminal with terminal heads, but every frame is text:
//
//	server -> client: the shared control events (status, diff_refresh), plus
//	  {"type":"state_snapshot","state":<projection>} for the head's current
//	  state, {"type":"chat_event","event":<normalized event>} per live event,
//	  {"type":"chat_history",...} for a paged window, and
//	  {"type":"replay_done"} once the initial window has been relayed.
//	client -> server: {"type":"user_message","content":[<content blocks>]} to
//	  deliver a user turn, and {"type":"interrupt"} to cancel the in-flight
//	  turn. Binary frames and resize messages are ignored (no PTY).
//
// Every chat frame carries provider-neutral normalized events (internal/chat).
// The raw per-provider stdout relay this started as is gone: chat mode is only
// permitted for the providers internal/chat normalizes (see
// sandbox.AgentArgv), and the daemon ingests their stdout itself
// (Registry.SetOnChatLine -> Manager.ObserveProviderLine), so the socket never
// needs to carry a provider's own wire format.

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
	// Cursor is the opaque normalized-event history cursor of a
	// load_events_before (infinite scroll) request - the daemon returns the
	// batch older than it, newest-first.
	Cursor string `json:"cursor,omitempty"`
	Limit  int    `json:"limit,omitempty"`
	// Content is the content-block array of a user_message, forwarded to the
	// CLI verbatim (the client owns the block shapes; the daemon only wraps
	// them in the stdin envelope).
	Content json.RawMessage `json:"content,omitempty"`
	// Model is the set_model target (a CLI alias like "sonnet").
	Model string `json:"model,omitempty"`
	// Command is the shell command of a shell_command frame (the text after the
	// composer's leading "!"), run in the head's sandbox and fed to the agent.
	Command string `json:"command,omitempty"`
	// Response is a control_response payload (e.g. AskUserQuestion answers),
	// forwarded verbatim like Content.
	Response json.RawMessage `json:"response,omitempty"`
	// File is the <output-file> path of a task_output request: the background
	// task's output file as the SANDBOXED agent saw it (its private /tmp).
	File string `json:"file,omitempty"`
	// SubID is the sub-agent whose full step history the client wants (it opened
	// that sub-agent's tab). Unlike the main window this isn't paginated: a
	// sub-agent's steps may sit entirely outside the loaded main-conversation
	// window, so the client fetches them directly rather than scrolling to them.
	SubID string `json:"sub_id,omitempty"`
}

// chatTaskOutputFrame answers a task_output request: the (tail of the)
// background task's output file, or an error when it can't be read.
type chatTaskOutputFrame struct {
	terminalEvent
	File    string `json:"file"`
	Content string `json:"content,omitempty"`
	Error   string `json:"error,omitempty"`
}

// chatQueueFrame is the server -> client snapshot of a head's queued messages,
// sent right after replay_done so a (re)attaching client renders the pending
// bubbles (the queue survives disconnects/restarts daemon-side).
type chatQueueFrame struct {
	terminalEvent
	Messages []heads.QueuedMessage `json:"messages"`
}

// chatPendingQuestionsFrame is the daemon's authoritative answer to "which
// question cards can still be answered?", sent just before replay_done. A
// question's request_id is durable - it is stored as an interaction_requested
// event and replayed into the transcript on every reload - but the CLI's
// request behind it dies with the turn that raised it, so the client cannot
// tell a live card from a dead one on its own. The daemon can: it watches the
// requests come and go on stdout (see claudestream.RingFilter.PendingAsks).
// The frame is omitted entirely when that isn't knowable (a driver-backed
// provider), which the client reads as "fall back to your own heuristic" - an
// empty Requests list means a definite none.
type chatPendingQuestionsFrame struct {
	terminalEvent
	Requests []claudestream.PendingAsk `json:"requests"`
}

// chatQuestionExpiredFrame tells the client an answer it just sent was dropped:
// the request had already been retired, so writing it to the CLI's stdin would
// achieve nothing. The card flips to expired (offering to send the answers as
// an ordinary message) instead of settling on an "Answered" that never was.
type chatQuestionExpiredFrame struct {
	terminalEvent
	RequestID string `json:"requestId"`
}

type normalizedChatEventFrame struct {
	terminalEvent
	Event chat.Event `json:"event"`
}

type chatStateSnapshotFrame struct {
	terminalEvent
	State chat.Projection `json:"state"`
}

type normalizedChatHistoryFrame struct {
	terminalEvent
	Events     []chat.Event `json:"events"`
	NextCursor string       `json:"next_cursor,omitempty"`
	Done       bool         `json:"done"`
}

// hasPendingAsk reports whether requestID is one of the requests the CLI is
// still blocked on. The tracked set holds AskUserQuestion requests only, which
// is sound because a question answer is the only control_response a chat client
// sends (the other gate, ExitPlanMode, is auto-approved daemon-side and never
// reaches the client - see claudestream.RingFilter.OnPlanApproval).
func hasPendingAsk(pending []claudestream.PendingAsk, requestID string) bool {
	for _, a := range pending {
		if a.RequestID == requestID {
			return true
		}
	}
	return false
}

// handleChatClientMessage services one text frame from a chat client.
// projectRoot locates the head's on-disk message queue; worktree is the cwd a
// "!command" runs in; conn is needed to answer the frames that carry a reply
// (load_events_before, load_subagent, task_output).
func (s *Server) handleChatClientMessage(conn *safeConn, projectRoot, worktree, sessionID string, data []byte) {
	var msg chatClientMsg
	if err := json.Unmarshal(data, &msg); err != nil {
		log.Printf("chat ws: bad client frame for %q: %v", sessionID, err)
		return
	}
	switch msg.Type {
	case "load_events_before":
		s.sendNormalizedHistory(conn, sessionID, msg.Cursor, msg.Limit)
		return
	case "load_subagent":
		// The client opened a sub-agent's tab: send that sub-agent's full step
		// history so it renders even when the sub-agent ran before the loaded
		// main-conversation window.
		s.sendSubagentEvents(conn, sessionID, msg.SubID)
		return
	case "task_output":
		// The expandable background-task chip asking for the task's output file
		// (the <output-file> path its <task-notification> carried). sessionID is
		// the head ID for a chat socket, which keys the head's private /tmp.
		sendChatTaskOutput(conn, projectRoot, sessionID, msg.File)
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
		if err := s.Sessions.SendChatUser(sessionID, msg.Content); err != nil {
			log.Printf("chat ws: write user message to %q: %v", sessionID, err)
		}
	case "shell_command":
		// The user typed "!<command>" in the composer: run it in the head's
		// sandbox, show its output as a card, and feed the output to the agent as a
		// user turn. Runs on its own goroutine so a slow command never blocks the
		// socket read loop, and against context.Background so it (and its delivery)
		// completes even if the browser disconnects mid-run.
		if strings.TrimSpace(msg.Command) == "" {
			return
		}
		go s.runChatShellCommand(conn, projectRoot, worktree, sessionID, msg.ID, msg.Command)
	case "shell_stop":
		// Stop button on a running "!command" card: cancel its context, which
		// kills the sandboxed process. The run then settles as "stopped" with
		// whatever output it produced (see runChatShellCommand).
		if msg.ID != "" {
			if v, ok := s.shellCancels.Load(msg.ID); ok {
				if cancel, ok := v.(context.CancelFunc); ok {
					cancel()
				}
			}
		}
	case "dequeue":
		// Recall a still-queued message (Up-arrow edit): drop it from the queue.
		if s.ChatQueues != nil && msg.ID != "" {
			s.ChatQueues.Dequeue(projectRoot, sessionID, msg.ID)
		}
	case "interrupt":
		if err := s.Sessions.InterruptChat(sessionID); err != nil {
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
		if err := s.Sessions.SetChatModel(sessionID, msg.Model); err != nil {
			log.Printf("chat ws: write set_model to %q: %v", sessionID, err)
			return
		}
		if s.ChatEvents != nil {
			_, _ = s.ChatEvents.Append(sessionID, "model_changed", map[string]any{"model": msg.Model})
		}
	case "control_response":
		// The client answers a CLI control_request (AskUserQuestion) with a
		// payload the daemon forwards verbatim - unless the request it quotes is
		// no longer one the CLI is blocked on (its turn ended first), in which
		// case forwarding it would put a line on stdin that nothing will ever
		// read. Say so instead, so the card can stop pretending it was answered.
		if reqID := claudestream.ControlResponseRequestID(msg.Response); reqID != "" {
			if pending, known := s.Sessions.PendingQuestions(sessionID); known && !hasPendingAsk(pending, reqID) {
				log.Printf("chat ws: control_response for retired request %q on %q - dropped", reqID, sessionID)
				if frame, err := json.Marshal(chatQuestionExpiredFrame{
					terminalEvent: terminalEvent{Type: "question_expired"},
					RequestID:     reqID,
				}); err == nil {
					_ = conn.WriteMessage(websocket.TextMessage, frame)
				}
				return
			}
		}
		if err := s.Sessions.RespondChat(sessionID, msg.Response); err != nil {
			log.Printf("chat ws: write control_response to %q: %v", sessionID, err)
		}
	case "resize":
		// Chat sessions have no PTY; nothing to resize.
	default:
		log.Printf("chat ws: unknown client frame type %q for %q", msg.Type, sessionID)
	}
}

// shellOutputFrame streams one chunk of a running "!command"'s combined output
// to the client so the card fills in live (ephemeral - the durable record is the
// user_message the command settles into). Keyed by the send frame's id so the
// client appends it to the right running card.
type shellOutputFrame struct {
	terminalEvent
	ID    string `json:"id"`
	Chunk string `json:"chunk"`
}

// runChatShellCommand executes a composer "!command" in the head's sandbox and
// delivers the result both to the UI (a shell-command card, streamed live) and
// to the agent (a user turn carrying the command + output). Runs on its own
// goroutine. conn streams the live output; a closed socket just drops the live
// frames (the durable settle still persists).
func (s *Server) runChatShellCommand(conn *safeConn, projectRoot, worktree, sessionID, msgID, command string) {
	// Make the run cancellable so a shell_stop frame can kill it mid-flight. Keyed
	// by the send id; registered for its whole lifetime and cleaned up on exit.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if msgID != "" {
		s.shellCancels.Store(msgID, cancel)
		defer s.shellCancels.Delete(msgID)
	}
	onChunk := func(chunk string) {
		frame, err := json.Marshal(shellOutputFrame{
			terminalEvent: terminalEvent{Type: "shell_output"}, ID: msgID, Chunk: chunk,
		})
		if err == nil {
			_ = conn.WriteMessage(websocket.TextMessage, frame)
		}
	}
	res, err := heads.RunShellCommand(ctx, projectRoot, worktree, command, onChunk)
	if err != nil {
		// A launch/spec failure (e.g. no worktree): surface it in the card's output
		// so the user isn't left with a silently-hung "running" card.
		if res.Output == "" {
			res.Output = "hydra: could not run command: " + err.Error()
		}
		if res.ExitCode == 0 {
			res.ExitCode = -1
		}
	}
	content := shellCommandUserContent(res)
	if s.ChatQueues != nil {
		s.ChatQueues.SubmitShellResult(projectRoot, sessionID, msgID, content, res)
		return
	}
	// No queue manager (queueing disabled): deliver to the CLI directly. Without
	// the event sink there is no durable card, but the agent still gets the output.
	if err := s.Sessions.SendChatUser(sessionID, content); err != nil {
		log.Printf("chat ws: deliver shell command to %q: %v", sessionID, err)
	}
}

// shellCommandUserContent renders a shell-command result as the user-turn
// content the agent reads: the command, its exit status, and the (capped)
// output in a fenced block. It is also what the CLI echoes back, so it must be
// stable text (the card itself renders from the structured `shell` payload).
func shellCommandUserContent(res heads.ShellCommandResult) json.RawMessage {
	var b strings.Builder
	b.WriteString("I ran a shell command from the chat.\n\n")
	b.WriteString("Command:\n```\n")
	b.WriteString(res.Command)
	b.WriteString("\n```\n\n")
	if res.TimedOut {
		fmt.Fprintf(&b, "The command timed out after %s and was killed.\n\n", heads.ShellCommandTimeout)
	} else if res.Stopped {
		b.WriteString("The command was stopped before it finished.\n\n")
	} else {
		fmt.Fprintf(&b, "Exit code: %d\n\n", res.ExitCode)
	}
	output := strings.TrimRight(res.Output, "\n")
	if res.Truncated {
		b.WriteString("Output (truncated to the last part of a longer log):\n")
	} else {
		b.WriteString("Output:\n")
	}
	b.WriteString("```\n")
	if output == "" {
		b.WriteString("(no output)")
	} else {
		b.WriteString(output)
	}
	b.WriteString("\n```")
	blocks := []map[string]any{{"type": "text", "text": b.String()}}
	raw, err := json.Marshal(blocks)
	if err != nil {
		return json.RawMessage(`[{"type":"text","text":"(shell command output unavailable)"}]`)
	}
	return raw
}

func (s *Server) sendNormalizedHistory(conn *safeConn, agentID, cursor string, limit int) {
	if s.ChatEvents == nil {
		return
	}
	events, next, done, err := s.ChatEvents.Before(agentID, cursor, limit)
	if err != nil {
		log.Printf("chat ws: normalized history for %q: %v", agentID, err)
		return
	}
	data, err := json.Marshal(normalizedChatHistoryFrame{
		terminalEvent: terminalEvent{Type: "chat_history"},
		Events:        events, NextCursor: next, Done: done,
	})
	if err == nil {
		_ = conn.WriteMessage(websocket.TextMessage, data)
	}
}

// subagentEventsFrame answers a load_subagent: one sub-agent's full step
// history (its sidechain events), so the client can render the sub-agent's tab
// regardless of how far the main conversation has been paged back.
type subagentEventsFrame struct {
	terminalEvent
	AgentID string       `json:"agentId"`
	Events  []chat.Event `json:"events"`
}

func (s *Server) sendSubagentEvents(conn *safeConn, agentID, subID string) {
	if s.ChatEvents == nil || subID == "" {
		return
	}
	events, err := s.ChatEvents.SubagentEvents(agentID, subID)
	if err != nil {
		log.Printf("chat ws: subagent events for %q/%q: %v", agentID, subID, err)
		return
	}
	data, err := json.Marshal(subagentEventsFrame{
		terminalEvent: terminalEvent{Type: "subagent_events"},
		AgentID:       subID,
		Events:        events,
	})
	if err == nil {
		_ = conn.WriteMessage(websocket.TextMessage, data)
	}
}

func sendNormalizedEvent(conn *safeConn, event chat.Event) bool {
	data, err := json.Marshal(normalizedChatEventFrame{terminalEvent: terminalEvent{Type: "chat_event"}, Event: event})
	if err != nil {
		return true
	}
	return conn.WriteMessage(websocket.TextMessage, data) == nil
}

// chatErrorFrame tells the client the head's normalized event log could not be
// opened, so this connection will render nothing. It has no fallback to degrade
// to (the raw provider relay is gone), and a silently empty chat reads exactly
// like a head that never said anything - so the failure is surfaced instead.
type chatErrorFrame struct {
	terminalEvent
	Error string `json:"error"`
}

// sendChatError reports a fatal attach failure to the client and the daemon log.
func sendChatError(conn *safeConn, agentID, what string, err error) {
	log.Printf("chat ws: ERROR %s for %q: %v - this connection will render no history", what, agentID, err)
	frame, mErr := json.Marshal(chatErrorFrame{
		terminalEvent: terminalEvent{Type: "chat_error"},
		Error:         fmt.Sprintf("%s failed: %v", what, err),
	})
	if mErr != nil {
		return
	}
	_ = conn.WriteMessage(websocket.TextMessage, frame)
}

// taskOutputMaxBytes caps how much of a background task's output file one
// task_output reply carries (the tail - the end of a long log is what matters).
const taskOutputMaxBytes = 256 * 1024

// validTaskOutputPath accepts only the path shape the CLI's <task-notification>
// records actually carry - an absolute, clean /tmp/.../tasks/<id>.output file -
// so the socket can't be used to read arbitrary files.
func validTaskOutputPath(file string) bool {
	return strings.HasPrefix(file, "/tmp/") &&
		filepath.Clean(file) == file &&
		!strings.Contains(file, "..") &&
		strings.Contains(file, "/tasks/") &&
		strings.HasSuffix(file, ".output")
}

// sendChatTaskOutput answers a task_output request with the (tail of the)
// background task's output file. The path arrives as the SANDBOXED agent saw it
// (/tmp/claude-.../tasks/<id>.output); on a sandboxed head /tmp is the head's
// private dir (heads.HeadTmpDir), so that translation is tried first and the
// raw path second (an unsandboxed head whose /tmp is the real one).
func sendChatTaskOutput(conn *safeConn, projectRoot, headID, file string) {
	frame := chatTaskOutputFrame{terminalEvent: terminalEvent{Type: "task_output"}, File: file}
	if !validTaskOutputPath(file) {
		frame.Error = "invalid output file path"
	} else {
		var candidates []string
		if tmp := heads.HeadTmpDir(projectRoot, headID); tmp != "" {
			candidates = append(candidates, filepath.Join(tmp, strings.TrimPrefix(file, "/tmp/")))
		}
		candidates = append(candidates, file)
		frame.Error = "output file not found (it may have been cleaned up)"
		for _, p := range candidates {
			content, err := readFileTail(p, taskOutputMaxBytes)
			if err == nil {
				frame.Content, frame.Error = content, ""
				break
			}
		}
	}
	data, err := json.Marshal(frame)
	if err != nil {
		return
	}
	_ = conn.WriteMessage(websocket.TextMessage, data)
}

// readFileTail reads up to the last maxBytes of a file (whole file when
// smaller), dropping a leading partial line after a mid-file start.
func readFileTail(path string, maxBytes int64) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	truncated := false
	if info.Size() > maxBytes {
		if _, err := f.Seek(info.Size()-maxBytes, io.SeekStart); err != nil {
			return "", errtrace.Wrap(err)
		}
		truncated = true
	}
	data, err := io.ReadAll(f)
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	if truncated {
		if idx := bytes.IndexByte(data, '\n'); idx >= 0 {
			data = data[idx+1:]
		}
		return "[... earlier output truncated ...]\n" + string(data), nil
	}
	return string(data), nil
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

// pumpChatOutput relays a chat session's normalized events to the socket until
// the session exits or the socket dies: the current-state snapshot and the
// newest history window first, then replay_done, then the queued-message
// snapshot, then live events.
//
// The head's own stdout is NOT a source here. The daemon ingests it centrally
// (Registry.SetOnChatLine -> Manager.ObserveProviderLine) whether or not a
// browser is attached, so this pump only reads the durable normalized log the
// manager writes. What it does still do is drive the two transcript tails: a
// sub-agent's inner steps and a background sub-agent's completion notification
// never reach stdout, so they are polled here and handed to the manager, which
// normalizes them onto the same log and back out through `normalized` below.
func (s *Server) pumpChatOutput(conn *safeConn, att *session.Attachment, projectRoot, agentID, worktree string) {
	var normalized <-chan chat.Event
	if s.ChatEvents == nil {
		sendChatError(conn, agentID, "chat events unavailable", errors.New("no chat event manager"))
	} else if err := s.ChatEvents.Flush(agentID); err != nil {
		sendChatError(conn, agentID, "flush normalized events", err)
	} else if snapshot, live, cancel, err := s.ChatEvents.Watch(agentID); err != nil {
		sendChatError(conn, agentID, "watch normalized events", err)
	} else {
		defer cancel()
		normalized = live
		if data, err := json.Marshal(chatStateSnapshotFrame{terminalEvent: terminalEvent{Type: "state_snapshot"}, State: snapshot}); err == nil {
			_ = conn.WriteMessage(websocket.TextMessage, data)
		}
		// The initial display window ends exactly at the snapshot watermark;
		// live contains only events appended after it.
		s.sendNormalizedHistory(conn, agentID, fmt.Sprintf("%d", snapshot.Through+1), 100)
	}
	dir := claudeProjectDir(worktree)
	// Which of the questions just replayed is the CLI actually still blocked on.
	// Ahead of replay_done, so the client has it when it settles the transcript.
	if pending, known := s.Sessions.PendingQuestions(agentID); known {
		if pending == nil {
			pending = []claudestream.PendingAsk{} // a definite none, not a null
		}
		if frame, err := json.Marshal(chatPendingQuestionsFrame{
			terminalEvent: terminalEvent{Type: "pending_questions"},
			Requests:      pending,
		}); err == nil {
			_ = conn.WriteMessage(websocket.TextMessage, frame)
		}
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
	// background/async sub-agent's completion) in goroutines and feed both to
	// the event manager here, so ingestion stays on this goroutine.
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
		case ev, ok := <-normalized:
			if !ok {
				normalized = nil
				continue
			}
			if !sendNormalizedEvent(conn, ev) {
				return
			}
		case growth := <-subGrowth:
			for _, g := range growth {
				meta, _ := claudestream.ReadSubagentMeta(dir, g.SessionID, g.AgentID)
				for _, line := range g.Lines {
					if _, ok := claudestream.ParseEvent(line); !ok {
						continue
					}
					if s.ChatEvents != nil {
						// Idempotent: the manager keys each event by source id, so a
						// reconnect re-reading this sub-agent's backfill window (or a
						// second browser tailing the same file) appends nothing new.
						s.ChatEvents.ObserveClaudeSidechain(agentID, g.AgentID, meta, line)
					}
				}
			}
		case lines := <-notif:
			// A background/async sub-agent's completion notification, off the main
			// transcript (never on stdout). This is the only live source that
			// settles a finished background sub-agent's card.
			for _, line := range lines {
				if s.ChatEvents != nil {
					s.ChatEvents.ObserveProviderLine(agentID, "claude", line)
				}
			}
		case _, ok := <-att.Output:
			// Chat rendering comes from the normalized log, not this stream - the
			// daemon already ingests the head's stdout centrally. Drain and discard
			// so the per-attacher buffer doesn't sit full of stale chunks, and so a
			// closed channel still ends the pump.
			if !ok {
				return
			}
		}
	}
}
