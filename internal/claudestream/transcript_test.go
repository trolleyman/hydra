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

func TestHistoryBefore(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "session-1.jsonl")
	line := func(uuid, text string) string {
		return `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"` + text + `"}]},"uuid":"` + uuid + `"}`
	}
	content := strings.Join([]string{
		line("u1", "oldest"),
		line("u2", "second"),
		`{"type":"user","uuid":"side","isSidechain":true,"message":{"content":[]}}`, // skipped
		line("u3", "third"),
		line("u4", "newest"),
	}, "\n") + "\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	// Everything older than u4 (large budget): u1, u2, u3 - oldest-first, no
	// sidechain - and done (reached the start).
	lines, done, err := HistoryBefore(path, "u4", 1<<20)
	if err != nil {
		t.Fatalf("HistoryBefore: %v", err)
	}
	if !done {
		t.Error("expected done=true when the batch reaches the start")
	}
	var got []string
	for _, l := range lines {
		ev, _ := ParseEvent(l)
		got = append(got, ev.UUID)
	}
	if strings.Join(got, ",") != "u1,u2,u3" {
		t.Fatalf("older-than-u4 = %v, want [u1 u2 u3]", got)
	}

	// Anchored at the oldest line: nothing older, done.
	lines, done, err = HistoryBefore(path, "u1", 1<<20)
	if err != nil || len(lines) != 0 || !done {
		t.Fatalf("older-than-u1 = (%d lines, done=%v, err=%v), want (0, true, nil)", len(lines), done, err)
	}

	// A tiny budget returns a partial batch (just u3) and NOT done.
	lines, done, err = HistoryBefore(path, "u4", 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) != 1 || done {
		t.Fatalf("tiny budget = (%d lines, done=%v), want (1, false)", len(lines), done)
	}
	if ev, _ := ParseEvent(lines[0]); ev.UUID != "u3" {
		t.Fatalf("tiny budget returned %q, want the nearest-older u3", ev.UUID)
	}

	// Unknown anchor -> empty, done.
	if lines, done, _ := HistoryBefore(path, "nope", 1<<20); len(lines) != 0 || !done {
		t.Fatalf("unknown anchor = (%d, %v), want (0, true)", len(lines), done)
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

func TestLatestSessionID(t *testing.T) {
	dir := t.TempDir()
	mustWrite := func(name, content string, age time.Duration) {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		ts := time.Now().Add(-age)
		if err := os.Chtimes(p, ts, ts); err != nil {
			t.Fatal(err)
		}
	}
	mustWrite("main-session.jsonl", `{"type":"user","uuid":"u1"}`+"\n", 2*time.Hour)
	// Newest by mtime, but a sub-agent sidechain - must be skipped so a
	// freshly-written Task-tool transcript can't hijack a resume.
	mustWrite("sidechain.jsonl", `{"type":"user","uuid":"u2","isSidechain":true}`+"\n", time.Hour)
	mustWrite("notes.txt", "not a transcript", 0)

	if got := LatestSessionID(dir); got != "main-session" {
		t.Errorf("LatestSessionID = %q, want %q", got, "main-session")
	}
	if got := LatestSessionID(filepath.Join(dir, "absent")); got != "" {
		t.Errorf("LatestSessionID(absent) = %q, want empty", got)
	}
}
