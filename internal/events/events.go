// Package events provides a small in-process pub/sub hub that fans "something
// changed, refetch it" signals out to connected web clients, replacing per-tab
// polling (see PLAN #50). It deliberately carries no payload beyond a type and an
// optional project scope: the daemon stays the single source of truth, and an
// event just nudges the client to run the fetch it would otherwise have polled.
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
)

// Event is one change signal. ProjectRoot scopes a project-specific event to
// subscribers watching that (normalized) root; an empty ProjectRoot is a
// broadcast delivered to all subscribers.
type Event struct {
	Type        Type
	ProjectRoot string
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

// Subscription is one client's coalescing event queue. Pending events are
// deduplicated by Type (many rapid agents_changed collapse to one), so a slow
// reader never sees a backlog — only the set of resources that need refetching.
type Subscription struct {
	hub  *Hub
	root string

	notify chan struct{}

	mu      sync.Mutex
	pending map[Type]struct{}
	closed  bool
}

// offer enqueues ev for this subscriber if it matches its scope, coalescing
// repeats of the same Type, and wakes the reader without blocking.
func (s *Subscription) offer(ev Event) {
	if ev.ProjectRoot != "" && ev.ProjectRoot != s.root {
		return
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.pending[ev.Type] = struct{}{}
	s.mu.Unlock()
	select {
	case s.notify <- struct{}{}:
	default: // a wake-up is already queued; the reader will drain everything
	}
}

// C is the wake-up channel: it receives a value whenever new events are pending.
func (s *Subscription) C() <-chan struct{} { return s.notify }

// Drain returns and clears the currently-pending event types (nil if none).
func (s *Subscription) Drain() []Type {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.pending) == 0 {
		return nil
	}
	out := make([]Type, 0, len(s.pending))
	for t := range s.pending {
		out = append(out, t)
	}
	clear(s.pending)
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
