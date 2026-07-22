// Package chat owns Hydra's provider-neutral chat event stream and its
// materialized current-state projection. Provider adapters translate their CLI
// protocols into Events; HTTP clients only consume this stable representation.
package chat

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"sync"
	"time"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/paths"
)

const ProjectionVersion = 1

// Event is one durable item in a head's normalized chat timeline. Seq is its
// monotonically increasing per-head cursor and stable wire identity. Payload is
// type-specific but provider-neutral JSON.
type Event struct {
	Seq       uint64          `json:"seq"`
	SourceID  string          `json:"source_id,omitempty"`
	Type      string          `json:"type"`
	Timestamp time.Time       `json:"timestamp"`
	Payload   json.RawMessage `json:"payload,omitempty"`
}

type TurnState struct {
	ID     string `json:"id,omitempty"`
	Status string `json:"status,omitempty"`
}

type SubagentState struct {
	ID           string `json:"id"`
	ParentID     string `json:"parent_id,omitempty"`
	ParentItemID string `json:"parent_item_id,omitempty"`
	AgentType    string `json:"agent_type,omitempty"`
	Description  string `json:"description,omitempty"`
	Prompt       string `json:"prompt,omitempty"`
	Status       string `json:"status,omitempty"`
	Activity     string `json:"activity,omitempty"`
}

type QueuedState struct {
	ID      string          `json:"id"`
	Status  string          `json:"status"`
	Content json.RawMessage `json:"content"`
}

// StreamState is the block a response is in the middle of producing: the text
// accumulated from every delta no completed message has settled yet. It is
// derived on read (see pendingStream) rather than applied and checkpointed, so
// it never bloats the persisted projection - its only job is to let a client
// attaching mid-response render the whole partial block instead of just the
// tail it happens to catch live.
type StreamState struct {
	Kind      string `json:"kind"` // "text" or "thinking"
	MessageID string `json:"message_id,omitempty"`
	Text      string `json:"text"`
}

// Projection is bounded current operational state. Full messages and tool
// output remain in the event log and are intentionally absent here.
type Projection struct {
	Version     int                      `json:"version"`
	Through     uint64                   `json:"through"`
	Plan        json.RawMessage          `json:"plan,omitempty"`
	Subagents   map[string]SubagentState `json:"subagents,omitempty"`
	Turn        *TurnState               `json:"turn,omitempty"`
	Interaction json.RawMessage          `json:"interaction,omitempty"`
	Model       string                   `json:"model,omitempty"`
	// SlashCommands the CLI advertised on its system:init. Persisted so the
	// composer's "/" autocomplete survives resume/re-attach - the list is only
	// emitted on the live init line, never in the transcript, so an old head
	// whose init has scrolled past the replay window would otherwise show none.
	SlashCommands []string               `json:"slash_commands,omitempty"`
	Usage         json.RawMessage        `json:"usage,omitempty"`
	Queue         map[string]QueuedState `json:"queue,omitempty"`
	Head          string                 `json:"head,omitempty"`
	Imports       map[string]int64       `json:"imports,omitempty"`
	// Read-only: filled on the copies Watch/Snapshot hand out, never applied or
	// persisted (see StreamState).
	Stream *StreamState `json:"stream,omitempty"`
}

// Store serializes appends and projection updates for one head.
type Store struct {
	mu             sync.Mutex
	eventsPath     string
	projectionPath string
	events         []Event
	sourceIDs      map[string]uint64
	projection     Projection
	now            func() time.Time
	subscribers    map[chan Event]struct{}
}

func Open(projectRoot, id string) (*Store, error) {
	s := &Store{
		eventsPath:     paths.GetChatEventsJSONLFromProjectRoot(projectRoot, id),
		projectionPath: paths.GetChatStateJSONFromProjectRoot(projectRoot, id),
		now:            time.Now,
		sourceIDs:      map[string]uint64{},
		subscribers:    map[chan Event]struct{}{},
		projection: Projection{
			Version:   ProjectionVersion,
			Subagents: map[string]SubagentState{},
			Queue:     map[string]QueuedState{},
			Imports:   map[string]int64{},
		},
	}
	if err := s.load(); err != nil {
		return nil, errtrace.Wrap(err)
	}
	return s, nil
}

func (s *Store) load() error {
	if data, err := os.ReadFile(s.projectionPath); err == nil {
		var p Projection
		if json.Unmarshal(data, &p) == nil && p.Version == ProjectionVersion {
			s.projection = p
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return errtrace.Wrap(err)
	}
	if s.projection.Subagents == nil {
		s.projection.Subagents = map[string]SubagentState{}
	}
	if s.projection.Queue == nil {
		s.projection.Queue = map[string]QueuedState{}
	}
	if s.projection.Imports == nil {
		s.projection.Imports = map[string]int64{}
	}

	data, err := os.ReadFile(s.eventsPath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return errtrace.Wrap(err)
	}
	validBytes := 0
	for len(data) > 0 {
		i := bytes.IndexByte(data, '\n')
		if i < 0 {
			break // incomplete crash tail
		}
		line := data[:i]
		data = data[i+1:]
		if len(bytes.TrimSpace(line)) == 0 {
			validBytes += i + 1
			continue
		}
		var ev Event
		if json.Unmarshal(line, &ev) != nil || ev.Seq == 0 || ev.Type == "" {
			break
		}
		s.events = append(s.events, ev)
		if ev.SourceID != "" {
			s.sourceIDs[ev.SourceID] = ev.Seq
		}
		validBytes += i + 1
		if ev.Seq > s.projection.Through {
			apply(&s.projection, ev)
		}
	}
	// Remove a partial/corrupt tail before the next append, otherwise the next
	// valid JSON object would be joined to it and become unrecoverable too.
	if info, statErr := os.Stat(s.eventsPath); statErr == nil && int64(validBytes) != info.Size() {
		if err := os.Truncate(s.eventsPath, int64(validBytes)); err != nil {
			return errtrace.Wrap(err)
		}
	}
	return nil
}

func (s *Store) ImportOffset(source string) int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.projection.Imports[source]
}

func (s *Store) SetImportOffset(source string, offset int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.projection.Imports[source] = offset
	return errtrace.Wrap(s.persistProjection())
}

// Append durably writes an event, applies it to the current projection, then
// atomically checkpoints that projection. A crash between the first two writes
// is repaired by replaying events after Projection.Through on Open.
func (s *Store) Append(eventType string, payload any) (Event, error) {
	ev, _, err := s.AppendSource("", eventType, payload)
	return ev, errtrace.Wrap(err)
}

// AppendSource is Append with a provider-stable deduplication key. It returns
// appended=false and the original event when replay/backfill presents a source
// item already recorded by the live stream.
func (s *Store) AppendSource(sourceID, eventType string, payload any) (ev Event, appended bool, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if eventType == "" {
		return Event{}, false, errtrace.Wrap(errors.New("chat event type is empty"))
	}
	if seq, ok := s.sourceIDs[sourceID]; sourceID != "" && ok {
		i := sort.Search(len(s.events), func(i int) bool { return s.events[i].Seq >= seq })
		if i < len(s.events) && s.events[i].Seq == seq {
			return s.events[i], false, nil
		}
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return Event{}, false, errtrace.Wrap(err)
	}
	seq := s.projection.Through + 1
	if n := len(s.events); n > 0 && s.events[n-1].Seq >= seq {
		seq = s.events[n-1].Seq + 1
	}
	ev = Event{Seq: seq, SourceID: sourceID, Type: eventType, Timestamp: s.now().UTC(), Payload: raw}
	line, err := json.Marshal(ev)
	if err != nil {
		return Event{}, false, errtrace.Wrap(err)
	}
	if err := os.MkdirAll(filepath.Dir(s.eventsPath), 0o755); err != nil {
		return Event{}, false, errtrace.Wrap(err)
	}
	f, err := os.OpenFile(s.eventsPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return Event{}, false, errtrace.Wrap(err)
	}
	_, writeErr := f.Write(append(line, '\n'))
	if writeErr == nil {
		writeErr = f.Sync()
	}
	closeErr := f.Close()
	if writeErr != nil {
		return Event{}, false, errtrace.Wrap(writeErr)
	}
	if closeErr != nil {
		return Event{}, false, errtrace.Wrap(closeErr)
	}
	s.events = append(s.events, ev)
	if sourceID != "" {
		s.sourceIDs[sourceID] = ev.Seq
	}
	apply(&s.projection, ev)
	if err := s.persistProjection(); err != nil {
		return Event{}, false, errtrace.Wrap(err)
	}
	for ch := range s.subscribers {
		select {
		case ch <- ev:
		default:
			close(ch)
			delete(s.subscribers, ch)
		}
	}
	return ev, true, nil
}

func (s *Store) persistProjection() error {
	data, err := json.Marshal(s.projection)
	if err != nil {
		return errtrace.Wrap(err)
	}
	if err := os.MkdirAll(filepath.Dir(s.projectionPath), 0o755); err != nil {
		return errtrace.Wrap(err)
	}
	tmp := s.projectionPath + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return errtrace.Wrap(err)
	}
	if err := os.Rename(tmp, s.projectionPath); err != nil {
		_ = os.Remove(tmp)
		return errtrace.Wrap(err)
	}
	return nil
}

// Snapshot returns a detached copy safe for encoding after the store unlocks.
func (s *Store) Snapshot() Projection {
	s.mu.Lock()
	defer s.mu.Unlock()
	data, _ := json.Marshal(s.projection)
	var out Projection
	_ = json.Unmarshal(data, &out)
	return out
}

func (s *Store) HasType(eventType string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, event := range s.events {
		if event.Type == eventType {
			return true
		}
	}
	return false
}

// Events returns a detached copy of the durable timeline. Manager-side
// reconciliation uses it to rebuild provider echo state after a restart.
func (s *Store) Events() []Event {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := append([]Event(nil), s.events...)
	for i := range out {
		out[i].Payload = append(json.RawMessage(nil), out[i].Payload...)
	}
	return out
}

// Watch atomically captures the current projection watermark and subscribes to
// every later append. A slow subscriber is closed instead of blocking provider
// ingestion; reconnect/cursor replay recovers the missed tail.
func (s *Store) Watch() (Projection, <-chan Event, func()) {
	s.mu.Lock()
	defer s.mu.Unlock()
	data, _ := json.Marshal(s.projection)
	var snapshot Projection
	_ = json.Unmarshal(data, &snapshot)
	// The subscriber's live channel starts after Through, so the partial block
	// in flight at this instant reaches it only as its remaining deltas.
	snapshot.Stream = s.pendingStream()
	ch := make(chan Event, 256)
	s.subscribers[ch] = struct{}{}
	var once sync.Once
	cancel := func() {
		once.Do(func() {
			s.mu.Lock()
			if _, ok := s.subscribers[ch]; ok {
				delete(s.subscribers, ch)
				close(ch)
			}
			s.mu.Unlock()
		})
	}
	return snapshot, ch, cancel
}

// streamOnly reports whether an event exists purely to drive the in-flight
// preview. Such events render as nothing on their own - the completed message
// that settles them carries the content - so history pages skip them: a single
// long response emits hundreds of token deltas, which would otherwise fill the
// whole window and leave a client that attached mid-response looking at a blank
// conversation until it paged back.
func streamOnly(eventType string) bool {
	switch eventType {
	case "assistant_delta", "reasoning_delta", "tool_delta", "content_stream_started", "content_stream_completed":
		return true
	}
	return false
}

// Before returns up to limit display events preceding the opaque cursor. An
// empty cursor starts at the current end. Results are oldest-first.
func (s *Store) Before(cursor string, limit int) ([]Event, string, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	before := uint64(^uint64(0))
	if cursor != "" {
		var err error
		before, err = strconv.ParseUint(cursor, 10, 64)
		if err != nil {
			return nil, "", false, errtrace.Wrap(fmt.Errorf("invalid chat cursor: %w", err))
		}
	}
	start := sort.Search(len(s.events), func(i int) bool { return s.events[i].Seq >= before })
	out := make([]Event, 0, limit)
	for start > 0 && len(out) < limit {
		start--
		if streamOnly(s.events[start].Type) {
			continue
		}
		out = append(out, s.events[start])
	}
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	next := ""
	if len(out) > 0 {
		next = strconv.FormatUint(out[0].Seq, 10)
	}
	return out, next, start == 0, nil
}

// pendingStream reconstructs the block currently being produced from the tail
// of the log: the run of deltas after the last event that would have settled or
// abandoned it. Callers must hold s.mu.
func (s *Store) pendingStream() *StreamState {
	i := len(s.events)
	// usage_updated is bookkeeping a provider can emit in the middle of a block
	// (Codex reports running token usage), so it must not cut the run short.
	for i > 0 && (streamOnly(s.events[i-1].Type) || s.events[i-1].Type == "usage_updated") {
		i--
	}
	var pending *StreamState
	for _, ev := range s.events[i:] {
		kind := ""
		switch ev.Type {
		case "assistant_delta":
			kind = "text"
		case "reasoning_delta":
			kind = "thinking"
		default:
			continue
		}
		var v struct {
			Text      string `json:"text"`
			MessageID string `json:"message_id"`
			Sidechain bool   `json:"sidechain"`
		}
		if json.Unmarshal(ev.Payload, &v) != nil || v.Sidechain {
			continue
		}
		// A kind switch inside the run (reasoning that ran straight into text
		// without a completed message between) starts a fresh block.
		if pending == nil || pending.Kind != kind || pending.MessageID != v.MessageID {
			pending = &StreamState{Kind: kind, MessageID: v.MessageID}
		}
		pending.Text += v.Text
	}
	if pending == nil || pending.Text == "" {
		return nil
	}
	return pending
}

type statePayload struct {
	ID            string          `json:"id,omitempty"`
	Status        string          `json:"status,omitempty"`
	ParentID      string          `json:"parent_id,omitempty"`
	ParentItemID  string          `json:"parent_item_id,omitempty"`
	AgentType     string          `json:"agent_type,omitempty"`
	Description   string          `json:"description,omitempty"`
	Prompt        string          `json:"prompt,omitempty"`
	Activity      string          `json:"activity,omitempty"`
	Model         string          `json:"model,omitempty"`
	Head          string          `json:"head,omitempty"`
	Plan          json.RawMessage `json:"plan,omitempty"`
	Interaction   json.RawMessage `json:"interaction,omitempty"`
	Usage         json.RawMessage `json:"usage,omitempty"`
	Content       json.RawMessage `json:"content,omitempty"`
	SlashCommands []string        `json:"slash_commands,omitempty"`
}

func apply(p *Projection, ev Event) {
	if ev.Seq <= p.Through {
		return
	}
	var v statePayload
	_ = json.Unmarshal(ev.Payload, &v)
	switch ev.Type {
	case "plan_updated":
		p.Plan = cloneRaw(v.Plan)
	case "subagent_started", "subagent_updated", "subagent_completed":
		cur := p.Subagents[v.ID]
		terminal := cur.Status == "completed" || cur.Status == "failed" || cur.Status == "cancelled"
		cur.ID = v.ID
		if v.ParentID != "" {
			cur.ParentID = v.ParentID
		}
		if v.ParentItemID != "" {
			cur.ParentItemID = v.ParentItemID
		}
		if v.AgentType != "" {
			cur.AgentType = v.AgentType
		}
		if v.Description != "" {
			cur.Description = v.Description
		}
		if v.Prompt != "" {
			cur.Prompt = v.Prompt
		}
		if v.Status != "" && !(terminal && ev.Type != "subagent_completed") {
			cur.Status = v.Status
		}
		if v.Activity != "" {
			cur.Activity = v.Activity
		}
		p.Subagents[v.ID] = cur
	case "turn_started", "turn_completed", "turn_failed", "turn_interrupted":
		// Claude follows its explicit interrupt echo with a protocol-level failed
		// result. Keep the more meaningful terminal state until the next turn
		// starts instead of letting that implementation detail overwrite it.
		if !(ev.Type == "turn_failed" && p.Turn != nil && p.Turn.Status == "interrupted") {
			p.Turn = &TurnState{ID: v.ID, Status: v.Status}
		}
	case "interaction_requested":
		p.Interaction = cloneRaw(v.Interaction)
	case "interaction_resolved":
		p.Interaction = nil
	case "model_changed":
		p.Model = v.Model
	case "conversation_started":
		if v.Model != "" {
			p.Model = v.Model
		}
		if len(v.SlashCommands) > 0 {
			p.SlashCommands = append([]string(nil), v.SlashCommands...)
		}
	case "usage_updated":
		p.Usage = cloneRaw(v.Usage)
	case "queued_message":
		p.Queue[v.ID] = QueuedState{ID: v.ID, Status: v.Status, Content: cloneRaw(v.Content)}
	case "queue_message_removed", "user_message":
		if v.ID != "" {
			delete(p.Queue, v.ID)
		}
	case "head_observed", "head_changed", "commit_created":
		if v.Head != "" {
			p.Head = v.Head
		}
	}
	p.Through = ev.Seq
}

func cloneRaw(in json.RawMessage) json.RawMessage {
	return append(json.RawMessage(nil), in...)
}
