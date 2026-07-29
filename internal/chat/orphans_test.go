package chat

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// ev builds a normalized log event carrying a uuid, the shape the assistant /
// reasoning events actually have.
func ev(typ, uuid string) Event {
	payload, _ := json.Marshal(map[string]any{"uuid": uuid, "text": "hi"})
	return Event{Type: typ, Payload: payload}
}

// writeTranscript lays down a Claude transcript containing one line per uuid.
func writeTranscript(t *testing.T, uuids ...string) string {
	t.Helper()
	dir := t.TempDir()
	var b strings.Builder
	for _, u := range uuids {
		line, _ := json.Marshal(map[string]any{"type": "assistant", "uuid": u})
		b.Write(line)
		b.WriteString("\n")
	}
	if err := os.WriteFile(filepath.Join(dir, "session.jsonl"), []byte(b.String()), 0o600); err != nil {
		t.Fatal(err)
	}
	return dir
}

// The bug this exists for: a process died after streaming a reply, so our log
// has it but the CLI's transcript never did; the resumed process re-ran the turn
// and said the same thing again.
func TestOrphanedUUIDsFindsUncommittedBlocks(t *testing.T) {
	events := []Event{
		ev("user_message", "u1"),
		ev("reasoning_completed", "dead-think"),
		ev("assistant_message", "dead-text"),
	}
	dir := writeTranscript(t, "u1") // the CLI committed the user turn and nothing else
	got := OrphanedUUIDs(events, dir)
	want := []string{"dead-think", "dead-text"}
	if !slices.Equal(got, want) {
		t.Fatalf("OrphanedUUIDs = %v, want %v", got, want)
	}
}

// The overwhelmingly common case: the turn completed normally, so everything in
// the tail is in the transcript and nothing is retracted.
func TestOrphanedUUIDsLeavesCommittedBlocksAlone(t *testing.T) {
	events := []Event{
		ev("user_message", "u1"),
		ev("reasoning_completed", "t1"),
		ev("assistant_message", "m1"),
	}
	if got := OrphanedUUIDs(events, writeTranscript(t, "u1", "t1", "m1")); got != nil {
		t.Fatalf("OrphanedUUIDs = %v, want none", got)
	}
}

// The scan stops at the turn boundary: an older uncommitted block is not this
// turn's problem, and re-retracting it on every resume would be wrong.
func TestOrphanedUUIDsStopsAtTurnBoundary(t *testing.T) {
	events := []Event{
		ev("assistant_message", "ancient"),
		ev("user_message", "u1"),
		ev("assistant_message", "dead-text"),
	}
	got := OrphanedUUIDs(events, writeTranscript(t, "u1"))
	if !slices.Equal(got, []string{"dead-text"}) {
		t.Fatalf("OrphanedUUIDs = %v, want just the current turn", got)
	}
}

// A previous retraction is also a boundary, so a second resume doesn't re-scan
// (and re-retract) blocks the first one already handled.
func TestOrphanedUUIDsStopsAtPriorRetraction(t *testing.T) {
	events := []Event{
		ev("user_message", "u1"),
		ev("assistant_message", "already-gone"),
		{Type: "messages_retracted"},
	}
	if got := OrphanedUUIDs(events, writeTranscript(t, "u1")); got != nil {
		t.Fatalf("OrphanedUUIDs = %v, want none", got)
	}
}

// No arbiter, no retraction. Deleting a real message is far worse than leaving a
// duplicate, so an unreadable/absent/empty transcript must retract nothing.
func TestOrphanedUUIDsWithoutTranscriptRetractsNothing(t *testing.T) {
	events := []Event{ev("user_message", "u1"), ev("assistant_message", "m1")}
	for name, dir := range map[string]string{
		"no dir":       "",
		"missing dir":  filepath.Join(t.TempDir(), "nope"),
		"empty dir":    t.TempDir(),
		"empty of ids": writeTranscript(t),
	} {
		t.Run(name, func(t *testing.T) {
			if got := OrphanedUUIDs(events, dir); got != nil {
				t.Fatalf("OrphanedUUIDs = %v, want none", got)
			}
		})
	}
}

// Tool calls are never retracted: a tool that ran changed the worktree, and its
// card is an honest record of that even when the turn was thrown away.
func TestOrphanedUUIDsIgnoresToolEvents(t *testing.T) {
	events := []Event{
		ev("user_message", "u1"),
		ev("tool_started", "tool-uuid"),
		ev("tool_completed", "tool-uuid2"),
	}
	if got := OrphanedUUIDs(events, writeTranscript(t, "u1")); got != nil {
		t.Fatalf("OrphanedUUIDs = %v, want none", got)
	}
}

// A transcript line can carry a whole file's contents, well past bufio's default
// 64KB. Truncating one would decode to no uuid and read as "never committed" -
// the false positive that deletes a real message.
func TestOrphanedUUIDsHandlesHugeTranscriptLines(t *testing.T) {
	dir := t.TempDir()
	huge, _ := json.Marshal(map[string]any{
		"type": "user", "uuid": "big", "content": strings.Repeat("x", 2<<20),
	})
	committed, _ := json.Marshal(map[string]any{"type": "assistant", "uuid": "m1"})
	body := append(append(huge, '\n'), append(committed, '\n')...)
	if err := os.WriteFile(filepath.Join(dir, "s.jsonl"), body, 0o600); err != nil {
		t.Fatal(err)
	}
	events := []Event{ev("user_message", "big"), ev("assistant_message", "m1")}
	if got := OrphanedUUIDs(events, dir); got != nil {
		t.Fatalf("OrphanedUUIDs = %v, want none (the long line must still be read)", got)
	}
}
