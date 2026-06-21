package http

import (
	"net/http"
	"time"

	"github.com/gorilla/websocket"
	"github.com/trolleyman/hydra/internal/events"
)

// eventMsg is the JSON frame sent to the client for one change signal. The client
// switches on Type and refetches the matching resource (PLAN #50).
type eventMsg struct {
	Type string `json:"type"`
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
			return conn.SetReadDeadline(time.Now().Add(pongWait))
		})
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}()

	writeType := func(t events.Type) error {
		_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
		return conn.WriteJSON(eventMsg{Type: string(t)})
	}

	// Initial nudge: refetch everything once on (re)connect.
	for _, t := range []events.Type{events.AgentsChanged, events.ProjectsChanged, events.ServicesChanged} {
		if err := writeType(t); err != nil {
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
			for _, t := range sub.Drain() {
				if err := writeType(t); err != nil {
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
