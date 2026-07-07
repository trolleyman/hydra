package claudestream

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRingFilterDropsStreamEvents(t *testing.T) {
	f := &RingFilter{}
	var kept string
	feed := func(chunk string) { kept += string(f.Filter([]byte(chunk))) }

	feed(`{"type":"assistant","uuid":"a1"}` + "\n")
	feed(`{"type":"stream_event","event":{"type":"content_block_delta"}}` + "\n")
	// A line split across chunks, completing later.
	feed(`{"type":"res`)
	if p := string(f.Pending()); p != `{"type":"res` {
		t.Errorf("Pending = %q, want the buffered partial", p)
	}
	feed(`ult","subtype":"success"}` + "\n")
	feed(`{"type":"stream_event","event":{"type":"message_stop"}}` + "\n" + `{"type":"user","uuid":"u1"}` + "\n")

	want := `{"type":"assistant","uuid":"a1"}` + "\n" + `{"type":"result","subtype":"success"}` + "\n" + `{"type":"user","uuid":"u1"}` + "\n"
	if kept != want {
		t.Errorf("kept = %q, want %q", kept, want)
	}
	if len(f.Pending()) != 0 {
		t.Errorf("Pending after complete lines = %q, want empty", f.Pending())
	}
}

func TestTailTranscript(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "session-1.jsonl")
	content := strings.Join([]string{
		`{"type":"summary","summary":"a compact marker","uuid":"s1"}`,
		`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]},"uuid":"u1"}`,
		`{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"hello"}]},"uuid":"a1"}`,
		`{"type":"user","message":{"role":"user","content":[]},"uuid":"side1","isSidechain":true}`,
		`not json at all`,
		`{"type":"assistant","message":{"id":"m2","content":[]},"uuid":"a2"}`,
	}, "\n") + "\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	lines, uuids, err := TailTranscript(path, 0)
	if err != nil {
		t.Fatalf("TailTranscript: %v", err)
	}
	if len(lines) != 3 {
		t.Fatalf("relayed %d lines, want 3 (user + 2 assistant, no summary/sidechain/garbage): %s", len(lines), lines)
	}
	for _, u := range []string{"s1", "u1", "a1", "side1", "a2"} {
		if _, ok := uuids[u]; !ok {
			t.Errorf("uuid set missing %q (must include skipped entries for ring dedup)", u)
		}
	}

	// A byte cap seeks into the file and drops the fragment before the first
	// newline, so only whole trailing lines survive.
	tailCap := int64(len(content) - (strings.Index(content, "u1") - 10))
	lines, _, err = TailTranscript(path, tailCap)
	if err != nil {
		t.Fatalf("TailTranscript capped: %v", err)
	}
	for _, l := range lines {
		if ev, ok := ParseEvent(l); !ok || ev.UUID == "" {
			t.Errorf("capped tail returned a non-parseable line: %q", l)
		}
	}
}

func TestLatestTranscript(t *testing.T) {
	dir := t.TempDir()
	old := filepath.Join(dir, "old.jsonl")
	newer := filepath.Join(dir, "newer.jsonl")
	if err := os.WriteFile(old, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(newer, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	past := time.Now().Add(-time.Hour)
	if err := os.Chtimes(old, past, past); err != nil {
		t.Fatal(err)
	}
	if got := LatestTranscript(dir); got != newer {
		t.Errorf("LatestTranscript = %q, want %q", got, newer)
	}
	if got := LatestTranscript(filepath.Join(dir, "absent")); got != "" {
		t.Errorf("LatestTranscript(absent) = %q, want empty", got)
	}
}
