package chat

import (
	"braces.dev/errtrace"
	"encoding/json"
	"log"
	"sync"

	"github.com/trolleyman/hydra/internal/git"
)

type HeadContext struct {
	ProjectRoot string
	Worktree    string
	Prompt      string
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
	store *Store
	in    chan observedLine
	ctx   HeadContext
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
	w := &worker{store: s, in: make(chan observedLine, 1024), ctx: ctx}
	m.workers[id] = w
	if s.Snapshot().Through == 0 && ctx.Prompt != "" {
		_, _, _ = s.AppendSource("hydra:initial-prompt", "user_message", map[string]any{"id": "initial", "content": []map[string]any{{"type": "text", "text": ctx.Prompt}}})
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
		case "codex":
			specs = normalizeCodex(item.line)
		default:
			continue
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
	done := make(chan struct{})
	w.in <- observedLine{done: done}
	<-done
	return nil
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
