package chat

import (
	"braces.dev/errtrace"
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/claudestream"
	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/paths"
)

type HeadContext struct {
	ProjectRoot string
	Worktree    string
	Prompt      string
	AgentType   string
	Plan        string
	// The branch the head is based on, used only to recognise a fast-forward
	// that absorbed the base (see reconcileCommits). Empty is fine - the
	// collapse then only happens for a merge Hydra itself performed, which
	// names its ref explicitly.
	BaseBranch string
}

// ContextResolver maps the globally-unique head id carried by session
// callbacks to its project and worktree.
type ContextResolver func(id string) (HeadContext, bool)

// Manager owns lazily-opened per-head stores and serial provider ingestion.
// Each worker preserves the exact line order read from its CLI stdout.
type Manager struct {
	mu      sync.Mutex
	resolve ContextResolver
	workers map[string]*worker
}

type observedLine struct {
	provider string
	line     []byte
	done     chan struct{}
	// A commit reconcile asked for out of band (see ReconcileCommits) rather
	// than a provider line. It rides the same queue so it is serialised against
	// the worker's own reconciles instead of racing them.
	reconcile bool
	mergedRef string
}

type worker struct {
	store       *Store
	in          chan observedLine
	ctx         HeadContext
	imported    bool
	codexThread string
	codexSpawns []codexSpawn
	codexSubs   map[string]codexSpawn
	// Codex may end an interrupted response without an item/completed agent
	// message. Keep its durable deltas until the turn boundary so an interrupt
	// can settle the partial reply into one replayable assistant_message.
	codexAssistantDeltas map[string]string
	// Bash calls whose recorded working directory has not been read off the
	// transcript yet - see shellcwd.go.
	pendingBash map[string]struct{}
}

type codexSpawn struct {
	ToolID   string
	Prompt   string
	ParentId string
}

func NewManager(resolve ContextResolver) *Manager {
	return &Manager{resolve: resolve, workers: map[string]*worker{}}
}

func (m *Manager) store(id string) (*Store, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if w := m.workers[id]; w != nil {
		return w.store, nil
	}
	ctx, ok := m.resolve(id)
	if !ok {
		return nil, errtrace.Wrap(ErrUnknownHead)
	}
	s, err := Open(ctx.ProjectRoot, id)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	w := &worker{store: s, in: make(chan observedLine, 1024), ctx: ctx, codexSubs: map[string]codexSpawn{}, codexAssistantDeltas: pendingCodexAssistantDeltas(s.events)}
	m.workers[id] = w
	if s.Snapshot().Through == 0 && ctx.Prompt != "" {
		prompt, _ := json.Marshal([]map[string]any{{"type": "text", "text": ctx.Prompt}})
		initial := UserMessage{}
		initial.Id, initial.Content = "initial", prompt
		_, _, _ = s.AppendSource("hydra:initial-prompt", initial)
	}
	if len(s.Snapshot().Plan) == 0 && ctx.Plan != "" && json.Valid([]byte(ctx.Plan)) {
		seed := PlanUpdated{}
		seed.Provider, seed.Plan = ctx.AgentType, json.RawMessage(ctx.Plan)
		_, _, _ = s.AppendSource("hydra:initial-plan", seed)
	}
	if s.Snapshot().Head == "" && ctx.Worktree != "" {
		if head, err := git.ResolveRef(ctx.Worktree, "HEAD"); err == nil {
			observed := HeadObserved{}
			observed.Head = head
			_, _ = s.Append(observed)
		}
	}
	go w.run(id)
	return s, nil
}

// Forget drops what a head's chat store holds in memory, after its files have
// been deleted (wired to heads.SetOnStateRemoved). The store keeps the whole
// event log resident to page from, and nothing else would ever tell it the log
// it is holding no longer exists - so a killed head went on costing tens of
// megabytes for the life of the daemon.
//
// The worker itself stays. Its goroutine is a few KB against the log's tens of
// megabytes, and taking it out would mean either racing a straggler line onto a
// closed channel or letting a later one open a SECOND worker for the same id,
// with two stores appending to one file. A store reset to empty is exactly a
// fresh one, which is also what an id taken over by a forced respawn wants.
func (m *Manager) Forget(id string) {
	m.mu.Lock()
	w := m.workers[id]
	m.mu.Unlock()
	if w != nil {
		w.store.Discard()
	}
}

func (m *Manager) worker(id string) (*worker, error) {
	if _, err := m.store(id); err != nil {
		return nil, errtrace.Wrap(err)
	}
	m.mu.Lock()
	w := m.workers[id]
	m.mu.Unlock()
	return w, nil
}

// ObserveProviderLine queues one complete provider JSON line. Backpressure is
// intentional: dropping a line would make the durable timeline/projection
// incorrect, while a 1024-line buffer keeps disk IO off the session read loop.
func (m *Manager) ObserveProviderLine(id, provider string, line []byte) {
	w, err := m.worker(id)
	if err != nil {
		log.Printf("warn: chat events: resolve %s: %v", id, err)
		return
	}
	w.in <- observedLine{provider: provider, line: append([]byte(nil), line...)}
}

// ReconcileCommits folds commits that landed on a head's branch OUT OF BAND
// into its timeline, and returns once they are durable. The worker otherwise
// only looks at git when the agent finishes a tool call or a turn, so a merge
// Hydra performed itself - update-from-base, pull-from-MR - stayed invisible in
// the chat until the agent happened to do something next; on a finished head,
// indefinitely.
//
// mergedRef names the ref that was merged in, when the caller knows it; "" is a
// plain "look at git again" for the attach path.
func (m *Manager) ReconcileCommits(id, mergedRef string) {
	w, err := m.worker(id)
	if err != nil {
		return
	}
	done := make(chan struct{})
	w.in <- observedLine{reconcile: true, mergedRef: mergedRef, done: done}
	<-done
}

func (m *Manager) ObserveClaudeSidechain(id, agentID string, meta *claudestream.SubagentMeta, line []byte) {
	w, err := m.worker(id)
	if err != nil {
		return
	}
	_, _, _ = w.store.AppendSource("claude:subagent:"+agentID, claudeSubagentStarted(agentID, meta))
	w.in <- observedLine{provider: "claude_history", line: addClaudeSidechain(line, agentID, meta)}
}

func (w *worker) run(id string) {
	for item := range w.in {
		if item.reconcile {
			w.reconcileCommits(id, "", item.mergedRef)
			if item.done != nil {
				close(item.done)
			}
			continue
		}
		if item.done != nil {
			close(item.done)
			continue
		}
		// The CLI's internal placeholders (the resume nudge and its synthetic
		// reply, the notice it logs whenever it downscales an image) must not
		// reach the durable timeline. They exist only in the transcript, so the
		// one-shot history import is what picks them up - appending them at the
		// TAIL of an event log the live stream already filled, where a note about
		// an image read mid-turn renders as an "Injected context" card stuck to
		// the end of a finished answer. Every line - live or imported - passes
		// through here, and this log is the only thing a chat socket relays, so
		// this is the single point the filter has to hold.
		if (item.provider == "claude" || item.provider == "claude_history") && claudestream.IsHiddenChatMessage(item.line) {
			continue
		}
		var specs []eventSpec
		switch item.provider {
		case "claude":
			specs = normalizeClaude(item.line)
		case "claude_history":
			specs = normalizeClaudeHistory(item.line)
		case "codex":
			specs = normalizeCodex(item.line)
			if spawn, ok := codexSpawnFromLine(item.line); ok {
				w.codexSpawns = append(w.codexSpawns, spawn)
			}
			threadID, startedThread := codexLineThreads(item.line)
			if w.codexThread == "" && startedThread != "" {
				w.codexThread = startedThread
			}
			if threadID != "" && w.codexThread != "" && threadID != w.codexThread {
				spawn, linked := w.codexSubs[threadID]
				if !linked && len(w.codexSpawns) > 0 {
					spawn = w.codexSpawns[0]
					w.codexSpawns = w.codexSpawns[1:]
					w.codexSubs[threadID] = spawn
					linked = true
					started := &SubagentStarted{ChatSubagentPayload: codexSubagent(threadID, spawn, "running")}
					started.ParentItemId = spawn.ToolID
					specs = append([]eventSpec{{sourceID: "codex:subagent:" + threadID, payload: started}}, specs...)
				}
				for i := range specs {
					if sc, ok := specs[i].payload.(sidechainSetter); ok {
						sc.SetSidechain(threadID, spawn.ToolID)
					}
					kind := specs[i].eventType()
					if (kind == "turn_completed" || kind == "turn_failed") && linked {
						done := &SubagentCompleted{ChatSubagentPayload: codexSubagent(threadID, spawn, "completed")}
						done.ParentItemId = spawn.ToolID
						specs = append(specs, eventSpec{sourceID: "codex:subagent:" + threadID + ":completed", payload: done})
					}
				}
			}
		default:
			continue
		}
		if item.provider == "codex" {
			specs = w.settleCodexPartialOnInterrupt(specs)
		}
		for _, spec := range specs {
			kind := spec.eventType()
			if (item.provider == "claude" || item.provider == "claude_history") && kind == "user_message" && w.reconcileClaudeUserEcho(spec, item.provider) {
				continue
			}
			if (item.provider == "claude" || item.provider == "claude_history") && kind == "notice" && w.isEchoedQueuedCommand(spec) {
				continue
			}
			if _, _, err := w.store.AppendSource(spec.sourceID, spec.payload); err != nil {
				log.Printf("warn: chat events: append %s event for %s: %v", item.provider, id, err)
			}
			if kind == "tool_completed" || kind == "turn_completed" || kind == "turn_failed" {
				w.reconcileCommits(id, causalItemID(spec.payload), "")
			}
			// Read the shell's directory off the transcript for the call that
			// just finished, and for whatever the one starting now has left
			// outstanding (see shellcwd.go).
			if kind == "tool_started" {
				w.noteBashCall(spec)
				w.syncShellCwds()
			}
			if kind == "tool_completed" {
				w.syncShellCwds()
			}
		}
	}
}

// isEchoedQueuedCommand reports whether this notice is just a second copy of a
// message the user already sent.
//
// A message typed while a turn is running is consumed INTO that turn, and the
// CLI records it only as a queued_command attachment - which is why that
// attachment is relayed at all (see claudestream.queuedCommandMarker): without
// it, a message queued mid-turn vanished on the next reattach. But Hydra has
// ALSO persisted that message itself, at the queue boundary, as a real
// user_message. So relaying the attachment unconditionally renders every
// mid-turn message twice: once as the user's own bubble and once as a notice
// echoing it back at them. reconcileClaudeUserEcho does not catch this - it
// pairs user_message against user_message, and the attachment arrives as a
// notice.
//
// Matching on exact text is sound here in a way it would not be for a user
// message: a notice that repeats an existing user message verbatim is never
// something to show, whether or not it is the same send.
func (w *worker) isEchoedQueuedCommand(spec eventSpec) bool {
	note, ok := spec.payload.(*Notice)
	if !ok {
		return false
	}
	text := strings.TrimSpace(note.Text)
	if text == "" {
		return false
	}
	for _, event := range w.store.EventsOfType("user_message") {
		var payload struct {
			Content json.RawMessage `json:"content"`
		}
		if json.Unmarshal(event.Payload, &payload) != nil {
			continue
		}
		if strings.TrimSpace(textFromClaudeContent(payload.Content)) == text {
			return true
		}
	}
	return false
}

// reconcileClaudeUserEcho folds Claude's --replay-user-messages echo into the
// user_message Hydra already persisted when it wrote the message to stdin.
// The marker is intentionally durable: without it, two identical messages sent
// in separate turns cannot be paired correctly after a daemon restart.
func (w *worker) reconcileClaudeUserEcho(spec eventSpec, provider string) bool {
	msg, ok := spec.payload.(*UserMessage)
	if !ok || msg.Sidechain {
		return false
	}
	key := contentKey(msg.Content)
	if key == "" {
		return false
	}
	pending := make([]uint64, 0, 1)
	// Copies already in the log that came from the transcript rather than from
	// Hydra - see the re-import case below.
	fromTranscript := 0
	// Only the two kinds below can pair, and the timeline is mostly tool output -
	// scanning it whole meant copying and then parsing tens of megabytes of it per
	// user turn to read a few hundred bytes (see Store.EventsOfType).
	for _, event := range w.store.EventsOfType("user_message", "user_message_echoed") {
		var payload struct {
			Content json.RawMessage `json:"content"`
		}
		if json.Unmarshal(event.Payload, &payload) != nil {
			continue
		}
		stored := payload.Content
		switch event.Type {
		case "user_message":
			if contentKey(stored) != key {
				continue
			}
			if strings.HasPrefix(event.SourceId, "claude:") {
				fromTranscript++
				if len(pending) > 0 {
					pending = pending[1:]
				}
			} else {
				pending = append(pending, event.Seq)
			}
		case "user_message_echoed":
			if contentKey(stored) == key && len(pending) > 0 {
				pending = pending[1:]
			}
		}
	}
	if len(pending) == 0 {
		// Nothing of Hydra's to pair with. If we are replaying a transcript and
		// already hold a copy that itself came from a transcript, this is the same
		// message a second time, not a second send: an import re-reads the whole
		// file whenever the CLI starts a new one (a `--continue` resume forks the
		// conversation into a fresh transcript, re-stamping every line with a new
		// uuid), so source-id dedup cannot see it.
		//
		// This only bites for messages Hydra never recorded - notably its own
		// resume nudge, which nudgeResumedChatAgent writes straight to stdin. Those
		// gained a duplicate bubble per resume. A message the user actually sent is
		// recorded at the queue boundary, so it pairs above and never reaches here.
		return provider == "claude_history" && fromTranscript > 0
	}
	echo := UserMessageEchoed{}
	echo.UserSeq, echo.Content = pending[0], msg.Content
	_, _, err := w.store.AppendSource(spec.sourceID, echo)
	return err == nil
}

// contentKey canonicalises a user message's content so the same message can be
// recognised across a provider echo. Object key ordering is normalised by
// round-tripping, because a provider payload is a struct while a replayed one
// from the store is a map.
func contentKey(content json.RawMessage) string {
	if len(content) == 0 {
		return ""
	}
	var canonical any
	if json.Unmarshal(content, &canonical) != nil {
		return ""
	}
	out, err := json.Marshal(canonical)
	if err != nil {
		return ""
	}
	return string(out)
}

func (w *worker) settleCodexPartialOnInterrupt(specs []eventSpec) []eventSpec {
	out := make([]eventSpec, 0, len(specs)+len(w.codexAssistantDeltas))
	for _, spec := range specs {
		switch payload := spec.payload.(type) {
		case *AssistantDelta:
			if !payload.Sidechain && payload.MessageId != "" {
				w.codexAssistantDeltas[payload.MessageId] += payload.Text
			}
		case *AssistantMessage:
			delete(w.codexAssistantDeltas, payload.MessageId)
		case *TurnInterrupted:
			for id, text := range w.codexAssistantDeltas {
				if strings.TrimSpace(text) != "" {
					settled := &AssistantMessage{}
					settled.MessageId, settled.Text, settled.Partial = id, text, true
					out = append(out, eventSpec{sourceID: "codex:partial:" + id, payload: settled})
				}
			}
			clear(w.codexAssistantDeltas)
		case *TurnCompleted, *TurnFailed:
			clear(w.codexAssistantDeltas)
		}
		out = append(out, spec)
	}
	return out
}

func pendingCodexAssistantDeltas(events []Event) map[string]string {
	pending := map[string]string{}
	for _, event := range events {
		var payload map[string]any
		_ = json.Unmarshal(event.Payload, &payload)
		messageID, _ := payload["message_id"].(string)
		switch event.Type {
		case "assistant_delta":
			if payload["sidechain"] != true && messageID != "" {
				if text, ok := payload["text"].(string); ok {
					pending[messageID] += text
				}
			}
		case "assistant_message":
			delete(pending, messageID)
		case "turn_completed", "turn_failed", "turn_interrupted":
			clear(pending)
		}
	}
	return pending
}

func codexLineThreads(line []byte) (threadID, startedThread string) {
	var msg codexMessage
	if json.Unmarshal(line, &msg) != nil {
		return "", ""
	}
	var params codexParams
	if json.Unmarshal(msg.Params, &params) != nil {
		return "", ""
	}
	if msg.Method == "thread/started" {
		startedThread = params.Thread.ID
	}
	return params.ThreadID, startedThread
}

func codexSpawnFromLine(line []byte) (codexSpawn, bool) {
	var msg codexMessage
	if json.Unmarshal(line, &msg) != nil || msg.Method != "item/started" {
		return codexSpawn{}, false
	}
	var params codexParams
	if json.Unmarshal(msg.Params, &params) != nil {
		return codexSpawn{}, false
	}
	var item codexItem
	if json.Unmarshal(params.Item, &item) != nil || item.Type != "collabAgentToolCall" || codexCollabTool(item.Tool) != "spawnagent" {
		return codexSpawn{}, false
	}
	return codexSpawn{ToolID: item.ID, Prompt: item.Prompt, ParentId: item.SenderThreadID}, item.ID != ""
}

func causalItemID(payload any) string {
	raw, _ := json.Marshal(payload)
	var value struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(raw, &value)
	return value.ID
}

func (w *worker) reconcileCommits(id, causalItemID, mergedRef string) {
	if w.ctx.Worktree == "" {
		return
	}
	oldHead := w.store.Snapshot().Head
	newHead, err := git.ResolveRef(w.ctx.Worktree, "HEAD")
	if err != nil || newHead == oldHead {
		return
	}
	isAncestor, ancestorErr := git.IsAncestor(w.ctx.Worktree, oldHead, newHead)
	if oldHead != "" && ancestorErr == nil && isAncestor {
		if w.appendAbsorbedBase(id, oldHead, newHead, mergedRef) {
			return
		}
		// Walk first parents only: a merge (e.g. the agent merging main in) then
		// surfaces as one commit rather than replaying every merged-in commit into
		// the chat feed. The merge's own summary carries the collapsed list.
		commits, err := git.ListFirstParentCommits(w.ctx.Worktree, oldHead, newHead)
		if err == nil {
			for i := len(commits) - 1; i >= 0; i-- {
				c := commits[i]
				commit := CommitCreated{}
				commit.Head, commit.Sha, commit.ShortSha = newHead, c.SHA, c.ShortSHA
				commit.Subject, commit.AuthorName = c.Subject, c.AuthorName
				commit.AuthorEmail, commit.Timestamp = c.AuthorEmail, c.Timestamp
				commit.CausalItemId = causalItemID
				w.annotateMerge(&c, &commit, "")
				if _, _, err := w.store.AppendSource("git:commit:"+c.SHA, commit); err != nil {
					log.Printf("warn: chat events: append commit for %s: %v", id, err)
				}
			}
			return
		}
	}
	moved := HeadChanged{}
	moved.OldHead, moved.Head = oldHead, newHead
	_, _ = w.store.Append(moved)
}

// mergedCommitsCap bounds how many merged-in commits a merge chip embeds for its
// expansion. A merge of a long-diverged base can drag in thousands; the list is a
// convenience preview, so cap it and report the true total in merged_count.
const mergedCommitsCap = 100

// annotateMerge enriches a merge commit's payload with the commits it brought in
// (its second parent's history not already on the first parent), so the chat can
// render a single collapsed "Merged ... - N commits" chip that expands to the list.
// mergedRef labels the chip when the caller knows which ref came in; otherwise the
// chip reads it out of the commit subject.
func (w *worker) annotateMerge(c *git.CommitInfo, commit *CommitCreated, mergedRef string) {
	if !c.IsMerge() || len(c.Parents) < 2 {
		return
	}
	merged, err := git.ListCommits(w.ctx.Worktree, c.Parents[0], c.Parents[1])
	if err != nil || len(merged) == 0 {
		return
	}
	commit.IsMerge = true
	commit.MergedRef = mergedRef
	commit.MergedCount = len(merged)
	commit.MergedCommits = cappedMergedCommits(merged)
}

// cappedMergedCommits is the preview list a merge chip expands to, bounded by
// mergedCommitsCap.
func cappedMergedCommits(merged []git.CommitInfo) []api.ChatMergedCommit {
	limit := min(len(merged), mergedCommitsCap)
	list := make([]api.ChatMergedCommit, 0, limit)
	for _, m := range merged[:limit] {
		list = append(list, api.ChatMergedCommit{
			Sha: m.SHA, ShortSha: m.ShortSHA, Subject: m.Subject,
			AuthorName: m.AuthorName, Timestamp: m.Timestamp,
		})
	}
	return list
}

// appendAbsorbedBase records a head that took its base in by FAST-FORWARD as the
// one thing that happened - "Merged main - N commits" - and reports whether it
// did.
//
// A fast-forward leaves the branch sitting ON the base's own tip, so the
// first-parent walk below would replay the BASE's timeline into this head's
// chat: main's merges of OTHER heads, rendered from their subjects as
// "Merged hydra/some-other-head", which reads as if Hydra had just merged a
// stranger's branch into this one. It didn't - that commit was already on main.
// The head absorbed main; that is what the chip says, and it expands to every
// commit that came in.
//
// Only the ref that was actually pulled in qualifies: the hint from an
// update-from-base / pull-from-MR, else the head's own base. If the branch
// fast-forwarded onto something else (an agent merging a sibling head in), the
// walk stays the honest account and this returns false.
func (w *worker) appendAbsorbedBase(id, oldHead, newHead, mergedRef string) bool {
	ref := mergedRef
	if ref == "" {
		ref = w.ctx.BaseBranch
	}
	if ref == "" {
		return false
	}
	if tip, err := git.ResolveRef(w.ctx.Worktree, ref); err != nil || tip != newHead {
		return false // not a fast-forward onto the base - a real merge commit, or the head's own work
	}
	merged, err := git.ListCommits(w.ctx.Worktree, oldHead, newHead)
	if err != nil || len(merged) == 0 {
		return false
	}
	c, err := git.GetCommitInfo(w.ctx.Worktree, newHead)
	if err != nil {
		return false
	}
	commit := CommitCreated{}
	commit.Head, commit.Sha, commit.ShortSha = newHead, c.SHA, c.ShortSHA
	commit.Subject, commit.AuthorName = c.Subject, c.AuthorName
	commit.AuthorEmail, commit.Timestamp = c.AuthorEmail, c.Timestamp
	commit.IsMerge, commit.MergedRef = true, ref
	commit.MergedCount, commit.MergedCommits = len(merged), cappedMergedCommits(merged)
	if _, _, err := w.store.AppendSource("git:commit:"+newHead, commit); err != nil {
		log.Printf("warn: chat events: append base update for %s: %v", id, err)
	}
	return true
}

// Flush waits until every provider line queued before it has been normalized
// and persisted. Attach uses this before taking its projection watermark.
func (m *Manager) Flush(id string) error {
	w, err := m.worker(id)
	if err != nil {
		return errtrace.Wrap(err)
	}
	if !w.imported && w.ctx.AgentType == "claude" {
		w.imported = true
		m.importClaudeHistory(id, w)
	}
	done := make(chan struct{})
	w.in <- observedLine{done: done}
	<-done
	// A quiet point - the queue is empty and a client is usually about to attach.
	// Appends only checkpoint the projection every so often (see
	// checkpointInterval), so put the current fold down while nothing is racing
	// it, and Open has less to replay if the daemon dies mid-conversation.
	w.store.Checkpoint()
	return nil
}

func (m *Manager) importClaudeHistory(id string, w *worker) {
	if data, err := os.ReadFile(paths.GetChatThinkingJsonFromProjectRoot(w.ctx.ProjectRoot, id)); err == nil {
		var durations map[string]int64
		if json.Unmarshal(data, &durations) == nil {
			for messageID, durationMS := range durations {
				measured := ReasoningDuration{}
				measured.MessageId, measured.DurationMs = messageID, durationMS
				_, _, _ = w.store.AppendSource("claude:thinking:"+messageID, measured)
			}
		}
	}
	if w.ctx.Worktree == "" {
		return
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return
	}
	dir := filepath.Join(home, ".claude", "projects", paths.ClaudeProjectsSlug(w.ctx.Worktree))
	transcript := claudestream.LatestTranscript(dir)
	if transcript == "" {
		return
	}
	offset := w.store.ImportOffset("claude:" + transcript)
	lines, nextOffset, err := claudestream.TranscriptLinesAfter(transcript, offset)
	if err == nil {
		skippedSeed := false
		for _, line := range lines {
			if !skippedSeed && w.ctx.Prompt != "" && claudeHistoryUserText(line) == w.ctx.Prompt {
				skippedSeed = true
				continue
			}
			w.in <- observedLine{provider: "claude_history", line: line}
		}
		done := make(chan struct{})
		w.in <- observedLine{done: done}
		<-done
		_ = w.store.SetImportOffset("claude:"+transcript, nextOffset)
	}
	sessionID := strings.TrimSuffix(filepath.Base(transcript), ".jsonl")
	subs, _ := claudestream.TailSubagentTranscripts(dir, sessionID, 0)
	for _, sub := range subs {
		meta := sub.Meta
		_, _, _ = w.store.AppendSource("claude:subagent:"+sub.AgentID, claudeSubagentStarted(sub.AgentID, meta))
		for _, line := range sub.Lines {
			w.in <- observedLine{provider: "claude_history", line: addClaudeSidechain(line, sub.AgentID, meta)}
		}
	}
}

func claudeHistoryUserText(line []byte) string {
	var value struct {
		Type    string `json:"type"`
		IsMeta  bool   `json:"isMeta"`
		Message struct {
			Content json.RawMessage `json:"content"`
		} `json:"message"`
	}
	if json.Unmarshal(line, &value) != nil || value.Type != "user" || value.IsMeta {
		return ""
	}
	return textFromClaudeContent(value.Message.Content)
}

func addClaudeSidechain(line []byte, agentID string, meta *claudestream.SubagentMeta) []byte {
	var value map[string]any
	if json.Unmarshal(line, &value) != nil {
		return line
	}
	value["isSidechain"] = true
	value["agentId"] = agentID
	if meta != nil && meta.ToolUseID != "" {
		value["parent_tool_use_id"] = meta.ToolUseID
	}
	out, _ := json.Marshal(value)
	return out
}

func (m *Manager) Append(id string, payload Payload) (Event, error) {
	s, err := m.store(id)
	if err != nil {
		return Event{}, errtrace.Wrap(err)
	}
	return errtrace.Wrap2(s.Append(payload))
}

// RetractOrphanedTurn is called when a chat head is about to be RESUMED, before
// the new CLI process can append anything. It compares the tail of the head's
// normalized log against the CLI's own transcript and, if the dead process left
// blocks behind that the CLI never committed, appends one messages_retracted
// event naming them - so the re-run of that turn doesn't leave the browser
// showing the agent saying the same thing twice. See orphans.go for why the
// transcript is the arbiter.
//
// It returns the uuids retracted (nil when there was nothing to do, which is the
// overwhelmingly common case). Errors reading the log are returned; an
// unreadable transcript is not an error, it just means no retraction.
func (m *Manager) RetractOrphanedTurn(id, transcriptDir string) ([]string, error) {
	s, err := m.store(id)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	orphans := OrphanedUUIDs(s.Events(), transcriptDir)
	if len(orphans) == 0 {
		return nil, nil
	}
	retracted := MessagesRetracted{}
	retracted.MessageIds = orphans
	if _, err := s.Append(retracted); err != nil {
		return nil, errtrace.Wrap(err)
	}
	return orphans, nil
}

func (m *Manager) Snapshot(id string) (Projection, error) {
	s, err := m.store(id)
	if err != nil {
		return Projection{}, errtrace.Wrap(err)
	}
	return s.Snapshot(), nil
}

func (m *Manager) Before(id, cursor string, limit int) ([]Event, string, bool, error) {
	s, err := m.store(id)
	if err != nil {
		return nil, "", false, errtrace.Wrap(err)
	}
	return errtrace.Wrap4(s.Before(cursor, limit))
}

// SubagentEvents returns sub-agent subID's full (unpaginated) event history for
// the head id, so a client can render that sub-agent's tab on demand without
// waiting for the main conversation to page back to where the sub-agent ran.
func (m *Manager) SubagentEvents(id, subID string) ([]Event, error) {
	s, err := m.store(id)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	return s.SubagentEvents(subID), nil
}

func (m *Manager) Watch(id string) (Projection, <-chan Event, func(), error) {
	s, err := m.store(id)
	if err != nil {
		return Projection{}, nil, nil, errtrace.Wrap(err)
	}
	snapshot, events, cancel := s.Watch()
	return snapshot, events, cancel, nil
}

// claudeSubagentStarted is the lifecycle event for a Claude sub-agent, built
// from its meta sidecar (which may not exist yet, in which case only the id and
// a running status are known).
func claudeSubagentStarted(agentID string, meta *claudestream.SubagentMeta) *SubagentStarted {
	started := &SubagentStarted{}
	started.Id, started.AgentType, started.Status = agentID, "claude", "running"
	if meta != nil {
		started.AgentType, started.Description = meta.AgentType, meta.Description
		started.ParentId, started.ParentItemId = meta.ParentAgentID, meta.ToolUseID
	}
	return started
}

// codexSubagent is the shared body of a Codex sub-agent's start and completion.
func codexSubagent(threadID string, spawn codexSpawn, status string) api.ChatSubagentPayload {
	return api.ChatSubagentPayload{
		Id: threadID, ParentId: spawn.ParentId, AgentType: "codex",
		Description: spawn.Prompt, Prompt: spawn.Prompt, Status: status,
	}
}
