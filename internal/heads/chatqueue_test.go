package heads

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/paths"
)

func msg(id, text string) QueuedMessage {
	content, _ := json.Marshal([]map[string]string{{"type": "text", "text": text}})
	return QueuedMessage{ID: id, Content: content}
}

func TestQueuedMessageEventCarriesProvenance(t *testing.T) {
	event := queuedMessage(QueuedMessage{
		ID: "m1", Content: []byte(`[{"type":"text","text":"hello"}]`),
		Origin: api.MessageOriginAgent, SourceAgentID: "source",
	}, "queued")
	if event.Origin != api.MessageOriginAgent || event.SourceAgentId != "source" {
		t.Fatalf("queued provenance = %q from %q", event.Origin, event.SourceAgentId)
	}
}

func newTestQueue(t *testing.T) (*ChatQueue, string) {
	t.Helper()
	// persist() creates the queue dir itself, so a bare temp root is enough.
	root := t.TempDir()
	return LoadChatQueue(root, "agent-x"), root
}

func ids(ms []QueuedMessage) []string {
	out := []string{}
	for _, m := range ms {
		out = append(out, m.ID)
	}
	return out
}

// Messages queued while a turn runs drain one-per-turn in FIFO order.
func TestChatQueueEnqueueAndPop(t *testing.T) {
	q, _ := newTestQueue(t)
	q.Enqueue(msg("b", "second"))
	q.Enqueue(msg("c", "third"))
	if got := ids(q.List()); len(got) != 2 || got[0] != "b" || got[1] != "c" {
		t.Fatalf("queue = %v, want [b c]", got)
	}
	m, ok := q.PopFront()
	if !ok || m.ID != "b" {
		t.Fatalf("PopFront -> (%q,%v), want (b,true)", m.ID, ok)
	}
	m, ok = q.PopFront()
	if !ok || m.ID != "c" {
		t.Fatalf("PopFront -> (%q,%v), want (c,true)", m.ID, ok)
	}
	if _, ok := q.PopFront(); ok {
		t.Fatal("PopFront on empty queue should report ok=false")
	}
}

func TestChatQueueDequeue(t *testing.T) {
	q, _ := newTestQueue(t)
	q.Enqueue(msg("b", "second"))
	q.Enqueue(msg("c", "third"))
	q.Enqueue(msg("d", "fourth"))

	if !q.Dequeue("c") {
		t.Fatal("dequeue of queued message should succeed")
	}
	if q.Dequeue("c") {
		t.Fatal("dequeue of already-removed message should fail")
	}
	if q.Dequeue("nope") {
		t.Fatal("dequeue of unknown id should fail")
	}
	if got := ids(q.List()); len(got) != 2 || got[0] != "b" || got[1] != "d" {
		t.Fatalf("remaining queue = %v, want [b d]", got)
	}
}

// The message list survives a reload (daemon restart); draining it removes the
// file.
func TestChatQueuePersistence(t *testing.T) {
	q, root := newTestQueue(t)
	q.Enqueue(msg("b", "second"))
	q.Enqueue(msg("c", "third"))

	path := paths.GetChatQueueJsonFromProjectRoot(root, "agent-x")
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("queue file not written: %v", err)
	}

	// Reload as a fresh daemon would.
	q2 := LoadChatQueue(root, "agent-x")
	if got := ids(q2.List()); len(got) != 2 || got[0] != "b" || got[1] != "c" {
		t.Fatalf("reloaded queue = %v, want [b c]", got)
	}
	q2.PopFront()
	q2.PopFront()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("drained queue file should be removed, stat err = %v", err)
	}
}

func TestChatQueueLoadMissingAndCorrupt(t *testing.T) {
	root := t.TempDir()
	_ = os.MkdirAll(paths.GetChatQueueDirFromProjectRoot(root), 0o755)
	if got := len(LoadChatQueue(root, "nope").List()); got != 0 {
		t.Fatalf("missing queue should be empty, got %d", got)
	}
	path := paths.GetChatQueueJsonFromProjectRoot(root, "bad")
	_ = os.WriteFile(path, []byte("{not json"), 0o644)
	if got := len(LoadChatQueue(root, "bad").List()); got != 0 {
		t.Fatalf("corrupt queue should be empty, got %d", got)
	}
}
