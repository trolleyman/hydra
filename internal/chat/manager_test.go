package chat

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/git"
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
	changed := ModelChanged{}
	changed.Model = "opus"
	if _, err := m.Append("head", changed); err != nil {
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
	if _, err := m.Append("head", testUserMessage("client-1", "same text")); err != nil {
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
	if _, err := m.Append("head", testUserMessage("client-2", "same text")); err != nil {
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

// A message typed while a turn is running is consumed into that turn, and the
// CLI records it ONLY as a queued_command attachment - which Hydra relays so the
// message does not vanish on reattach. But Hydra also persisted it itself at the
// queue boundary, so relaying the attachment unconditionally showed every
// mid-turn message twice: the user's own bubble, then a notice repeating it.
// Taken from a real log, where 19 notices duplicated a user message this way.
func TestManagerDropsQueuedCommandEchoOfUserMessage(t *testing.T) {
	root := t.TempDir()
	m := NewManager(func(id string) (HeadContext, bool) { return HeadContext{ProjectRoot: root}, id == "head" })
	if _, err := m.Append("head", testUserMessage("client-1", "mid-turn steer")); err != nil {
		t.Fatal(err)
	}
	// The attachment record the CLI writes when it consumes that queued message.
	m.ObserveProviderLine("head", "claude", []byte(`{"type":"queue_operation","uuid":"q1","attachment":{"prompt":[{"type":"text","text":"mid-turn steer"}]}}`))
	if err := m.Flush("head"); err != nil {
		t.Fatal(err)
	}
	events, _, _, _ := m.Before("head", "", 10)
	if len(events) != 1 || events[0].Type != "user_message" {
		t.Fatalf("want just the user message, got %+v", events)
	}

	// A notice that is NOT an echo still has to come through - this must not
	// become a blanket "drop notices" rule.
	m.ObserveProviderLine("head", "claude", []byte(`{"type":"queue_operation","uuid":"q2","attachment":{"prompt":[{"type":"text","text":"something else"}]}}`))
	if err := m.Flush("head"); err != nil {
		t.Fatal(err)
	}
	events, _, _, _ = m.Before("head", "", 10)
	if len(events) != 2 || events[1].Type != "notice" {
		t.Fatalf("want the unrelated notice kept, got %+v", events)
	}
}

// Hydra's resume nudge is written straight to the agent's stdin and never
// recorded as a user message, so its only trace is the transcript. A --continue
// resume forks the conversation into a FRESH transcript, re-stamping every line
// with a new uuid, and the import re-reads that file whole - so source-id dedup
// cannot see that it is the same message, and the nudge gained another bubble on
// every resume. Taken from a real log ("Continue" at seq 3778 and again at
// 10709, hours apart, different uuids).
func TestManagerDropsReimportedTranscriptUserMessage(t *testing.T) {
	root := t.TempDir()
	resolve := func(id string) (HeadContext, bool) { return HeadContext{ProjectRoot: root}, id == "head" }
	m := NewManager(resolve)

	// First resume: the nudge exists only in the transcript, so it is kept.
	m.ObserveProviderLine("head", "claude_history", []byte(`{"type":"user","uuid":"first","message":{"content":[{"type":"text","text":"Continue"}]}}`))
	if err := m.Flush("head"); err != nil {
		t.Fatal(err)
	}
	// Second resume: same message, new transcript, new uuid.
	m.ObserveProviderLine("head", "claude_history", []byte(`{"type":"user","uuid":"second","message":{"content":[{"type":"text","text":"Continue"}]}}`))
	if err := m.Flush("head"); err != nil {
		t.Fatal(err)
	}
	events, _, _, _ := m.Before("head", "", 10)
	if len(events) != 1 {
		t.Fatalf("want one copy of the nudge, got %+v", events)
	}

	// A message the user genuinely sends is recorded by Hydra first, so it still
	// pairs into an echo rather than being swallowed as a re-import.
	if _, err := m.Append("head", testUserMessage("client-1", "Continue")); err != nil {
		t.Fatal(err)
	}
	m.ObserveProviderLine("head", "claude_history", []byte(`{"type":"user","uuid":"third","message":{"content":[{"type":"text","text":"Continue"}]}}`))
	if err := m.Flush("head"); err != nil {
		t.Fatal(err)
	}
	events, _, _, _ = m.Before("head", "", 10)
	if len(events) != 3 || events[2].Type != "user_message_echoed" {
		t.Fatalf("want the real send paired into an echo, got %+v", events)
	}

	// (The guard is restricted to claude_history rather than any claude source
	// because only a replay can be a re-import. That is belt-and-braces: the live
	// normalizer already drops a plain user line - Hydra records what it sends -
	// so a live user_message never reaches this path to be tested here.)
}

// Codex thread/read returns old assistant messages under synthetic item ids,
// rather than the msg_ ids used when those messages were observed live.
func TestManagerDropsReplayedCodexAssistantBlocks(t *testing.T) {
	root := t.TempDir()
	m := NewManager(func(id string) (HeadContext, bool) { return HeadContext{ProjectRoot: root}, id == "head" })

	m.ObserveProviderLine("head", "codex", []byte(`{"method":"item/completed","params":{"item":{"id":"msg_live","type":"agentMessage","text":"The fix is complete."}}}`))
	m.ObserveProviderLine("head", "codex_history", []byte(`{"method":"item/completed","params":{"item":{"id":"item-2","type":"agentMessage","text":"The fix is complete."}}}`))
	if err := m.Flush("head"); err != nil {
		t.Fatal(err)
	}

	events, _, _, err := m.Before("head", "", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].Type != "assistant_message" {
		t.Fatalf("want one copy of the assistant block, got %+v", events)
	}

	// Count matches are one-to-one. A second identical recovered message is a
	// distinct historical turn, not another copy of the one live block.
	m.ObserveProviderLine("head", "codex_history", []byte(`{"method":"item/completed","params":{"item":{"id":"item-3","type":"agentMessage","text":"The fix is complete."}}}`))
	if err := m.Flush("head"); err != nil {
		t.Fatal(err)
	}
	events, _, _, _ = m.Before("head", "", 10)
	if len(events) != 2 {
		t.Fatalf("want the second historical occurrence kept, got %+v", events)
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
			ParentItemId string `json:"parent_item_id"`
		}
		_ = json.Unmarshal(event.Payload, &payload)
		switch event.Type {
		case "subagent_started":
			started = payload.ID == "child" && payload.ParentItemId == "spawn-1"
		case "assistant_message":
			report = payload.AgentID == "child" && payload.ParentItemId == "spawn-1"
		case "subagent_completed":
			completed = payload.ID == "child" && payload.ParentItemId == "spawn-1"
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
	run("init", "-q", "-b", "main")
	if err := os.WriteFile(filepath.Join(repo, "file"), []byte("one"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", "file")
	run("commit", "-qm", "base")
	m := NewManager(func(id string) (HeadContext, bool) {
		return HeadContext{ProjectRoot: repo, BaseBranch: "main"}, id == "head"
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
		IsMerge      bool   `json:"is_merge"`
	}
	if err := json.Unmarshal(events[2].Payload, &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Subject != "second" || payload.CausalItemID != "bash1" {
		t.Fatalf("commit payload = %+v", payload)
	}
	if payload.IsMerge {
		t.Fatalf("ordinary project-directory commit was presented as a merge: %+v", payload)
	}
}

func TestManagerSequencesAmendedCommitAfterToolCompletion(t *testing.T) {
	repo := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", repo}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=Test", "GIT_AUTHOR_EMAIL=test@example.com", "GIT_COMMITTER_NAME=Test", "GIT_COMMITTER_EMAIL=test@example.com")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	write := func(text string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(repo, "file"), []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	run("init", "-q", "-b", "main")
	write("base")
	run("add", "file")
	run("commit", "-qm", "base")
	run("checkout", "-q", "-b", "head")

	m := NewManager(func(id string) (HeadContext, bool) {
		return HeadContext{ProjectRoot: repo, BaseBranch: "main"}, id == "head"
	})
	if _, err := m.Snapshot("head"); err != nil {
		t.Fatal(err)
	}

	write("original")
	run("commit", "-qam", "original commit")
	m.ObserveProviderLine("head", "claude", []byte(`{"type":"user","uuid":"result-1","message":{"content":[{"type":"tool_result","tool_use_id":"bash1","content":"ok"}]}}`))
	if err := m.Flush("head"); err != nil {
		t.Fatal(err)
	}

	oldHead, err := git.ResolveRef(repo, "HEAD")
	if err != nil {
		t.Fatal(err)
	}
	write("amended")
	run("commit", "-qam", "amended commit", "--amend")
	newHead, err := git.ResolveRef(repo, "HEAD")
	if err != nil {
		t.Fatal(err)
	}
	if oldHead == newHead {
		t.Fatal("amend did not replace HEAD")
	}
	m.ObserveProviderLine("head", "claude", []byte(`{"type":"user","uuid":"result-2","message":{"content":[{"type":"tool_result","tool_use_id":"bash2","content":"ok"}]}}`))
	if err := m.Flush("head"); err != nil {
		t.Fatal(err)
	}

	events, _, _, err := m.Before("head", "", 20)
	if err != nil {
		t.Fatal(err)
	}
	var commits []struct {
		Sha          string `json:"sha"`
		Subject      string `json:"subject"`
		CausalItemID string `json:"causal_item_id"`
	}
	for _, event := range events {
		if event.Type == "head_changed" {
			t.Fatalf("amend emitted head_changed: %+v", events)
		}
		if event.Type == "commit_created" {
			var payload struct {
				Sha          string `json:"sha"`
				Subject      string `json:"subject"`
				CausalItemID string `json:"causal_item_id"`
			}
			if err := json.Unmarshal(event.Payload, &payload); err != nil {
				t.Fatal(err)
			}
			commits = append(commits, payload)
		}
	}
	if len(commits) != 2 || commits[1].Sha != newHead || commits[1].Subject != "amended commit" || commits[1].CausalItemID != "bash2" {
		t.Fatalf("commit events = %+v", commits)
	}

	// The selector inventory follows current history: it includes the replacement
	// commit and does not offer the obsolete pre-amend SHA.
	current, err := git.ListFirstParentCommits(repo, "main", "HEAD")
	if err != nil {
		t.Fatal(err)
	}
	if len(current) != 1 || current[0].SHA != newHead {
		t.Fatalf("current commit list = %+v", current)
	}
}

// A branch merged into the branch owned by a project-directory chat needs an
// explicit source hint: unlike a managed worktree, every ordinary commit also
// advances the project checkout's branch and must remain an ordinary row.
func TestReconcileCommitsCollapsesExplicitProjectDirectoryMerge(t *testing.T) {
	repo := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", repo}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=Test", "GIT_AUTHOR_EMAIL=test@example.com", "GIT_COMMITTER_NAME=Test", "GIT_COMMITTER_EMAIL=test@example.com")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	run("init", "-q", "-b", "main")
	if err := os.WriteFile(filepath.Join(repo, "base"), []byte("base"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", "base")
	run("commit", "-qm", "base")
	run("checkout", "-q", "-b", "hydra/incoming")
	if err := os.WriteFile(filepath.Join(repo, "incoming"), []byte("incoming"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", "incoming")
	run("commit", "-qm", "incoming work")
	run("checkout", "-q", "main")

	m := NewManager(func(id string) (HeadContext, bool) {
		return HeadContext{ProjectRoot: repo, BaseBranch: "main"}, id == "head"
	})
	if _, err := m.Snapshot("head"); err != nil {
		t.Fatal(err)
	}
	run("merge", "--ff-only", "hydra/incoming")
	m.ReconcileCommits("head", "hydra/incoming")

	events, _, _, err := m.Before("head", "", 10)
	if err != nil {
		t.Fatal(err)
	}
	commits := []Event{}
	for _, event := range events {
		if event.Type == "commit_created" {
			commits = append(commits, event)
		}
	}
	if len(commits) != 1 {
		t.Fatalf("want one collapsed commit event, got %d: %+v", len(commits), events)
	}
	var payload struct {
		IsMerge     bool                   `json:"is_merge"`
		MergedRef   string                 `json:"merged_ref"`
		MergedCount int                    `json:"merged_count"`
		Merged      []api.ChatMergedCommit `json:"merged_commits"`
	}
	if err := json.Unmarshal(commits[0].Payload, &payload); err != nil {
		t.Fatal(err)
	}
	if !payload.IsMerge || payload.MergedRef != "hydra/incoming" || payload.MergedCount != 1 {
		t.Fatalf("commit payload = %+v", payload)
	}
	if len(payload.Merged) != 1 || payload.Merged[0].Subject != "incoming work" {
		t.Fatalf("expanded commits = %+v", payload.Merged)
	}
}

// An update-from-base is nobody's tool call, so nothing in the provider stream
// makes the reconciler look at git: without an explicit ReconcileCommits the
// merge stayed out of the chat until the head next did something. And when the
// head had nothing of its own to merge, git FAST-FORWARDS it onto the base's
// tip - whose subject names whatever THAT commit merged (another head) - so the
// move has to be recorded as one "merged <base>" chip rather than by replaying
// the base's own first-parent history into this head's chat.
func TestReconcileCommitsCollapsesFastForwardedBase(t *testing.T) {
	repo := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", repo}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=Test", "GIT_AUTHOR_EMAIL=test@example.com", "GIT_COMMITTER_NAME=Test", "GIT_COMMITTER_EMAIL=test@example.com")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	write := func(text string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(repo, "file"), []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	run("init", "-q", "-b", "main")
	write("one")
	run("add", "file")
	run("commit", "-qm", "base")
	// main gains a merge of a sibling head - the commit the head will land on.
	run("checkout", "-q", "-b", "sibling")
	write("two")
	run("commit", "-qam", "sibling work")
	run("checkout", "-q", "main")
	run("merge", "-q", "--no-ff", "-m", "Merge branch 'hydra/sibling'", "sibling")
	run("checkout", "-q", "-b", "head")
	run("reset", "-q", "--hard", "HEAD~1") // the head branched off before main's merge

	storeRoot := t.TempDir()
	m := NewManager(func(id string) (HeadContext, bool) {
		return HeadContext{ProjectRoot: storeRoot, Worktree: &repo, BaseBranch: "main"}, id == "head"
	})
	if _, err := m.Snapshot("head"); err != nil { // opens the store and observes the baseline HEAD
		t.Fatal(err)
	}
	run("merge", "--ff-only", "main")
	m.ReconcileCommits("head", "main")

	events, _, _, err := m.Before("head", "", 10)
	if err != nil {
		t.Fatal(err)
	}
	commits := []Event{}
	for _, e := range events {
		if e.Type == "commit_created" {
			commits = append(commits, e)
		}
	}
	if len(commits) != 1 {
		t.Fatalf("want one collapsed commit event, got %d: %+v", len(commits), events)
	}
	var payload struct {
		Subject     string `json:"subject"`
		IsMerge     bool   `json:"is_merge"`
		MergedRef   string `json:"merged_ref"`
		MergedCount int    `json:"merged_count"`
	}
	if err := json.Unmarshal(commits[0].Payload, &payload); err != nil {
		t.Fatal(err)
	}
	// The subject stays the real commit's; merged_ref is what the chip is labelled
	// from, so it reads "Merged main", not "Merged hydra/sibling".
	if !payload.IsMerge || payload.MergedRef != "main" || payload.MergedCount != 2 {
		t.Fatalf("commit payload = %+v", payload)
	}
}

// A merge Hydra performs when the head HAS work of its own makes a real merge
// commit, which the first-parent walk already renders correctly - the collapse
// must not swallow it, and the head's own commits must still be reconciled.
func TestReconcileCommitsKeepsRealMergeCommit(t *testing.T) {
	repo := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", repo}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=Test", "GIT_AUTHOR_EMAIL=test@example.com", "GIT_COMMITTER_NAME=Test", "GIT_COMMITTER_EMAIL=test@example.com")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	run("init", "-q", "-b", "main")
	if err := os.WriteFile(filepath.Join(repo, "base"), []byte("one"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", "base")
	run("commit", "-qm", "base")
	run("checkout", "-q", "-b", "head")

	storeRoot := t.TempDir()
	m := NewManager(func(id string) (HeadContext, bool) {
		return HeadContext{ProjectRoot: storeRoot, Worktree: &repo, BaseBranch: "main"}, id == "head"
	})
	if _, err := m.Snapshot("head"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, "head-work"), []byte("mine"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", "head-work")
	run("commit", "-qm", "head work")
	run("checkout", "-q", "main")
	if err := os.WriteFile(filepath.Join(repo, "main-work"), []byte("theirs"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", "main-work")
	run("commit", "-qm", "main work")
	run("checkout", "-q", "head")
	run("merge", "-q", "--no-ff", "-m", "Merge branch 'main'", "main")
	m.ReconcileCommits("head", "main")

	subjects := []string{}
	events, _, _, err := m.Before("head", "", 10)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range events {
		if e.Type != "commit_created" {
			continue
		}
		var payload struct {
			Subject   string `json:"subject"`
			MergedRef string `json:"merged_ref"`
		}
		if err := json.Unmarshal(e.Payload, &payload); err != nil {
			t.Fatal(err)
		}
		subjects = append(subjects, payload.Subject)
		if payload.Subject == "Merge branch 'main'" && payload.MergedRef != "main" {
			t.Fatalf("real merge ref = %q, want main", payload.MergedRef)
		}
	}
	if len(subjects) != 2 || subjects[0] != "head work" || subjects[1] != "Merge branch 'main'" {
		t.Fatalf("commit subjects = %v", subjects)
	}
}

func TestCodexInterruptSettlesDeltaOnlyAssistantMessage(t *testing.T) {
	w := worker{codexAssistantDeltas: map[string]string{}}
	partial := &AssistantDelta{}
	partial.MessageId, partial.Text = "message-1", "partial reply"
	delta := eventSpec{payload: partial}
	if got := w.settleCodexPartialOnInterrupt([]eventSpec{delta}); len(got) != 1 {
		t.Fatalf("delta events = %+v", got)
	}
	stopped := &TurnInterrupted{}
	stopped.Id, stopped.Status = "turn-1", "interrupted"
	interrupted := eventSpec{payload: stopped}
	got := w.settleCodexPartialOnInterrupt([]eventSpec{interrupted})
	if len(got) != 2 || got[0].eventType() != "assistant_message" || got[1].eventType() != "turn_interrupted" {
		t.Fatalf("interrupt events = %+v", got)
	}
	settled, ok := got[0].payload.(*AssistantMessage)
	if !ok || settled.Text != "partial reply" || !settled.Partial {
		t.Fatalf("partial payload = %+v", got[0].payload)
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

// testUserMessage is the shape the queue emits for a submitted turn.
func testUserMessage(id, text string) UserMessage {
	content, _ := json.Marshal([]map[string]any{{"type": "text", "text": text}})
	msg := UserMessage{}
	msg.Id, msg.Content = id, content
	return msg
}
