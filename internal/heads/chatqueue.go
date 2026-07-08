package heads

import (
	"encoding/json"
	"log"
	"os"
	"sync"

	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/claudestream"
	"github.com/trolleyman/hydra/internal/db"
	"github.com/trolleyman/hydra/internal/paths"
	"github.com/trolleyman/hydra/internal/session"
)

// Chat-mode message queue (server-authoritative, disk-persisted).
//
// A chat head processes one user turn at a time. A message the user sends while
// a turn is running is HELD here - in the daemon, not written to the CLI's stdin
// yet - and drained one-per-turn as each turn completes (a `result` event on the
// session's live stdout). Holding queued messages daemon-side (rather than
// client-side) means they survive closing the browser, navigating away, and a WS
// reconnect; persisting them to disk means they also survive a daemon restart. On
// (re)attach the daemon replays the queue so the client renders the pending
// bubbles, and the client can recall a still-queued message to edit it (dequeue).
//
// The store is just a persisted FIFO: it holds ONLY queued (not-yet-sent)
// messages, and the daemon pops the front each time it observes a turn end.
// Whether a fresh message is queued vs sent immediately is decided by the client
// (which knows, and shows, whether a turn is running) and passed in the frame -
// so the daemon needs no fragile turn-state seeding, only the turn-end drain.

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
}

// NewChatQueueManager builds the manager. reg is used to write drained messages
// to a session's stdin; store resolves an agent id to its project root.
func NewChatQueueManager(reg *session.Registry, store *db.Store) *ChatQueueManager {
	return &ChatQueueManager{reg: reg, store: store, queues: map[string]*ChatQueue{}}
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

// writeToStdin hands one message's content to the CLI as a user turn.
func (m *ChatQueueManager) writeToStdin(id string, content json.RawMessage) {
	line, err := claudestream.UserMessageLine(content)
	if err != nil {
		log.Printf("warn: chat queue: bad content for %s: %v", id, err)
		return
	}
	if err := m.reg.Write(id, line); err != nil {
		log.Printf("warn: chat queue: write to %s: %v", id, err)
	}
}

// Submit records a fresh user message. queued reflects the client's view that a
// turn is running: when true the message is HELD (persisted) to drain later;
// when false it is sent to the CLI now (a sent message is surfaced via the CLI's
// own echo, so it is never stored).
func (m *ChatQueueManager) Submit(projectRoot, id string, msg QueuedMessage, queued bool) {
	if queued {
		m.queue(projectRoot, id).Enqueue(msg)
		return
	}
	m.writeToStdin(id, msg.Content)
}

// Dequeue removes a still-queued message (the Up-arrow recall), reporting
// whether it was found.
func (m *ChatQueueManager) Dequeue(projectRoot, id, msgID string) bool {
	return m.queue(projectRoot, id).Dequeue(msgID)
}

// List returns a head's queued messages (for the on-attach replay frame).
func (m *ChatQueueManager) List(projectRoot, id string) []QueuedMessage {
	return m.queue(projectRoot, id).List()
}

// OnTurnEnd is the registry's turn-end (`result` event) hook: the current turn
// finished, so drain the next queued message to the CLI (one per whole turn).
func (m *ChatQueueManager) OnTurnEnd(id string) {
	root, ok := m.resolveRoot(id)
	if !ok {
		return
	}
	m.drainFront(root, id)
}

// OnAttach handles a client (re)connecting: if the head is sitting idle with a
// queue that no future turn-end will drain (e.g. a queue restored from disk
// after a daemon restart), send the front now. A running/starting head, or one
// awaiting a question (needs_input), is left to its normal turn-end drain.
func (m *ChatQueueManager) OnAttach(projectRoot, id string) {
	info := ReadAgentStatus(projectRoot, id)
	if info == nil {
		return
	}
	switch info.Status {
	case api.Finished, api.Waiting, api.Errored:
		m.drainFront(projectRoot, id)
	}
}

// drainFront pops the front message and writes it to stdin, if any.
func (m *ChatQueueManager) drainFront(projectRoot, id string) {
	msg, ok := m.queue(projectRoot, id).PopFront()
	if !ok {
		return
	}
	m.writeToStdin(id, msg.Content)
}
