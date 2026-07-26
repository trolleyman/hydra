package heads

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/claudestream"
	"github.com/trolleyman/hydra/internal/db"
	"github.com/trolleyman/hydra/internal/paths"
	"github.com/trolleyman/hydra/internal/session"
)

// Chat-mode message queue (server-authoritative, disk-persisted).
//
// A message the user sends while a turn is running is HELD here - in the
// daemon, not written to the CLI's stdin yet - and the WHOLE queue dumps at
// the next observed step of the running turn (a completed assistant line: a
// thinking block, a tool_use, a text block) or at the turn's end (`result`).
// The CLI injects mid-turn stdin messages into the running turn at its next
// step boundary, exactly like typing into the interactive terminal
// (spike-verified), so queued messages reach the agent quickly - in order, as
// one consecutive block - instead of waiting out the whole turn. Holding
// queued messages daemon-side (rather than client-side) means they survive
// closing the browser, navigating away, and a WS reconnect; persisting them to
// disk means they also survive a daemon restart. On (re)attach the daemon
// replays the queue so the client renders the pending bubbles, and the client
// can recall a still-queued message to edit it (dequeue) for as long as it
// hasn't drained.
//
// The store is just a persisted FIFO: it holds ONLY queued (not-yet-sent)
// messages, and the daemon empties it at the first step/turn-end it observes.
// Whether a fresh message is queued vs sent immediately is decided by the client
// (which knows, and shows, whether a turn is running) and passed in the frame -
// so the daemon needs no fragile turn-state seeding, only the stdout-driven
// drains (plus a kick whenever the head's own status shows it resting: on
// attach, on a queued submit that arrived after the turn actually ended, and
// when an interrupt settles idle - see kickIfResting and MarkInterrupted).

// QueuedMessage is one held user turn. ID is client-generated so the client can
// reconcile its optimistic bubble and target a dequeue; Content is the verbatim
// content-block array (the same shape a user_message carries).
type QueuedMessage struct {
	ID      string          `json:"id"`
	Content json.RawMessage `json:"content"`
}

// ChatQueue is one head's queue. All methods are safe for concurrent use.
type ChatQueue struct {
	mu   sync.Mutex
	path string
	msgs []QueuedMessage
	// sendMu serializes a drain's pops+writes: step/turn-end drains are
	// dispatched on their own goroutines (one per stdout line), so without it
	// two drains could pop in order but write to stdin out of order.
	sendMu sync.Mutex
}

// queueFile is the on-disk shape.
type queueFile struct {
	Messages []QueuedMessage `json:"messages"`
}

// LoadChatQueue reads a head's persisted queue (empty if none/corrupt). A
// missing file is the common case (a head that never queued anything).
func LoadChatQueue(projectRoot, id string) *ChatQueue {
	q := &ChatQueue{path: paths.GetChatQueueJsonFromProjectRoot(projectRoot, id)}
	if data, err := os.ReadFile(q.path); err == nil {
		var f queueFile
		if json.Unmarshal(data, &f) == nil {
			q.msgs = f.Messages
		}
	}
	return q
}

// persist writes the message list, removing the file when the queue empties.
// Called under q.mu.
func (q *ChatQueue) persist() {
	if len(q.msgs) == 0 {
		_ = os.Remove(q.path)
		return
	}
	data, err := json.Marshal(queueFile{Messages: q.msgs})
	if err != nil {
		return
	}
	// The queue dir is its own generated dir (.hydra/local/queue), covered by
	// the .hydra/local top-level gitignore, so a bare MkdirAll suffices.
	if err := os.MkdirAll(filepath.Dir(q.path), 0o755); err != nil {
		return
	}
	_ = paths.WriteFileIfChanged(q.path, string(data), 0o644)
}

// Enqueue appends a message to the back of the queue (a message the client sent
// while a turn was running).
func (q *ChatQueue) Enqueue(m QueuedMessage) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.msgs = append(q.msgs, m)
	q.persist()
}

// PopFront removes and returns the front message (the next to send when a turn
// ends), reporting ok=false when the queue is empty.
func (q *ChatQueue) PopFront() (m QueuedMessage, ok bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if len(q.msgs) == 0 {
		return QueuedMessage{}, false
	}
	m = q.msgs[0]
	q.msgs = q.msgs[1:]
	q.persist()
	return m, true
}

// Dequeue removes a still-queued message by id (the Up-arrow recall / edit),
// reporting whether it was found. A message already drained to stdin is gone
// from the queue, so this returns false for it.
func (q *ChatQueue) Dequeue(id string) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	for i, m := range q.msgs {
		if m.ID == id {
			q.msgs = append(q.msgs[:i:i], q.msgs[i+1:]...)
			q.persist()
			return true
		}
	}
	return false
}

// List returns a copy of the queued messages (for the on-attach replay).
func (q *ChatQueue) List() []QueuedMessage {
	q.mu.Lock()
	defer q.mu.Unlock()
	return append([]QueuedMessage(nil), q.msgs...)
}

// ChatQueueManager owns every chat head's queue for one daemon: it caches the
// per-head ChatQueue (loaded lazily from disk), writes drained messages to the
// session's stdin, and resolves a head's project root from the DB so the
// registry's turn-end callback - which only knows the agent id - can find the
// right queue file.
type ChatQueueManager struct {
	reg   *session.Registry
	store *db.Store
	mu    sync.Mutex
	// queues caches one ChatQueue per agent id (the in-memory copy of its disk
	// file), so concurrent attachers/callbacks share one FIFO.
	queues map[string]*ChatQueue
	// interrupted records heads with a user interrupt in flight (the chat client
	// sent an interrupt control_request). The CLI answers one by ending the turn
	// with a `result` line (subtype error_during_execution) but fires NO Stop
	// hook, so nothing in-sandbox ever flips status.json out of "running" - the
	// head would spin forever and a queue restored on attach would never drain.
	// OnTurnEnd consumes the mark and writes the resting status itself.
	interrupted map[string]time.Time
	// onEvent mirrors queue/input transitions into the normalized durable chat
	// stream. Optional so focused queue tests and legacy callers stay lightweight.
	onEvent func(id, eventType string, payload any)
}

// interruptMarkTTL bounds how long a pending-interrupt mark stays valid. An
// interrupt is answered by the CLI within milliseconds (spike-verified, even
// mid-tool); a mark this stale belongs to an interrupt that raced a turn that
// had already ended, and must not re-label a later, unrelated turn end.
const interruptMarkTTL = time.Minute

// interruptSettleTimeout is how long MarkInterrupted waits for the CLI's
// answering `result` line before concluding there was no turn to interrupt.
// An interrupt sent to an idle CLI returns only a control_response - no
// result, no echo (spike-verified) - which happens exactly when the head is
// stuck showing "running" with nothing actually in flight; the settle timer
// is what makes Ctrl+C unstick it. A real mid-turn interrupt answers within
// milliseconds, so seconds of grace cannot misfire on one. Var so tests can
// shorten it.
var interruptSettleTimeout = 5 * time.Second

// NewChatQueueManager builds the manager. reg is used to write drained messages
// to a session's stdin; store resolves an agent id to its project root.
func NewChatQueueManager(reg *session.Registry, store *db.Store) *ChatQueueManager {
	return &ChatQueueManager{reg: reg, store: store, queues: map[string]*ChatQueue{}, interrupted: map[string]time.Time{}}
}

func (m *ChatQueueManager) SetEventSink(fn func(id, eventType string, payload any)) {
	m.mu.Lock()
	m.onEvent = fn
	m.mu.Unlock()
}

func (m *ChatQueueManager) emit(id, eventType string, payload any) {
	m.mu.Lock()
	fn := m.onEvent
	m.mu.Unlock()
	if fn != nil {
		fn(id, eventType, payload)
	}
}

// queue returns the cached ChatQueue for id, loading it from disk on first use.
func (m *ChatQueueManager) queue(projectRoot, id string) *ChatQueue {
	m.mu.Lock()
	defer m.mu.Unlock()
	if q, ok := m.queues[id]; ok {
		return q
	}
	q := LoadChatQueue(projectRoot, id)
	m.queues[id] = q
	return q
}

// resolveRoot maps an agent id to its project root via the DB (the registry
// callback only carries the id).
func (m *ChatQueueManager) resolveRoot(id string) (string, bool) {
	agent, err := m.store.GetAgent(id)
	if err != nil || agent == nil {
		return "", false
	}
	return agent.ProjectPath, true
}

// MarkInterrupted records that the user interrupted id's in-flight turn, so the
// turn end the CLI answers with (a `result` line, no Stop hook) writes the
// head's post-interrupt status instead of leaving it stuck "running".
//
// If no result consumes the mark within interruptSettleTimeout, the interrupt
// hit an idle CLI - there was no turn to end, and the head is stuck showing
// "running" (e.g. state left behind by an older daemon, or a turn whose end
// was lost). Settle it: flip the status to waiting and kick the queue, so
// Ctrl+C always means "make it stop".
func (m *ChatQueueManager) MarkInterrupted(id string) {
	at := time.Now()
	m.mu.Lock()
	m.interrupted[id] = at
	m.mu.Unlock()
	time.AfterFunc(interruptSettleTimeout, func() { m.settleIdleInterrupt(id, at) })
}

// settleIdleInterrupt handles an interrupt mark that no `result` line ever
// consumed (see MarkInterrupted). It is a no-op unless the exact mark is still
// pending (a result, a newer interrupt, or a new user turn each invalidate it)
// and the head still reads as mid-turn.
func (m *ChatQueueManager) settleIdleInterrupt(id string, at time.Time) {
	m.mu.Lock()
	pending, ok := m.interrupted[id]
	if !ok || !pending.Equal(at) {
		m.mu.Unlock()
		return
	}
	delete(m.interrupted, id)
	m.mu.Unlock()

	root, ok := m.resolveRoot(id)
	if !ok {
		return
	}
	// Only unstick a head that still claims to be working; a status a hook (or
	// the API-error flip) has since written is the truth, not staleness.
	if info := ReadAgentStatus(root, id); info == nil || (info.Status != api.Running && info.Status != api.Starting) {
		return
	}
	if err := WriteAgentStatus(root, id, &api.AgentStatusInfo{
		Status:    api.Waiting,
		Timestamp: time.Now().Format(time.RFC3339Nano),
	}); err != nil {
		log.Printf("warn: settle idle interrupt for %s: %v", id, err)
		return
	}
	m.drainAll(root, id)
}

// takeInterrupted consumes a pending-interrupt mark for id, reporting whether a
// fresh one existed. Expired marks (an interrupt that never produced a turn
// end, e.g. sent after the turn had already finished) are discarded.
func (m *ChatQueueManager) takeInterrupted(id string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	at, ok := m.interrupted[id]
	if !ok {
		return false
	}
	delete(m.interrupted, id)
	return time.Since(at) < interruptMarkTTL
}

// writeToStdin hands one message's content to the CLI as a user turn.
func (m *ChatQueueManager) writeToStdin(id string, content json.RawMessage) bool {
	// A new user turn is starting: a still-pending interrupt mark belongs to a
	// turn that never answered (a race with its own end), not to this one.
	m.mu.Lock()
	delete(m.interrupted, id)
	m.mu.Unlock()
	if err := m.reg.SendChatUser(id, content); err != nil {
		log.Printf("warn: chat queue: write to %s: %v", id, err)
		return false
	}
	return true
}

// Submit records a fresh user message. queued reflects the client's view that a
// turn is running: when true the message is HELD (persisted) to drain later;
// when false it is sent to the CLI now (a sent message is surfaced via the CLI's
// own echo, so it is never stored).
//
// The client's view can lag the truth by a beat (its status arrives via the
// 1s poller + events fan-out), so a message can be marked queued right after
// the turn actually ended - e.g. typed quickly after an interrupt. Held as-is
// it would hang until the next attach (no turn end is coming to drain it), so
// when the head's own status says it is resting, kick the queue now instead.
// The opposite lag (a turn just started but status.json still reads resting)
// is benign: the CLI accepts a mid-turn stdin message and runs it as the next
// turn (spike-verified), which is what queueing would have done anyway.
func (m *ChatQueueManager) Submit(projectRoot, id string, msg QueuedMessage, queued bool) {
	if queued {
		m.queue(projectRoot, id).Enqueue(msg)
		m.emit(id, "queued_message", map[string]any{"id": msg.ID, "status": "queued", "content": msg.Content})
		m.kickIfResting(projectRoot, id)
		return
	}
	if m.writeToStdin(id, msg.Content) {
		m.emit(id, "user_message", map[string]any{"id": msg.ID, "content": msg.Content})
	}
}

// SubmitShellResult delivers a chat `!command`'s output to the agent as a user
// turn AND records it as a shell-command card in the durable stream. Unlike a
// typed message it is never queued: the user ran the command to feed the agent,
// so the result goes to the CLI now (injected at the running turn's next step
// boundary if one is in flight, exactly like typed-ahead steering). The write
// runs under the queue's sendMu so it can't interleave with a concurrent drain.
//
// content is the agent-facing text (command + output); shell is the structured
// ShellCommandResult the client renders as the card - it rides on the emitted
// user_message payload's `shell` field. The CLI's replay echo of the same
// content folds into a user_message_echoed (reconcileClaudeUserEcho), so the
// card is the sole visible copy.
func (m *ChatQueueManager) SubmitShellResult(projectRoot, id, msgID string, content json.RawMessage, shell any) {
	q := m.queue(projectRoot, id)
	q.sendMu.Lock()
	defer q.sendMu.Unlock()
	if m.writeToStdin(id, content) {
		m.emit(id, "user_message", map[string]any{"id": msgID, "content": content, "shell": shell})
	}
}

// Dequeue removes a still-queued message (the Up-arrow recall), reporting
// whether it was found.
func (m *ChatQueueManager) Dequeue(projectRoot, id, msgID string) bool {
	removed := m.queue(projectRoot, id).Dequeue(msgID)
	if removed {
		m.emit(id, "queue_message_removed", map[string]any{"id": msgID})
	}
	return removed
}

// List returns a head's queued messages (for the on-attach replay frame).
func (m *ChatQueueManager) List(projectRoot, id string) []QueuedMessage {
	return m.queue(projectRoot, id).List()
}

// OnTurnEnd is the registry's turn-end (`result` event) hook: the current turn
// finished, so dump the queued messages to the CLI.
//
// The provider result is the daemon's authoritative turn-end signal. Write the
// resting status here rather than relying solely on Claude's in-sandbox Stop
// hook: that hook may be delayed or absent, which otherwise leaves chat mode
// stuck "running" indefinitely. Written BEFORE the drain, so a drained
// message's own UserPromptSubmit hook (status running, newer timestamp)
// supersedes it cleanly. Interrupt tracking is still consumed here so its
// timeout cannot relabel a later turn.
func (m *ChatQueueManager) OnTurnEnd(id string) {
	root, ok := m.resolveRoot(id)
	if !ok {
		return
	}
	m.takeInterrupted(id)
	status := api.Finished
	if entries, err := os.ReadDir(paths.GetSubagentsDirFromProjectRoot(root, id)); err == nil && len(entries) > 0 {
		status = api.Running
	}
	ts := time.Now().Format(time.RFC3339Nano)
	if err := WriteAgentStatus(root, id, &api.AgentStatusInfo{
		Status:    status,
		Timestamp: ts,
	}); err != nil {
		log.Printf("warn: write post-turn status for %s: %v", id, err)
	}
	// Deliberately do NOT write the DB status here. The JSON status poller owns
	// the running-to-finished transition: it compares status.json against the
	// DB's last-known timestamp and, on that transition, arms the graceUnread
	// debounce that raises the "unread changes" flag (see poller.go). Writing the
	// DB directly with this same timestamp would make statusTimeAfter blind to the
	// transition, so the debounce would never arm and the head would never go
	// unread - which is exactly what regressed for every chat-mode head (Claude
	// chat and Codex). Leave the DB to the poller, as terminal-mode finishes do.
	m.drainAll(root, id)
}

// OnPlanApproval auto-approves an ExitPlanMode plan-approval gate: a chat-mode
// head runs with --permission-prompt-tool stdio, so when it leaves plan mode the
// CLI emits a can_use_tool control_request and blocks the turn until it's
// answered. Nothing answers it (the plan renders as an informational card in the
// UI, with no approve button), so the head would hang forever. Approve it here by
// writing the allow control_response straight to the CLI's stdin - the same
// autonomous stance the terminal-mode PermissionRequest hook already takes
// (trigger_hook.go): the user never opted into plan mode, and a Hydra head runs
// fully autonomously in a throwaway sandbox + worktree, so there's nothing for
// the gate to guard. Done daemon-side (not in the browser) so it fires even with
// no client attached - a head resumed after a restart keeps moving on its own.
func (m *ChatQueueManager) OnPlanApproval(id, requestID string, input json.RawMessage) {
	if err := m.reg.Write(id, claudestream.ApproveToolLine(requestID, input)); err != nil {
		log.Printf("warn: chat queue: auto-approve plan for %s: %v", id, err)
	}
}

// OnAttach handles a client (re)connecting: if the head is sitting idle with a
// queue that no future turn-end will drain (e.g. a queue restored from disk
// after a daemon restart), send the front now. A running/starting head, or one
// awaiting a question (needs_input), is left to its normal turn-end drain.
func (m *ChatQueueManager) OnAttach(projectRoot, id string) {
	m.kickIfResting(projectRoot, id)
}

// kickIfResting drains the front of the queue iff the head's own status says
// it is resting - no turn is in flight, so no turn end is coming to drain it.
// A running/starting head, or one awaiting a question (needs_input), is left
// to its normal turn-end drain.
func (m *ChatQueueManager) kickIfResting(projectRoot, id string) {
	info := ReadAgentStatus(projectRoot, id)
	if info == nil {
		return
	}
	switch info.Status {
	case api.Finished, api.Waiting, api.Errored:
		m.drainAll(projectRoot, id)
	}
}

// drainAll pops every queued message and writes them to stdin in queue order -
// the whole queue dumps at once, so a burst of typed-ahead messages arrives as
// one consecutive block instead of scattering across later steps/turns. The
// pops and writes happen under the queue's sendMu so concurrently-dispatched
// drains cannot interleave.
func (m *ChatQueueManager) drainAll(projectRoot, id string) {
	q := m.queue(projectRoot, id)
	q.sendMu.Lock()
	defer q.sendMu.Unlock()
	for {
		msg, ok := q.PopFront()
		if !ok {
			return
		}
		if m.writeToStdin(id, msg.Content) {
			m.emit(id, "user_message", map[string]any{"id": msg.ID, "content": msg.Content})
		}
	}
}

// OnTurnStep is the registry's mid-turn step-boundary hook (a completed
// assistant line: a thinking block, a tool_use, a text block): drain the
// queue NOW rather than waiting for the turn to end. The CLI injects mid-turn
// stdin user messages into the running turn at its next step boundary - the
// same steering the interactive terminal does (spike-verified) - so queued
// messages reach the agent within a step or two of being typed.
func (m *ChatQueueManager) OnTurnStep(id string) {
	root, ok := m.resolveRoot(id)
	if !ok {
		return
	}
	m.drainAll(root, id)
}
