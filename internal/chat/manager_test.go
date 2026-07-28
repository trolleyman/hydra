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

func TestManagerSeedsInitialPromptOnce(t *testing.T) {
	root := t.TempDir()
	m := NewManager(func(id string) (HeadContext, bool) {
		return HeadContext{ProjectRoot: root, Prompt: "build the thing"}, id == "head"
	})
	events, _, _, err := m.Before("head", "", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].Type != "user_message" {
		t.Fatalf("events = %+v", events)
	}
	if _, err := m.Snapshot("head"); err != nil {
		t.Fatal(err)
	}
	events, _, _, _ = m.Before("head", "", 10)
	if len(events) != 1 {
		t.Fatalf("initial prompt duplicated: %+v", events)
	}
}

// The CLI's internal placeholders reach the normalizer only through the
// transcript, i.e. through the one-shot history import - which appends onto an
// event log the live stream has already filled, so anything it finds that the
// stream never carried lands at the TAIL of the conversation. The image-resize
// notice is the one that bites: a mid-turn note about an image read minutes ago,
// rendered as an "Injected context" card hanging off a finished answer. Nothing
// should be recorded for any of them.
func TestManagerDropsClaudeInternalPlaceholders(t *testing.T) {
	root := t.TempDir()
	m := NewManager(func(id string) (HeadContext, bool) { return HeadContext{ProjectRoot: root}, id == "head" })
	m.ObserveProviderLine("head", "claude", []byte(`{"type":"assistant","uuid":"u1","message":{"id":"m1","content":[{"type":"text","text":"done"}]}}`))
	m.ObserveProviderLine("head", "claude_history", []byte(`{"type":"user","uuid":"u2","message":{"role":"user","content":"[Image: original 2088x160, displayed at 2000x153. Multiply coordinates by 1.04 to map to original image.]"},"isMeta":true}`))
	m.ObserveProviderLine("head", "claude_history", []byte(`{"type":"user","uuid":"u3","message":{"role":"user","content":[{"type":"text","text":"Continue from where you left off."}]},"isMeta":true}`))
	m.ObserveProviderLine("head", "claude_history", []byte(`{"type":"assistant","uuid":"u4","message":{"model":"<synthetic>","content":[{"type":"text","text":"No response requested."}]}}`))
	// A genuine injected context (a skill body) still gets through: the filter is
	// for the CLI's own placeholders, not for isMeta in general.
	m.ObserveProviderLine("head", "claude_history", []byte(`{"type":"user","uuid":"u5","message":{"role":"user","content":"Base directory for this skill: /tmp/x"},"isMeta":true}`))
	if err := m.Flush("head"); err != nil {
		t.Fatal(err)
	}
	page, _, _, err := m.Before("head", "", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(page) != 2 || page[0].Type != "assistant_message" || page[1].Type != "context_message" {
		t.Fatalf("events = %+v", page)
	}
}

func TestManagerReconcilesClaudeUserEchoDurably(t *testing.T) {
	root := t.TempDir()
	resolve := func(id string) (HeadContext, bool) { return HeadContext{ProjectRoot: root}, id == "head" }
	m := NewManager(resolve)
	if _, err := m.Append("head", "user_message", map[string]any{"id": "client-1", "content": []map[string]any{{"type": "text", "text": "same text"}}}); err != nil {
		t.Fatal(err)
	}
	m.ObserveProviderLine("head", "claude_history", []byte(`{"type":"user","uuid":"claude-1","message":{"content":[{"type":"text","text":"same text"}]}}`))
	if err := m.Flush("head"); err != nil {
		t.Fatal(err)
	}
	events, _, _, _ := m.Before("head", "", 10)
	if len(events) != 2 || events[0].Type != "user_message" || events[1].Type != "user_message_echoed" {
		t.Fatalf("events = %+v", events)
	}

	// Reopening the store must remember that the first identical message was
	// paired, while still allowing a later identical turn to pair once.
	m = NewManager(resolve)
	if _, err := m.Append("head", "user_message", map[string]any{"id": "client-2", "content": []map[string]any{{"type": "text", "text": "same text"}}}); err != nil {
		t.Fatal(err)
	}
	m.ObserveProviderLine("head", "claude_history", []byte(`{"type":"user","uuid":"claude-2","message":{"content":[{"type":"text","text":"same text"}]}}`))
	if err := m.Flush("head"); err != nil {
		t.Fatal(err)
	}
	events, _, _, _ = m.Before("head", "", 10)
	if len(events) != 4 || events[3].Type != "user_message_echoed" {
		t.Fatalf("reopened events = %+v", events)
	}
}

func TestManagerLinksCodexChildThreadToSpawn(t *testing.T) {
	root := t.TempDir()
	m := NewManager(func(id string) (HeadContext, bool) { return HeadContext{ProjectRoot: root}, id == "head" })
	lines := []string{
		`{"method":"thread/started","params":{"thread":{"id":"root"}}}`,
		`{"method":"item/started","params":{"item":{"id":"spawn-1","type":"collabAgentToolCall","tool":"spawnAgent","senderThreadId":"root","prompt":"inspect repo"}}}`,
		`{"method":"item/completed","params":{"threadId":"child","item":{"id":"report","type":"agentMessage","text":"done"}}}`,
		`{"method":"turn/completed","params":{"threadId":"child","turn":{"id":"child-turn","status":"completed"}}}`,
	}
	for _, line := range lines {
		m.ObserveProviderLine("head", "codex", []byte(line))
	}
	if err := m.Flush("head"); err != nil {
		t.Fatal(err)
	}
	events, _, _, err := m.Before("head", "", 20)
	if err != nil {
		t.Fatal(err)
	}
	var started, report, completed bool
	for _, event := range events {
		var payload struct {
			AgentID      string `json:"agent_id"`
			ID           string `json:"id"`
			ParentItemID string `json:"parent_item_id"`
		}
		_ = json.Unmarshal(event.Payload, &payload)
		switch event.Type {
		case "subagent_started":
			started = payload.ID == "child" && payload.ParentItemID == "spawn-1"
		case "assistant_message":
			report = payload.AgentID == "child" && payload.ParentItemID == "spawn-1"
		case "subagent_completed":
			completed = payload.ID == "child" && payload.ParentItemID == "spawn-1"
		}
	}
	if !started || !report || !completed {
		t.Fatalf("linked lifecycle missing: started=%v report=%v completed=%v events=%+v", started, report, completed, events)
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

func TestCodexInterruptSettlesDeltaOnlyAssistantMessage(t *testing.T) {
	w := worker{codexAssistantDeltas: map[string]string{}}
	delta := eventSpec{eventType: "assistant_delta", payload: map[string]any{"message_id": "message-1", "text": "partial reply"}}
	if got := w.settleCodexPartialOnInterrupt([]eventSpec{delta}); len(got) != 1 {
		t.Fatalf("delta events = %+v", got)
	}
	interrupted := eventSpec{eventType: "turn_interrupted", payload: map[string]any{"id": "turn-1", "status": "interrupted"}}
	got := w.settleCodexPartialOnInterrupt([]eventSpec{interrupted})
	if len(got) != 2 || got[0].eventType != "assistant_message" || got[1].eventType != "turn_interrupted" {
		t.Fatalf("interrupt events = %+v", got)
	}
	payload := got[0].payload.(map[string]any)
	if payload["text"] != "partial reply" || payload["partial"] != true {
		t.Fatalf("partial payload = %+v", payload)
	}
}

func TestPendingCodexAssistantDeltasRebuildsAfterRestart(t *testing.T) {
	events := []Event{
		{Type: "assistant_delta", Payload: json.RawMessage(`{"message_id":"message-1","text":"partial "}`)},
		{Type: "assistant_delta", Payload: json.RawMessage(`{"message_id":"message-1","text":"reply"}`)},
	}
	got := pendingCodexAssistantDeltas(events)
	if got["message-1"] != "partial reply" {
		t.Fatalf("pending = %+v", got)
	}
	events = append(events, Event{Type: "assistant_message", Payload: json.RawMessage(`{"message_id":"message-1","text":"partial reply"}`)})
	if got := pendingCodexAssistantDeltas(events); len(got) != 0 {
		t.Fatalf("settled pending = %+v", got)
	}
}
