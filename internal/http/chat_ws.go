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
	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/chat"
	"github.com/trolleyman/hydra/internal/claudestream"
	"github.com/trolleyman/hydra/internal/heads"
	"github.com/trolleyman/hydra/internal/paths"
	"github.com/trolleyman/hydra/internal/sandbox"
	"github.com/trolleyman/hydra/internal/session"
)

// Chat-mode framing for the terminal WebSocket. A chat-mode
// head shares /ws/.../terminal with terminal heads, but every frame is text:
//
//	server -> client: the shared control events (status, diff_refresh), plus
//	  {"type":"state_snapshot","state":<projection>} for the head's current
//	  state, {"type":"chat_event","event":<chat event>} per live event,
//	  {"type":"chat_history",...} for a paged window, and
//	  {"type":"replay_done"} once the initial window has been relayed.
//	client -> server: {"type":"user_message","content":[<content blocks>]} to
//	  deliver a user turn, and {"type":"interrupt"} to cancel the in-flight
//	  turn. Binary frames and resize messages are ignored (no PTY).
//
// Every chat frame carries provider-neutral chat events (internal/chat).
// The raw per-provider stdout relay this started as is gone: chat mode is only
// permitted for the providers internal/chat normalizes (see
// sandbox.AgentArgv), and the daemon ingests their stdout itself
// (Registry.SetOnChatLine -> Manager.ObserveProviderLine), so the socket never
// needs to carry a provider's own wire format.

// Every frame on this socket is declared in api/openapi.yaml and generated for
// both Go and the browser (see docs/chat-mode.md), so the daemon cannot write a
// shape the client does not narrow on. The two converters below are the only
// seam: heads.QueuedMessage and claudestream.PendingAsk are domain types that
// happen to serialize identically, so they are copied into their wire
// counterparts here rather than being replaced wholesale.
func toAPIQueuedMessages(msgs []heads.QueuedMessage) []api.ChatQueuedMessage {
	out := make([]api.ChatQueuedMessage, 0, len(msgs))
	for _, m := range msgs {
		out = append(out, api.ChatQueuedMessage{Id: m.ID, Content: m.Content, Origin: m.Origin})
	}
	return out
}

func toAPIPendingAsks(asks []claudestream.PendingAsk) []api.ChatPendingAsk {
	out := make([]api.ChatPendingAsk, 0, len(asks))
	for _, a := range asks {
		out = append(out, api.ChatPendingAsk{RequestId: a.RequestID, ToolUseId: a.ToolUseID})
	}
	return out
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
	var msg api.ChatClientMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		log.Printf("chat ws: bad client frame for %q: %v", sessionID, err)
		return
	}
	switch msg.Type {
	case "load_events_before":
		s.sendChatHistory(conn, sessionID, msg.Cursor, msg.Limit)
		return
	case "load_subagent":
		// The client opened a sub-agent's tab: send that sub-agent's full step
		// history so it renders even when the sub-agent ran before the loaded
		// main-conversation window.
		s.sendSubagentEvents(conn, sessionID, msg.SubId)
		return
	case "task_output":
		// The expandable background-task chip asking for the task's output file
		// (the <output-file> path its <task-notification> carried). The private
		// /tmp is keyed by the HEAD, and a review slot shares the head's (see
		// StartReviewSession), so resolve back through the slot id.
		tmpOwner := sessionID
		if head, _, ok := heads.SplitSlotID(sessionID); ok {
			tmpOwner = head
		}
		sendChatTaskOutput(conn, projectRoot, tmpOwner, msg.File)
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
			s.ChatQueues.Submit(projectRoot, sessionID, heads.QueuedMessage{ID: msg.Id, Content: msg.Content}, msg.Queued)
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
		go s.runChatShellCommand(conn, projectRoot, worktree, sessionID, msg.Id, msg.Command)
	case "shell_stop":
		// Stop button on a running "!command" card: cancel its context, which
		// kills the sandboxed process. The run then settles as "stopped" with
		// whatever output it produced (see runChatShellCommand).
		if msg.Id != "" {
			if v, ok := s.shellCancels.Load(msg.Id); ok {
				if cancel, ok := v.(context.CancelFunc); ok {
					cancel()
				}
			}
		}
	case "dequeue":
		// Recall a still-queued message (Up-arrow edit): drop it from the queue.
		if s.ChatQueues != nil && msg.Id != "" {
			s.ChatQueues.Dequeue(projectRoot, sessionID, msg.Id)
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
			changed := chat.ModelChanged{}
			changed.Model = msg.Model
			_, _ = s.ChatEvents.Append(sessionID, changed)
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
				writeFrame(conn, api.ChatQuestionExpiredFrame{Type: api.QuestionExpired, RequestId: reqID})
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
		writeFrame(conn, api.ChatShellOutputFrame{Type: api.ShellOutput, Id: msgID, Chunk: chunk})
	}
	agentType := sandbox.AgentTypeBash
	if s.Sessions != nil {
		if sess, ok := s.Sessions.Get(sessionID); ok {
			agentType = sess.AgentType
		}
	}
	res, err := heads.RunShellCommand(ctx, projectRoot, worktree, sessionID, agentType, command, onChunk)
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
		s.ChatQueues.SubmitShellResult(projectRoot, sessionID, msgID, content, &api.ChatShellResult{
			Command: res.Command, Output: res.Output, ExitCode: res.ExitCode,
			Truncated: res.Truncated, TimedOut: res.TimedOut, Stopped: res.Stopped,
		})
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

func (s *Server) sendChatHistory(conn *safeConn, agentID, cursor string, limit int) {
	if s.ChatEvents == nil {
		return
	}
	events, next, done, err := s.ChatEvents.Before(agentID, cursor, limit)
	if err != nil {
		log.Printf("chat ws: chat history for %q: %v", agentID, err)
		return
	}
	writeFrame(conn, api.ChatHistoryFrame{
		Type: api.ChatHistory, Events: events, NextCursor: next, Done: done,
	})
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
	writeFrame(conn, api.ChatSubagentEventsFrame{
		Type: api.SubagentEvents, AgentId: subID, Events: events,
	})
}

func sendChatEvent(conn *safeConn, event chat.Event) bool {
	data, err := json.Marshal(api.ChatEventFrame{Type: api.ChatEventFrameTypeChatEvent, Event: event})
	if err != nil {
		return true
	}
	return conn.WriteMessage(websocket.TextMessage, data) == nil
}

// sendChatError reports a fatal attach failure to the client and the daemon log.
func sendChatError(conn *safeConn, agentID, what string, err error) {
	log.Printf("chat ws: ERROR %s for %q: %v - this connection will render no history", what, agentID, err)
	writeFrame(conn, api.ChatErrorFrame{
		Type: api.ChatError, Error: fmt.Sprintf("%s failed: %v", what, err),
	})
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
	frame := api.ChatTaskOutputFrame{Type: api.ChatTaskOutputFrameTypeTaskOutput, File: file}
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
func claudeProjectDir(projectRoot, sessionID, worktree string) string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return paths.ClaudeProjectDirForSession(projectRoot, sessionID, home, worktree)
}

// pumpChatOutput relays a chat session's events to the socket until
// the session exits or the socket dies: the current-state snapshot and the
// newest history window first, then replay_done, then the queued-message
// snapshot, then live events.
//
// The head's own stdout is NOT a source here. The daemon ingests it centrally
// (Registry.SetOnChatLine -> Manager.ObserveProviderLine) whether or not a
// browser is attached, so this pump only reads the durable event log the
// manager writes. What it does still do is drive the two transcript tails: a
// sub-agent's inner steps and a background sub-agent's completion notification
// never reach stdout, so they are polled here and handed to the manager, which
// normalizes them onto the same log and back out through `events` below.
//
// Every key here is the SESSION id, not the head id. They are the same thing for
// a head's own chat tab, but a review slot is `<head>@review` (docs/review-agent.md)
// - its conversation, its queue and its pending questions are all its own, and
// keying any of them by the head would replay the head's transcript into the
// review pane.
// catchUpChatEvents brings a session's durable log fully up to date before it is
// snapshotted: first any commit that landed while nobody was ingesting the head's
// output (a merge run from the CLI or a host shell, an update-from-base a dead
// daemon never saw), then the ingest queue itself. Reconciling ahead of the
// snapshot is what makes such a commit replay in place rather than arrive as a
// live event after replay_done.
func (s *Server) catchUpChatEvents(sessionID string) error {
	s.ChatEvents.ReconcileCommits(sessionID, "")
	return errtrace.Wrap(s.ChatEvents.Flush(sessionID))
}

func (s *Server) pumpChatOutput(conn *safeConn, att *session.Attachment, projectRoot, sessionID, worktree string) {
	var events <-chan chat.Event
	if s.ChatEvents == nil {
		sendChatError(conn, sessionID, "chat events unavailable", errors.New("no chat event manager"))
	} else if err := s.catchUpChatEvents(sessionID); err != nil {
		sendChatError(conn, sessionID, "flush chat events", err)
	} else if snapshot, live, cancel, err := s.ChatEvents.Watch(sessionID); err != nil {
		sendChatError(conn, sessionID, "watch chat events", err)
	} else {
		defer cancel()
		events = live
		writeFrame(conn, api.ChatStateSnapshotFrame{Type: api.StateSnapshot, State: snapshot})
		// The initial display window ends exactly at the snapshot watermark;
		// live contains only events appended after it.
		s.sendChatHistory(conn, sessionID, fmt.Sprintf("%d", snapshot.Through+1), 100)
	}
	dir := claudeProjectDir(projectRoot, sessionID, worktree)
	// Which of the questions just replayed is the CLI actually still blocked on.
	// Ahead of replay_done, so the client has it when it settles the transcript.
	if pending, known := s.Sessions.PendingQuestions(sessionID); known {
		if pending == nil {
			pending = []claudestream.PendingAsk{} // a definite none, not a null
		}
		writeFrame(conn, api.ChatPendingQuestionsFrame{
			Type: api.PendingQuestions, Requests: toAPIPendingAsks(pending),
		})
	}
	sendReplayDone(conn)

	// Replay the head's queued (not-yet-sent) messages so this client renders
	// the pending bubbles, then - if the head is sitting idle - kick the queue
	// so a restored-from-disk queue drains even without a live turn to end it.
	if s.ChatQueues != nil {
		writeFrame(conn, api.ChatQueueFrame{
			Type: api.Queue, Messages: toAPIQueuedMessages(s.ChatQueues.List(projectRoot, sessionID)),
		})
		s.ChatQueues.OnAttach(projectRoot, sessionID)
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
		case ev, ok := <-events:
			if !ok {
				events = nil
				continue
			}
			if !sendChatEvent(conn, ev) {
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
						s.ChatEvents.ObserveClaudeSidechain(sessionID, g.AgentID, meta, line)
					}
				}
			}
		case lines := <-notif:
			// A background/async sub-agent's completion notification, off the main
			// transcript (never on stdout). This is the only live source that
			// settles a finished background sub-agent's card.
			for _, line := range lines {
				if s.ChatEvents != nil {
					s.ChatEvents.ObserveProviderLine(sessionID, "claude", line)
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
