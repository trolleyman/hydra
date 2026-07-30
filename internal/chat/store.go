// Package chat owns Hydra's provider-neutral chat event stream and its
// materialized current-state projection. Provider adapters translate their CLI
// protocols into Events; HTTP clients only consume this stable representation.
package chat

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"sync"
	"time"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/paths"
)

const ProjectionVersion = 1

// The chat event log and projection are declared once, in api/openapi.yaml, and
// generated for both Go and the browser (see docs/chat-mode.md). These aliases
// give the package its own names for them, so a chat socket serializes exactly
// what the schema describes and the two cannot drift.
//
// Event is one durable normalized event. Seq is the per-head, monotonically
// increasing cursor and stable wire identity; Payload is type-specific but
// provider-neutral JSON.
type Event = api.ChatEvent

type TurnState = api.ChatTurnState

type SubagentState = api.ChatSubagentState

type QueuedState = api.ChatQueuedState

// StreamState is the block a response is in the middle of producing: the text
// accumulated from every delta no completed message has settled yet. It is
// derived on read (see pendingStream) rather than applied and checkpointed, so
// it never bloats the persisted projection - its only job is to let a client
// attaching mid-response render the whole partial block instead of just the
// tail it happens to catch live.
type StreamState = api.ChatStreamState

const (
	StreamKindText     = api.Text
	StreamKindThinking = api.Thinking
)

// Projection is bounded current operational state. Full messages and tool
// output remain in the event log and are intentionally absent here.
type Projection = api.ChatProjection

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
	// lastSync is when the log was last flushed to the device; see syncInterval.
	lastSync time.Time
	// lastCheckpoint is when the projection was last written; see
	// checkpointInterval. checkpointDue marks a fold not yet on disk.
	lastCheckpoint time.Time
	checkpointDue  bool
}

// syncInterval is the most often an append will fsync the event log.
//
// Every append used to fsync, which on a busy head is one device flush per event
// - and a chat head emits thousands (assistant deltas, usage updates, tool
// calls). Measured on the machine this was found on, hydra was the largest source
// of fsyncs on the entire system, three times the next process, against a
// per-write wait of ~56ms. On ext4 an fsync forces a journal commit that
// unrelated writers to the same filesystem then queue behind, which is how a
// daemon writing only ~1.3 MB/s can stall a desktop.
//
// Coalescing bounds what a power cut can lose to one interval's worth of events,
// which is the right trade here: an application crash loses nothing either way
// (the bytes are already written and the OS still flushes them - fsync only
// defends against losing power or the kernel), and most of a chat log is
// reconstructible from the provider's own transcript, which importClaudeHistory
// replays and AppendSource dedups.
const syncInterval = 2 * time.Second

// checkpointInterval is the most often an append will rewrite the projection.
//
// The projection is written WHOLE - marshal, write, rename - and that used to
// happen on every append, so its cost was its own size multiplied by the event
// count, and it grew with the head. Measured across this machine's seven chat
// heads: ~130MB rewritten against 77MB of actual log, and for the busiest head
// 100MB of rewrites against a 26MB log. (An upper bound - the file grew to that
// size over the run - but the same order either way, and the wrong way round.)
//
// Lagging it is safe because the projection is a CHECKPOINT, not the record.
// `Through` says how far it was folded; Open replays the events past that mark
// (see TestStoreRecoversFromCheckpointLagAndPartialTail, which is exactly this
// case), and Snapshot serves the IN-MEMORY fold, so nothing a client is shown
// can be stale - only the file, and only until the next event or the next Open.
//
// Thirty seconds, not the log's two: the events are spread thinly enough that
// the interval buys much more here than it does for fsyncs. Rewrite volume
// across those heads, by interval:
//
//	per append  139MB      10s   15MB (11%)
//	2s           45MB      30s    6MB ( 4%)
//	5s           25MB      60s    3MB ( 2%)
//
// What a longer interval costs is replay on an unclean restart, and that is
// almost nothing: load() reads and unmarshals the WHOLE log either way, so the
// lag adds only the in-memory apply() over the events past the mark - at most 68
// of them for a 30s window, measured over the busiest stretch of every head
// here. Flush checkpoints at each attach on top of that.
const checkpointInterval = 30 * time.Second

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
		if ev.SourceId != "" {
			s.sourceIDs[ev.SourceId] = ev.Seq
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

// SetImportOffset records how far a source file has been read. Checkpointed on
// the same terms as a fold: losing the last interval's worth costs a re-read of
// lines the readers already treat as idempotent (AppendSource dedups them), not
// a wrong timeline.
func (s *Store) SetImportOffset(source string, offset int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.projection.Imports[source] = offset
	return errtrace.Wrap(s.checkpoint(false))
}

// Append durably writes an event, applies it to the current projection, then
// checkpoints that projection (at most once per checkpointInterval - see
// checkpoint). A crash between the first two writes
// is repaired by replaying events after Projection.Through on Open.
func (s *Store) Append(payload Payload) (Event, error) {
	ev, _, err := s.AppendSource("", payload)
	return ev, errtrace.Wrap(err)
}

// AppendSource is Append with a provider-stable deduplication key. It returns
// appended=false and the original event when replay/backfill presents a source
// item already recorded by the live stream.
func (s *Store) AppendSource(sourceID string, payload Payload) (ev Event, appended bool, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	// The payload names its own type, so the two cannot disagree (see events.go).
	eventType := payload.EventType()
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
	ev = Event{Seq: seq, SourceId: sourceID, Type: eventType, Timestamp: s.now().UTC(), Payload: raw}
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
	// Flush at most every syncInterval rather than on every event. The write has
	// already happened; this only decides when it reaches the device.
	if now := s.now(); writeErr == nil && now.Sub(s.lastSync) >= syncInterval {
		writeErr = f.Sync()
		s.lastSync = now
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
	if err := s.checkpoint(false); err != nil {
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

// Checkpoint writes the projection now, whatever the interval says. For a quiet
// point where the cost does not land on a busy append path.
func (s *Store) Checkpoint() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.checkpointDue {
		return
	}
	if err := s.checkpoint(true); err != nil {
		log.Printf("warn: chat store: checkpoint %s: %v", s.projectionPath, err)
	}
}

// checkpoint writes the projection, at most once per checkpointInterval unless
// forced. The caller must hold the lock. A fold that misses its turn is not
// lost: it stays marked until a later append (or a forced write) puts it down,
// and until then Open's replay is what recovers it.
func (s *Store) checkpoint(force bool) error {
	s.checkpointDue = true
	if now := s.now(); force || now.Sub(s.lastCheckpoint) >= checkpointInterval {
		if err := s.persistProjection(); err != nil {
			return errtrace.Wrap(err)
		}
		s.lastCheckpoint, s.checkpointDue = now, false
	}
	return nil
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

// SubagentEvents returns every display event belonging to sub-agent subID (its
// sidechain steps, which carry agent_id == subID in the payload), oldest-first.
// Stream-only deltas are excluded, mirroring Before. Unlike the main history
// window this is deliberately NOT paginated: a single sub-agent's transcript is
// bounded, and the client needs all of it to render the sub-agent's tab on
// demand - a sub-agent's steps may sit entirely outside the loaded main
// conversation window (an early sub-agent in a long chat), so paging the main
// history to reach them is neither reliable nor cheap. The lifecycle
// (subagent_started/completed) events are keyed by id, not agent_id, and reach
// the client via the projection snapshot, so they are intentionally omitted.
func (s *Store) SubagentEvents(subID string) []Event {
	s.mu.Lock()
	defer s.mu.Unlock()
	if subID == "" {
		return nil
	}
	var out []Event
	for _, ev := range s.events {
		if streamOnly(ev.Type) {
			continue
		}
		var v struct {
			AgentID string `json:"agent_id"`
		}
		if json.Unmarshal(ev.Payload, &v) != nil || v.AgentID != subID {
			continue
		}
		out = append(out, ev)
	}
	return out
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
		var kind api.ChatStreamStateKind
		switch ev.Type {
		case "assistant_delta":
			kind = StreamKindText
		case "reasoning_delta":
			kind = StreamKindThinking
		default:
			continue
		}
		var v struct {
			Text      string `json:"text"`
			MessageId string `json:"message_id"`
			Sidechain bool   `json:"sidechain"`
		}
		if json.Unmarshal(ev.Payload, &v) != nil || v.Sidechain {
			continue
		}
		// A kind switch inside the run (reasoning that ran straight into text
		// without a completed message between) starts a fresh block.
		if pending == nil || pending.Kind != kind || pending.MessageId != v.MessageId {
			pending = &StreamState{Kind: kind, MessageId: v.MessageId}
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
	ParentId      string          `json:"parent_id,omitempty"`
	ParentItemId  string          `json:"parent_item_id,omitempty"`
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
		cur.Id = v.ID
		if v.ParentId != "" {
			cur.ParentId = v.ParentId
		}
		if v.ParentItemId != "" {
			cur.ParentItemId = v.ParentItemId
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
			p.Turn = &TurnState{Id: v.ID, Status: v.Status}
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
		p.Queue[v.ID] = QueuedState{Id: v.ID, Status: v.Status, Content: cloneRaw(v.Content)}
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
