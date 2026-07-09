package claudestream

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRingFilterDropsStreamEvents(t *testing.T) {
	f := &RingFilter{}
	var kept string
	feed := func(chunk string) { k, _ := f.Filter([]byte(chunk)); kept += string(k) }

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
		`{"type":"queue-operation","operation":"enqueue","content":"<task-notification>\n<task-id>bg1</task-id>\n<status>completed</status>\n</task-notification>"}`,
	}, "\n") + "\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	lines, uuids, err := TailTranscript(path, 0)
	if err != nil {
		t.Fatalf("TailTranscript: %v", err)
	}
	if len(lines) != 4 {
		t.Fatalf("relayed %d lines, want 4 (user + 2 assistant + task-notification, no summary/sidechain/garbage): %s", len(lines), lines)
	}
	if !bytes.Contains(lines[3], []byte("<task-notification>")) {
		t.Errorf("backfill dropped the task-notification line: %q", lines)
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
		if _, ok := ParseEvent(l); !ok {
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

func TestTailSubagentTranscripts(t *testing.T) {
	dir := t.TempDir()
	sessionID := "session-1"
	// Main transcript alongside the per-session subagents/ dir.
	if err := os.WriteFile(filepath.Join(dir, sessionID+".jsonl"), []byte(`{"type":"user","uuid":"u1"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	subDir := filepath.Join(dir, sessionID, "subagents")
	if err := os.MkdirAll(subDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// One sub-agent: its transcript entries are all sidechain (must be KEPT here,
	// unlike the main-transcript backfill which drops them) plus a non-relayable
	// attachment line, and a meta sidecar linking it to its Task tool_use.
	subLines := strings.Join([]string{
		`{"type":"user","isSidechain":true,"agentId":"a1f2","uuid":"su1","message":{"role":"user","content":[{"type":"text","text":"go look"}]}}`,
		`{"type":"attachment","isSidechain":true,"agentId":"a1f2","uuid":"sat1"}`,
		`{"type":"assistant","isSidechain":true,"agentId":"a1f2","uuid":"sa1","message":{"id":"m","content":[{"type":"text","text":"done"}]}}`,
	}, "\n") + "\n"
	if err := os.WriteFile(filepath.Join(subDir, "agent-a1f2.jsonl"), []byte(subLines), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(subDir, "agent-a1f2.meta.json"), []byte(`{"agentType":"Explore","description":"go look","toolUseId":"toolu_x"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	subs, uuids := TailSubagentTranscripts(dir, sessionID, 0)
	if len(subs) != 1 {
		t.Fatalf("got %d sub-agents, want 1", len(subs))
	}
	s := subs[0]
	if s.AgentID != "a1f2" {
		t.Errorf("AgentID = %q, want a1f2", s.AgentID)
	}
	if s.Meta == nil || s.Meta.ToolUseID != "toolu_x" || s.Meta.AgentType != "Explore" {
		t.Errorf("meta = %+v, want toolUseId toolu_x / Explore", s.Meta)
	}
	// user + assistant kept (sidechain preserved), attachment dropped.
	if len(s.Lines) != 2 {
		t.Fatalf("relayed %d lines, want 2 (user + assistant, no attachment): %s", len(s.Lines), s.Lines)
	}
	// Every entry's uuid (incl. the dropped attachment) is reported for ring dedup.
	for _, u := range []string{"su1", "sat1", "sa1"} {
		if _, ok := uuids[u]; !ok {
			t.Errorf("uuid set missing %q", u)
		}
	}

	// Absent subagents/ dir: nothing, no panic.
	if subs, _ := TailSubagentTranscripts(dir, "no-such-session", 0); subs != nil {
		t.Errorf("TailSubagentTranscripts(absent) = %v, want nil", subs)
	}

	// ReadSubagentMeta reads the sidecar directly; missing id -> not ok.
	if m, ok := ReadSubagentMeta(dir, sessionID, "a1f2"); !ok || m.ToolUseID != "toolu_x" {
		t.Errorf("ReadSubagentMeta = %+v, %v", m, ok)
	}
	if _, ok := ReadSubagentMeta(dir, sessionID, "missing"); ok {
		t.Errorf("ReadSubagentMeta(missing) ok = true, want false")
	}
}

func TestSubagentTailer(t *testing.T) {
	dir := t.TempDir()
	sessionID := "session-1"
	if err := os.WriteFile(filepath.Join(dir, sessionID+".jsonl"), []byte(`{"type":"user","uuid":"u1"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	subDir := filepath.Join(dir, sessionID, "subagents")
	if err := os.MkdirAll(subDir, 0o755); err != nil {
		t.Fatal(err)
	}
	subPath := filepath.Join(subDir, "agent-a1f2.jsonl")
	write := func(s string) {
		f, err := os.OpenFile(subPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
		if err != nil {
			t.Fatal(err)
		}
		defer f.Close()
		if _, err := f.WriteString(s); err != nil {
			t.Fatal(err)
		}
	}

	tail := NewSubagentTailer(dir, 0)
	// Nothing yet: the subagents dir has no transcript files.
	if g := tail.Poll(); len(g) != 0 {
		t.Fatalf("Poll(empty) = %v, want none", g)
	}

	// First sight reads from the start; the trailing partial line stays put.
	write(`{"type":"user","isSidechain":true,"agentId":"a1f2","uuid":"su1"}` + "\n" +
		`{"type":"attachment","isSidechain":true,"agentId":"a1f2","uuid":"sat1"}` + "\n" +
		`{"type":"assistant","isSidechain":true,"agentId":"a1f2","uuid":"sa1"`)
	g := tail.Poll()
	if len(g) != 1 || g[0].AgentID != "a1f2" || g[0].SessionID != sessionID {
		t.Fatalf("Poll = %+v, want one growth for a1f2/%s", g, sessionID)
	}
	// user kept, attachment dropped, partial assistant not consumed yet.
	if len(g[0].Lines) != 1 {
		t.Fatalf("first Poll relayed %d lines, want 1 (user only): %s", len(g[0].Lines), g[0].Lines)
	}

	// Completing the partial line yields it (and only it) on the next Poll.
	write("}\n")
	g = tail.Poll()
	if len(g) != 1 || len(g[0].Lines) != 1 {
		t.Fatalf("second Poll = %+v, want the completed assistant line", g)
	}
	if ev, ok := ParseEvent(g[0].Lines[0]); !ok || ev.UUID != "sa1" {
		t.Errorf("completed line = %s, want uuid sa1", g[0].Lines[0])
	}

	// No growth -> no entries.
	if g := tail.Poll(); len(g) != 0 {
		t.Errorf("Poll(no growth) = %v, want none", g)
	}

	// A new sub-agent file appearing mid-tail is picked up from its start.
	if err := os.WriteFile(filepath.Join(subDir, "agent-b2.jsonl"),
		[]byte(`{"type":"assistant","isSidechain":true,"agentId":"b2","uuid":"sb1"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	g = tail.Poll()
	if len(g) != 1 || g[0].AgentID != "b2" || len(g[0].Lines) != 1 {
		t.Fatalf("Poll(new file) = %+v, want one line for b2", g)
	}

	// A large file first seen is capped: the seek drops the fragment before
	// the first newline, keeping only whole trailing lines.
	capped := NewSubagentTailer(dir, 40)
	for _, growth := range capped.Poll() {
		for _, l := range growth.Lines {
			if _, ok := ParseEvent(l); !ok {
				t.Errorf("capped Poll returned a non-parseable line: %q", l)
			}
		}
	}
}

func TestNotificationTailer(t *testing.T) {
	dir := t.TempDir()
	sessionID := "session-1"
	path := filepath.Join(dir, sessionID+".jsonl")
	// Seed a couple of ordinary lines that already exist at attach time - the
	// tailer starts at end-of-file, so these must NOT be returned.
	if err := os.WriteFile(path, []byte(`{"type":"user","uuid":"u1"}`+"\n"+`{"type":"assistant","uuid":"a1"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	write := func(s string) {
		f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
		if err != nil {
			t.Fatal(err)
		}
		defer f.Close()
		if _, err := f.WriteString(s); err != nil {
			t.Fatal(err)
		}
	}

	tail := NewNotificationTailer(dir)
	// Nothing appended since construction.
	if lines := tail.Poll(); len(lines) != 0 {
		t.Fatalf("Poll(no growth) = %v, want none", lines)
	}

	// Append a normal assistant line (no notification) then the queue-operation
	// and attachment copies of a completion notification, plus a trailing partial.
	write(`{"type":"assistant","uuid":"a2"}` + "\n" +
		`{"type":"queue-operation","operation":"enqueue","content":"<task-notification>\n<task-id>bg1</task-id>\n<status>completed</status>\n</task-notification>"}` + "\n" +
		`{"type":"attachment","uuid":"nat1","attachment":{"commandMode":"task-notification","prompt":"<task-notification>\n<task-id>bg1</task-id>\n<status>completed</status>\n</task-notification>"}}` + "\n" +
		`{"type":"attachment","uuid":"partial"`)
	lines := tail.Poll()
	// Only the two notification-bearing lines are returned; the assistant line is
	// skipped (it arrives via stdout+backfill) and the partial waits for a newline.
	if len(lines) != 2 {
		t.Fatalf("Poll relayed %d lines, want 2 (the two notification copies): %q", len(lines), lines)
	}
	if !bytes.Contains(lines[0], []byte(`"queue-operation"`)) || !bytes.Contains(lines[1], []byte(`"attachment"`)) {
		t.Fatalf("Poll returned unexpected lines: %q", lines)
	}

	// Completing the partial (a non-notification line) yields nothing.
	write("}\n")
	if lines := tail.Poll(); len(lines) != 0 {
		t.Fatalf("Poll(partial completed, no notif) = %q, want none", lines)
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
