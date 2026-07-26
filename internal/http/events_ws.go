package http

import (
	"net/http"
	"time"

	"braces.dev/errtrace"
	"github.com/gorilla/websocket"
	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/events"
	"github.com/trolleyman/hydra/internal/heads"
)

// eventMsg is the JSON frame sent to the client for one change signal. The client
// switches on Type and refetches the matching resource (PLAN #50) - except the
// payload events, which carry the new value inline (keyed by agent_id) so the
// client patches the one row in place instead of refetching the agent list:
// agent_tests_changed carries tests; agent_status_changed carries the live status
// bundle (status + activity + last_message).
type eventMsg struct {
	Type    string           `json:"type"`
	AgentID string           `json:"agent_id,omitempty"`
	Tests   *api.TestSummary `json:"tests,omitempty"`
	// agent_status_changed payload fields.
	Status                 string `json:"status,omitempty"`
	Activity               string `json:"activity,omitempty"`
	LastMessage            string `json:"last_message,omitempty"`
	LastMessageIsSuggested bool   `json:"last_message_is_suggested,omitempty"`
}

// agentTestsPayload is the events.Event.Payload of an agent_tests_changed
// event, published by NotifyTestsProgress and framed here.
type agentTestsPayload struct {
	AgentID string
	Tests   *api.TestSummary
}

// HandleEventsWS streams change signals for one project to a web client, so the
// UI refetches on demand instead of polling on a timer. URL:
// /ws/projects/{project_id}/events
//
// The protocol is intentionally minimal: each frame is {"type": "..."} naming a
// resource that changed (agents_changed / projects_changed / services_changed);
// the client runs the corresponding fetch. On connect the server sends one of
// each so a fresh or reconnecting client (which may have missed changes while
// away) refetches everything once.
func (s *Server) HandleEventsWS(w http.ResponseWriter, r *http.Request) {
	projectID := r.PathValue("project_id")
	projectRoot, err := s.resolveProjectRoot(projectID)
	if err != nil {
		http.Error(w, "project not found", http.StatusNotFound)
		return
	}

	conn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return // Upgrade already wrote the error response.
	}
	defer conn.Close()

	sub := s.Events.Subscribe(projectRoot)
	defer sub.Close()

	// Reader goroutine: we expect no application messages, but reading is what
	// processes pongs and detects a dropped client. It closes done on exit.
	done := make(chan struct{})
	go func() {
		defer close(done)
		conn.SetReadLimit(512)
		_ = conn.SetReadDeadline(time.Now().Add(pongWait))
		conn.SetPongHandler(func(string) error {
			return errtrace.Wrap(conn.SetReadDeadline(time.Now().Add(pongWait)))
		})
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}()

	writeEvent := func(ev events.Event) error {
		msg := eventMsg{Type: string(ev.Type)}
		switch p := ev.Payload.(type) {
		case agentTestsPayload:
			msg.AgentID = p.AgentID
			msg.Tests = p.Tests
		case heads.AgentStatusPayload:
			msg.AgentID = p.AgentID
			msg.Status = p.Status
			msg.Activity = p.Activity
			msg.LastMessage = p.LastMessage
			msg.LastMessageIsSuggested = p.LastMessageIsSuggested
		}
		_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
		return errtrace.Wrap(conn.WriteJSON(msg))
	}

	// Initial nudge: refetch everything once on (re)connect. (No initial
	// agent_tests_changed - the agents refetch carries the summaries.)
	for _, t := range []events.Type{events.AgentsChanged, events.ProjectsChanged, events.ServicesChanged, events.PushStatusChanged} {
		if err := writeEvent(events.Event{Type: t}); err != nil {
			return
		}
	}

	ping := time.NewTicker(pingPeriod)
	defer ping.Stop()
	for {
		select {
		case <-done:
			return
		case <-r.Context().Done():
			return
		case <-sub.C():
			for _, ev := range sub.Drain() {
				if err := writeEvent(ev); err != nil {
					return
				}
			}
		case <-ping.C:
			_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(10*time.Second)); err != nil {
				return
			}
		}
	}
}
