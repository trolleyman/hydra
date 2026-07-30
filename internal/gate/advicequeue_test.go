package gate

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestAdviceQueueRoundTrip(t *testing.T) {
	dir := t.TempDir()
	now := time.Unix(1_700_000_000, 0)

	if got := TakeAdvice(dir, "", now); got != nil {
		t.Fatalf("empty queue should yield nothing, got %v", got)
	}
	if err := QueueAdvice(dir, "", "first", now); err != nil {
		t.Fatalf("queue first: %v", err)
	}
	if err := QueueAdvice(dir, "", "second", now); err != nil {
		t.Fatalf("queue second: %v", err)
	}

	// Oldest first: two failures in a row read as the order they happened in.
	got := TakeAdvice(dir, "", now)
	if strings.Join(got, "|") != "first|second" {
		t.Fatalf("expected both notes oldest-first, got %v", got)
	}
	// Taking clears - a note delivered twice is worse than one delivered once.
	if got := TakeAdvice(dir, "", now); got != nil {
		t.Fatalf("queue should be empty after a take, got %v", got)
	}
}

// An explanation of a failure, attached to an unrelated command an hour later, is
// worse than no explanation at all.
func TestAdviceQueueDropsStaleEntries(t *testing.T) {
	dir := t.TempDir()
	queued := time.Unix(1_700_000_000, 0)
	if err := QueueAdvice(dir, "", "stale", queued); err != nil {
		t.Fatalf("queue: %v", err)
	}
	if err := QueueAdvice(dir, "", "fresh", queued.Add(adviceTTL)); err != nil {
		t.Fatalf("queue: %v", err)
	}

	got := TakeAdvice(dir, "", queued.Add(adviceTTL+time.Second))
	if strings.Join(got, "|") != "fresh" {
		t.Fatalf("expected only the fresh note, got %v", got)
	}
}

// The approval dir is shared with a head's sub-agents. Flushing one agent's
// failure into another's next call would explain a command it never ran.
func TestAdviceQueueIsPerAgent(t *testing.T) {
	dir := t.TempDir()
	now := time.Unix(1_700_000_000, 0)

	if err := QueueAdvice(dir, "", "main note", now); err != nil {
		t.Fatalf("queue main: %v", err)
	}
	if err := QueueAdvice(dir, "abc123", "sub note", now); err != nil {
		t.Fatalf("queue sub: %v", err)
	}

	if got := TakeAdvice(dir, "abc123", now); strings.Join(got, "|") != "sub note" {
		t.Fatalf("sub-agent should get only its own note, got %v", got)
	}
	if got := TakeAdvice(dir, "", now); strings.Join(got, "|") != "main note" {
		t.Fatalf("main agent's note should survive the sub-agent's take, got %v", got)
	}
}

// A run of failures with nothing in between to flush them must not grow a file
// without bound, and the oldest entries are the ones worth losing.
func TestAdviceQueueCapsEntries(t *testing.T) {
	dir := t.TempDir()
	now := time.Unix(1_700_000_000, 0)
	for i := range adviceQueueMax + 5 {
		if err := QueueAdvice(dir, "", string(rune('a'+i)), now); err != nil {
			t.Fatalf("queue %d: %v", i, err)
		}
	}
	got := TakeAdvice(dir, "", now)
	if len(got) != adviceQueueMax {
		t.Fatalf("expected the queue capped at %d, got %d", adviceQueueMax, len(got))
	}
	// Newest kept: the last one queued must be the last one delivered.
	if got[len(got)-1] != string(rune('a'+adviceQueueMax+4)) {
		t.Fatalf("cap should drop the OLDEST entries, got %v", got)
	}
}

// Nothing here is load-bearing for security, so every failure mode is a silent
// no-op rather than a wedged agent.
func TestAdviceQueueFailsQuiet(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	if err := QueueAdvice("", "", "note", now); err != nil {
		t.Errorf("no approval dir should be a no-op, got %v", err)
	}
	if err := QueueAdvice(t.TempDir(), "", "", now); err != nil {
		t.Errorf("empty note should be a no-op, got %v", err)
	}
	if got := TakeAdvice("", "", now); got != nil {
		t.Errorf("no approval dir should yield nothing, got %v", got)
	}

	// A torn or truncated line loses that entry, not the whole flush.
	dir := t.TempDir()
	if err := QueueAdvice(dir, "", "good", now); err != nil {
		t.Fatalf("queue: %v", err)
	}
	f, err := os.OpenFile(filepath.Join(dir, "pending-advice.jsonl"), os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		t.Fatalf("open queue: %v", err)
	}
	if _, err := f.WriteString("{\"at\":123,\"text\":\"tor\n"); err != nil {
		t.Fatalf("write torn line: %v", err)
	}
	f.Close()
	if got := TakeAdvice(dir, "", now); strings.Join(got, "|") != "good" {
		t.Fatalf("a torn line should not lose the readable ones, got %v", got)
	}
}
