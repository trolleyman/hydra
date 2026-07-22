package chat

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestManagerPreservesProviderOrderAndWatches(t *testing.T) {
	root := t.TempDir()
	m := NewManager(func(id string) (HeadContext, bool) { return HeadContext{ProjectRoot: root}, id == "head" })
	m.ObserveProviderLine("head", "claude", []byte(`{"type":"assistant","uuid":"u1","message":{"id":"m1","content":[{"type":"tool_use","id":"tool","name":"Bash","input":{"command":"true"}}]}}`))
	m.ObserveProviderLine("head", "claude", []byte(`{"type":"user","uuid":"u2","message":{"content":[{"type":"tool_result","tool_use_id":"tool","content":"ok"}]}}`))
	if err := m.Flush("head"); err != nil {
		t.Fatal(err)
	}
	page, _, _, err := m.Before("head", "", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(page) != 2 || page[0].Type != "tool_started" || page[1].Type != "tool_completed" {
		t.Fatalf("events = %+v", page)
	}

	snapshot, live, cancel, err := m.Watch("head")
	if err != nil {
		t.Fatal(err)
	}
	defer cancel()
	if snapshot.Through != 2 {
		t.Fatalf("snapshot through = %d", snapshot.Through)
	}
	if _, err := m.Append("head", "model_changed", map[string]string{"model": "opus"}); err != nil {
		t.Fatal(err)
	}
	ev := <-live
	if ev.Seq != 3 || ev.Type != "model_changed" {
		t.Fatalf("live event = %+v", ev)
	}
}

func TestManagerSequencesCommitAfterToolCompletion(t *testing.T) {
	repo := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", repo}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=Test", "GIT_AUTHOR_EMAIL=test@example.com", "GIT_COMMITTER_NAME=Test", "GIT_COMMITTER_EMAIL=test@example.com")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	run("init", "-q")
	if err := os.WriteFile(filepath.Join(repo, "file"), []byte("one"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", "file")
	run("commit", "-qm", "base")
	m := NewManager(func(id string) (HeadContext, bool) {
		return HeadContext{ProjectRoot: repo, Worktree: repo}, id == "head"
	})
	if _, err := m.Snapshot("head"); err != nil { // opens store and observes baseline HEAD
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, "file"), []byte("two"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", "file")
	run("commit", "-qm", "second")
	m.ObserveProviderLine("head", "claude", []byte(`{"type":"user","uuid":"result","message":{"content":[{"type":"tool_result","tool_use_id":"bash1","content":"ok"}]}}`))
	if err := m.Flush("head"); err != nil {
		t.Fatal(err)
	}
	events, _, _, err := m.Before("head", "", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 3 || events[1].Type != "tool_completed" || events[2].Type != "commit_created" {
		t.Fatalf("events = %+v", events)
	}
	var payload struct {
		Subject      string `json:"subject"`
		CausalItemID string `json:"causal_item_id"`
	}
	if err := json.Unmarshal(events[2].Payload, &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Subject != "second" || payload.CausalItemID != "bash1" {
		t.Fatalf("commit payload = %+v", payload)
	}
}
