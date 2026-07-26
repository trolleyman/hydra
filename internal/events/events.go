// Package events provides a small in-process pub/sub hub that fans "something
// changed, refetch it" signals out to connected web clients, replacing per-tab
// polling (see PLAN #50). Most events deliberately carry no payload beyond a
// type and an optional project scope: the daemon stays the single source of
// truth, and an event just nudges the client to run the fetch it would
// otherwise have polled. The exception is high-frequency incremental state
// (AgentTestsChanged) that would make refetch-on-nudge too chatty: those carry
// a small payload the client patches in place, coalesced per Key so a slow
// reader only ever sees the latest value.
package events

import "sync"

// Type identifies which resource changed. The string values match the JSON the
// web client switches on.
type Type string

const (
	// AgentsChanged: an agent's status/title/unread flag changed, or one was
	// spawned/killed/merged. Project-scoped.
	AgentsChanged Type = "agents_changed"
	// ProjectsChanged: the cross-project list or unread totals changed. Broadcast
	// to every subscriber (it drives the "updates elsewhere" indicator).
	ProjectsChanged Type = "projects_changed"
	// ServicesChanged: a supervised service's state changed. Project-scoped.
	ServicesChanged Type = "services_changed"
	// PushStatusChanged: the project branch's ahead/behind relative to its remote
	// changed (e.g. a background fetch saw new upstream commits). Project-scoped.
	PushStatusChanged Type = "push_status_changed"
	// AgentTestsChanged: one head's live test summary ticked (a streamed
	// type=stdout run appending cases). Project-scoped, carries the new summary
	// as Payload keyed by the agent id - the client patches the agent's chip in
	// place instead of refetching the whole agent list.
	AgentTestsChanged Type = "agent_tests_changed"
	// AgentStatusChanged: one head's live status bundle changed (status string,
	// activity line, or last message). Project-scoped, carries the bundle as Payload
	// keyed by the agent id so the client patches that one row in place. Unlike
	// AgentsChanged this fires on every per-tool-call activity change, which is far
	// too frequent for a full-list refetch.
	AgentStatusChanged Type = "agent_status_changed"
)

// Event is one change signal. ProjectRoot scopes a project-specific event to
// subscribers watching that (normalized) root; an empty ProjectRoot is a
// broadcast delivered to all subscribers.
//
// Key + Payload turn an event into a payload event: instead of coalescing by
// Type alone (a boolean "refetch this"), pending payload events coalesce by
// (Type, Key) with the LATEST Payload winning - right for incremental state
// where only the newest value matters (e.g. a ticking test summary per agent).
type Event struct {
	Type        Type
	ProjectRoot string
	Key         string // coalescing key within Type ("" = plain type-level event)
	Payload     any    // opaque to the hub; the WS layer knows how to frame it
}

// Hub fans coalesced events out to per-subscriber queues. The zero value is not
// usable; call NewHub. All methods are safe for concurrent use and nil-safe on
// the receiver, so callers that may not have a hub (boot warmup, tests) can pass
// nil without guarding every call.
type Hub struct {
	mu   sync.Mutex
	subs map[*Subscription]struct{}
}

// NewHub returns an empty hub.
func NewHub() *Hub { return &Hub{subs: map[*Subscription]struct{}{}} }

// Publish delivers ev to every interested subscriber. Non-blocking and cheap; a
// no-op when there are no subscribers (or the hub is nil).
func (h *Hub) Publish(ev Event) {
	if h == nil {
		return
	}
	h.mu.Lock()
	for s := range h.subs {
		s.offer(ev)
	}
	h.mu.Unlock()
}

// AgentsChanged publishes a project-scoped agents event.
func (h *Hub) AgentsChanged(projectRoot string) {
	h.Publish(Event{Type: AgentsChanged, ProjectRoot: projectRoot})
}

// ServicesChanged publishes a project-scoped services event.
func (h *Hub) ServicesChanged(projectRoot string) {
	h.Publish(Event{Type: ServicesChanged, ProjectRoot: projectRoot})
}

// ProjectsChanged publishes a broadcast projects event.
func (h *Hub) ProjectsChanged() {
	h.Publish(Event{Type: ProjectsChanged})
}

// PushStatusChanged publishes a project-scoped push-status event.
func (h *Hub) PushStatusChanged(projectRoot string) {
	h.Publish(Event{Type: PushStatusChanged, ProjectRoot: projectRoot})
}

// AgentTestsChanged publishes one head's ticked live test summary, coalesced
// per agent id (latest payload wins for a slow reader).
func (h *Hub) AgentTestsChanged(projectRoot, agentID string, payload any) {
	h.Publish(Event{Type: AgentTestsChanged, ProjectRoot: projectRoot, Key: agentID, Payload: payload})
}

// AgentStatusChanged publishes one head's changed live status bundle (status +
// activity + last message), coalesced per agent id so a slow reader only sees the
// latest value for that head.
func (h *Hub) AgentStatusChanged(projectRoot, agentID string, payload any) {
	h.Publish(Event{Type: AgentStatusChanged, ProjectRoot: projectRoot, Key: agentID, Payload: payload})
}

// Subscribe registers a subscriber scoped to projectRoot. It receives project
// events matching that root plus all broadcasts. Close it when done.
func (h *Hub) Subscribe(projectRoot string) *Subscription {
	s := &Subscription{
		hub:     h,
		root:    projectRoot,
		pending: map[Type]struct{}{},
		notify:  make(chan struct{}, 1),
	}
	// A nil hub yields an inert subscription (never fires) so callers don't need to
	// special-case "push disabled".
	if h == nil {
		return s
	}
	h.mu.Lock()
	h.subs[s] = struct{}{}
	h.mu.Unlock()
	return s
}

// Subscription is one client's coalescing event queue. Pending plain events
// are deduplicated by Type (many rapid agents_changed collapse to one) and
// payload events by (Type, Key) with the latest payload winning, so a slow
// reader never sees a backlog - only the set of resources that need refetching
// plus the newest value of each incremental key.
type Subscription struct {
	hub  *Hub
	root string

	notify chan struct{}

	mu       sync.Mutex
	pending  map[Type]struct{}
	payloads map[string]Event // (Type, Key) → latest payload event
	closed   bool
}

// offer enqueues ev for this subscriber if it matches its scope, coalescing
// repeats of the same Type (or Type+Key for payload events), and wakes the
// reader without blocking.
func (s *Subscription) offer(ev Event) {
	if ev.ProjectRoot != "" && ev.ProjectRoot != s.root {
		return
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	if ev.Key != "" {
		if s.payloads == nil {
			s.payloads = map[string]Event{}
		}
		s.payloads[string(ev.Type)+"\x00"+ev.Key] = ev
	} else {
		s.pending[ev.Type] = struct{}{}
	}
	s.mu.Unlock()
	select {
	case s.notify <- struct{}{}:
	default: // a wake-up is already queued; the reader will drain everything
	}
}

// C is the wake-up channel: it receives a value whenever new events are pending.
func (s *Subscription) C() <-chan struct{} { return s.notify }

// Drain returns and clears the currently-pending events (nil if none): the
// coalesced plain type-level events first, then the latest payload event per
// (Type, Key).
func (s *Subscription) Drain() []Event {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.pending) == 0 && len(s.payloads) == 0 {
		return nil
	}
	out := make([]Event, 0, len(s.pending)+len(s.payloads))
	for t := range s.pending {
		out = append(out, Event{Type: t})
	}
	for _, ev := range s.payloads {
		out = append(out, ev)
	}
	clear(s.pending)
	clear(s.payloads)
	return out
}

// Close removes the subscriber from the hub. Idempotent.
func (s *Subscription) Close() {
	s.mu.Lock()
	s.closed = true
	s.mu.Unlock()
	if s.hub == nil {
		return
	}
	s.hub.mu.Lock()
	delete(s.hub.subs, s)
	s.hub.mu.Unlock()
}
