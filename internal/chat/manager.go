package chat

import (
	"braces.dev/errtrace"
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"

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
}

type codexSpawn struct {
	ToolID   string
	Prompt   string
	ParentID string
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
		_, _, _ = s.AppendSource("hydra:initial-prompt", "user_message", map[string]any{"id": "initial", "content": []map[string]any{{"type": "text", "text": ctx.Prompt}}})
	}
	if len(s.Snapshot().Plan) == 0 && ctx.Plan != "" && json.Valid([]byte(ctx.Plan)) {
		_, _, _ = s.AppendSource("hydra:initial-plan", "plan_updated", JSONPayload(map[string]any{"provider": ctx.AgentType}, "plan", []byte(ctx.Plan)))
	}
	if s.Snapshot().Head == "" && ctx.Worktree != "" {
		if head, err := git.ResolveRef(ctx.Worktree, "HEAD"); err == nil {
			_, _ = s.Append("head_observed", map[string]any{"head": head})
		}
	}
	go w.run(id)
	return s, nil
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

func (m *Manager) ObserveClaudeSidechain(id, agentID string, meta *claudestream.SubagentMeta, line []byte) {
	w, err := m.worker(id)
	if err != nil {
		return
	}
	payload := map[string]any{"id": agentID, "agent_type": "claude", "status": "running"}
	if meta != nil {
		payload["agent_type"] = meta.AgentType
		payload["description"] = meta.Description
		payload["parent_id"] = meta.ParentAgentID
		payload["parent_item_id"] = meta.ToolUseID
	}
	_, _, _ = w.store.AppendSource("claude:subagent:"+agentID, "subagent_started", payload)
	w.in <- observedLine{provider: "claude_history", line: addClaudeSidechain(line, agentID, meta)}
}

func (w *worker) run(id string) {
	for item := range w.in {
		if item.done != nil {
			close(item.done)
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
					specs = append([]eventSpec{{
						sourceID:  "codex:subagent:" + threadID,
						eventType: "subagent_started",
						payload:   map[string]any{"id": threadID, "parent_id": spawn.ParentID, "parent_item_id": spawn.ToolID, "agent_type": "codex", "description": spawn.Prompt, "prompt": spawn.Prompt, "status": "running"},
					}}, specs...)
				}
				for i := range specs {
					specs[i].payload = withCodexSidechain(specs[i].payload, threadID, spawn.ToolID)
					if (specs[i].eventType == "turn_completed" || specs[i].eventType == "turn_failed") && linked {
						specs = append(specs, eventSpec{sourceID: "codex:subagent:" + threadID + ":completed", eventType: "subagent_completed", payload: map[string]any{"id": threadID, "parent_id": spawn.ParentID, "parent_item_id": spawn.ToolID, "agent_type": "codex", "description": spawn.Prompt, "prompt": spawn.Prompt, "status": "completed"}})
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
			if _, _, err := w.store.AppendSource(spec.sourceID, spec.eventType, spec.payload); err != nil {
				log.Printf("warn: chat events: append %s event for %s: %v", item.provider, id, err)
			}
			if spec.eventType == "tool_completed" || spec.eventType == "turn_completed" || spec.eventType == "turn_failed" {
				w.reconcileCommits(id, causalItemID(spec.payload))
			}
		}
	}
}

func (w *worker) settleCodexPartialOnInterrupt(specs []eventSpec) []eventSpec {
	out := make([]eventSpec, 0, len(specs)+len(w.codexAssistantDeltas))
	for _, spec := range specs {
		payload, _ := spec.payload.(map[string]any)
		messageID, _ := payload["message_id"].(string)
		switch spec.eventType {
		case "assistant_delta":
			if payload["sidechain"] != true && messageID != "" {
				if text, ok := payload["text"].(string); ok {
					w.codexAssistantDeltas[messageID] += text
				}
			}
		case "assistant_message":
			delete(w.codexAssistantDeltas, messageID)
		case "turn_interrupted":
			for id, text := range w.codexAssistantDeltas {
				if strings.TrimSpace(text) != "" {
					out = append(out, eventSpec{sourceID: "codex:partial:" + id, eventType: "assistant_message", payload: map[string]any{"message_id": id, "text": text, "partial": true}})
				}
			}
			clear(w.codexAssistantDeltas)
		case "turn_completed", "turn_failed":
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

func withCodexSidechain(payload any, threadID, parentItemID string) any {
	raw, err := json.Marshal(payload)
	if err != nil {
		return payload
	}
	var value map[string]any
	if json.Unmarshal(raw, &value) != nil {
		return payload
	}
	value["sidechain"] = true
	value["agent_id"] = threadID
	if parentItemID != "" {
		value["parent_item_id"] = parentItemID
	}
	return value
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
	return codexSpawn{ToolID: item.ID, Prompt: item.Prompt, ParentID: item.SenderThreadID}, item.ID != ""
}

func causalItemID(payload any) string {
	raw, _ := json.Marshal(payload)
	var value struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(raw, &value)
	return value.ID
}

func (w *worker) reconcileCommits(id, causalItemID string) {
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
		commits, err := git.ListCommits(w.ctx.Worktree, oldHead, newHead)
		if err == nil {
			for i := len(commits) - 1; i >= 0; i-- {
				c := commits[i]
				payload := map[string]any{
					"head": newHead, "sha": c.SHA, "short_sha": c.ShortSHA,
					"subject": c.Subject, "author_name": c.AuthorName,
					"author_email": c.AuthorEmail, "timestamp": c.Timestamp,
					"causal_item_id": causalItemID,
				}
				if _, _, err := w.store.AppendSource("git:commit:"+c.SHA, "commit_created", payload); err != nil {
					log.Printf("warn: chat events: append commit for %s: %v", id, err)
				}
			}
			return
		}
	}
	_, _ = w.store.Append("head_changed", map[string]any{"old_head": oldHead, "head": newHead})
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
	return nil
}

func (m *Manager) importClaudeHistory(id string, w *worker) {
	if data, err := os.ReadFile(paths.GetChatThinkingJsonFromProjectRoot(w.ctx.ProjectRoot, id)); err == nil {
		var durations map[string]int64
		if json.Unmarshal(data, &durations) == nil {
			for messageID, durationMS := range durations {
				_, _, _ = w.store.AppendSource("claude:thinking:"+messageID, "reasoning_duration", map[string]any{"message_id": messageID, "duration_ms": durationMS})
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
		payload := map[string]any{"id": sub.AgentID, "agent_type": "claude", "status": "running"}
		if meta != nil {
			payload["agent_type"] = meta.AgentType
			payload["description"] = meta.Description
			payload["parent_id"] = meta.ParentAgentID
			payload["parent_item_id"] = meta.ToolUseID
		}
		_, _, _ = w.store.AppendSource("claude:subagent:"+sub.AgentID, "subagent_started", payload)
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

func (m *Manager) Append(id, eventType string, payload any) (Event, error) {
	s, err := m.store(id)
	if err != nil {
		return Event{}, errtrace.Wrap(err)
	}
	return errtrace.Wrap2(s.Append(eventType, payload))
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

func (m *Manager) Watch(id string) (Projection, <-chan Event, func(), error) {
	s, err := m.store(id)
	if err != nil {
		return Projection{}, nil, nil, errtrace.Wrap(err)
	}
	snapshot, events, cancel := s.Watch()
	return snapshot, events, cancel, nil
}

// JSONPayload makes callbacks that already own JSON (plans, usage, content)
// embed it without string-encoding it.
func JSONPayload(fields map[string]any, key string, raw []byte) map[string]any {
	fields[key] = json.RawMessage(raw)
	return fields
}
