package chat

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/trolleyman/hydra/internal/paths"
)

// appendTranscriptLines appends JSONL records to the head's Claude transcript,
// the way the CLI does as it works.
func appendTranscriptLines(t *testing.T, worktree string, lines ...string) {
	t.Helper()
	dir := paths.ClaudeProjectDir(worktree)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	f, err := os.OpenFile(filepath.Join(dir, "session.jsonl"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	for _, line := range lines {
		if _, err := f.WriteString(line + "\n"); err != nil {
			t.Fatal(err)
		}
	}
}

func shellCwdEvents(t *testing.T, m *Manager) map[string]string {
	t.Helper()
	if err := m.Flush("head"); err != nil {
		t.Fatal(err)
	}
	page, _, _, err := m.Before("head", "", 100)
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]string{}
	for _, ev := range page {
		if ev.Type != "shell_cwd" {
			continue
		}
		var payload struct {
			ToolUseID string `json:"tool_use_id"`
			Cwd       string `json:"cwd"`
		}
		if err := json.Unmarshal(ev.Payload, &payload); err != nil {
			t.Fatal(err)
		}
		out[payload.ToolUseID] = payload.Cwd
	}
	return out
}

// The directory a command ran in comes off the CLI's own transcript - the
// stdout the chat is built from carries none. The result line lands there a
// moment after the tool_completed the chat sees, so the read happens at both
// ends of a Bash call: whatever the result missed, the next call's start
// catches.
func TestManagerReadsShellCwdFromTranscript(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	root := t.TempDir()
	worktree := filepath.Join(root, "wt")
	m := NewManager(func(id string) (HeadContext, bool) {
		return HeadContext{ProjectRoot: root, Worktree: &worktree, AgentType: "claude"}, id == "head"
	})

	m.ObserveProviderLine("head", "claude", []byte(`{"type":"assistant","uuid":"u1","message":{"id":"m1","content":[{"type":"tool_use","id":"tool1","name":"Bash","input":{"command":"cd web && ls"}}]}}`))
	// The result reaches the chat before the CLI has flushed its transcript line.
	m.ObserveProviderLine("head", "claude", []byte(`{"type":"user","uuid":"u2","message":{"content":[{"type":"tool_result","tool_use_id":"tool1","content":"ok"}]}}`))
	if got := shellCwdEvents(t, m); len(got) != 0 {
		t.Fatalf("cwd known before the transcript recorded it: %+v", got)
	}

	appendTranscriptLines(t, worktree,
		`{"type":"assistant","uuid":"u1","cwd":"`+worktree+`","message":{"content":[]}}`,
		`{"type":"user","uuid":"u2","cwd":"`+worktree+`/web","message":{"content":[{"type":"tool_result","tool_use_id":"tool1"}]}}`,
	)
	// The next command starts: by now the previous result is certainly written.
	m.ObserveProviderLine("head", "claude", []byte(`{"type":"assistant","uuid":"u3","message":{"id":"m2","content":[{"type":"tool_use","id":"tool2","name":"Bash","input":{"command":"bun test"}}]}}`))
	if got := shellCwdEvents(t, m)["tool1"]; got != worktree+"/web" {
		t.Fatalf("tool1 cwd = %q, want %q", got, worktree+"/web")
	}

	// A second read of the same lines must not append the event twice, and a
	// result for a tool that is not Bash carries no shell to record.
	appendTranscriptLines(t, worktree,
		`{"type":"user","uuid":"u4","cwd":"`+worktree+`/web","message":{"content":[{"type":"tool_result","tool_use_id":"tool2"}]}}`,
		`{"type":"user","uuid":"u5","cwd":"`+worktree+`/docs","message":{"content":[{"type":"tool_result","tool_use_id":"read1"}]}}`,
	)
	m.ObserveProviderLine("head", "claude", []byte(`{"type":"user","uuid":"u6","message":{"content":[{"type":"tool_result","tool_use_id":"tool2","content":"12 pass"}]}}`))
	got := shellCwdEvents(t, m)
	if len(got) != 2 || got["tool1"] != worktree+"/web" || got["tool2"] != worktree+"/web" {
		t.Fatalf("shell_cwd events = %+v", got)
	}
}

func TestToolResultCwdReadsOnlyAttributableEntries(t *testing.T) {
	cases := []struct {
		name string
		line string
		id   string
		cwd  string
	}{
		{"result entry", `{"type":"user","cwd":"/wt/web","message":{"content":[{"type":"tool_result","tool_use_id":"t1"}]}}`, "t1", "/wt/web"},
		// The assistant entry's cwd is stamped at flush time and can land either
		// side of the call it carries, so it is never read.
		{"tool_use entry", `{"type":"assistant","cwd":"/wt","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash"}]}}`, "", ""},
		{"plain user turn", `{"type":"user","cwd":"/wt","message":{"content":[{"type":"text","text":"hi"}]}}`, "", ""},
		{"no cwd recorded", `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1"}]}}`, "", ""},
		// Nothing says which of the two the directory belongs to.
		{"two results in one entry", `{"type":"user","cwd":"/wt","message":{"content":[{"type":"tool_result","tool_use_id":"t1"},{"type":"tool_result","tool_use_id":"t2"}]}}`, "", ""},
		{"not json", `nonsense`, "", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			id, cwd := toolResultCwd([]byte(tc.line))
			if id != tc.id || cwd != tc.cwd {
				t.Fatalf("toolResultCwd = (%q, %q), want (%q, %q)", id, cwd, tc.id, tc.cwd)
			}
		})
	}
}
