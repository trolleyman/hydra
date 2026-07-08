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
