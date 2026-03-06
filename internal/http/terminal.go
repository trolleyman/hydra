package http

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"

	"github.com/docker/docker/api/types/container"
	"github.com/gorilla/websocket"
	"github.com/trolleyman/hydra/internal/heads"
)

var wsUpgrader = websocket.Upgrader{
	CheckOrigin:     func(r *http.Request) bool { return true },
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
}

type termResizeMsg struct {
	Type string `json:"type"`
	Cols uint   `json:"cols"`
	Rows uint   `json:"rows"`
}

// HandleTerminalWS handles WebSocket connections for agent terminal access.
// URL pattern: /ws/agent/{id}/terminal?project_id=...
func (s *Server) HandleTerminalWS(w http.ResponseWriter, r *http.Request) {
	// Extract agent ID from path: /ws/agent/{id}/terminal
	path := strings.TrimPrefix(r.URL.Path, "/ws/agent/")
	path = strings.TrimSuffix(path, "/terminal")
	agentID := strings.Trim(path, "/")
	if agentID == "" {
		http.Error(w, "agent ID required", http.StatusBadRequest)
		return
	}

	projectID := r.URL.Query().Get("project_id")
	projectRoot := s.resolveProjectRoot(&projectID)

	head, err := heads.GetHeadByID(r.Context(), s.DockerClient, s.DB, projectRoot, agentID)
	if err != nil {
		log.Printf("terminal ws: get head %q: %v", agentID, err)
		http.Error(w, "failed to find agent", http.StatusInternalServerError)
		return
	}
	if head == nil {
		http.Error(w, "agent not found", http.StatusNotFound)
		return
	}

	conn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("terminal ws: upgrade: %v", err)
		return
	}
	defer conn.Close()

	ctx := r.Context()
	attach, err := s.DockerClient.ContainerAttach(ctx, head.ContainerID, container.AttachOptions{
		Stream: true,
		Stdin:  true,
		Stdout: true,
		Stderr: true,
	})
	if err != nil {
		log.Printf("terminal ws: attach container %q: %v", head.ContainerID, err)
		_ = conn.WriteMessage(websocket.TextMessage, []byte("error: "+err.Error()))
		return
	}
	defer attach.Close()

	// WebSocket → container stdin (reads from ws, writes to docker attach)
	go func() {
		sentRedraw := false
		for {
			msgType, data, err := conn.ReadMessage()
			if err != nil {
				return
			}
			switch msgType {
			case websocket.BinaryMessage:
				if _, err := attach.Conn.Write(data); err != nil {
					return
				}
			case websocket.TextMessage:
				var msg termResizeMsg
				if err := json.Unmarshal(data, &msg); err == nil && msg.Type == "resize" && msg.Cols > 0 && msg.Rows > 0 {
					_ = s.DockerClient.ContainerResize(ctx, head.ContainerID, container.ResizeOptions{
						Height: msg.Rows,
						Width:  msg.Cols,
					})
					// After the first resize (which sets correct terminal dimensions),
					// inject Ctrl+L to force the TUI to clear and fully redraw.
					// Without this, a newly connected terminal is blank because Claude/Gemini
					// only sends cursor-relative delta updates, not a full screen repaint.
					if !sentRedraw {
						sentRedraw = true
						_, _ = attach.Conn.Write([]byte{'\x0c'})
					}
				}
			}
		}
	}()

	// Container stdout → WebSocket
	buf := make([]byte, 32*1024)
	for {
		n, err := attach.Reader.Read(buf)
		if n > 0 {
			if writeErr := conn.WriteMessage(websocket.BinaryMessage, buf[:n]); writeErr != nil {
				break
			}
		}
		if err != nil {
			break
		}
	}

	if head.Ephemeral {
		log.Printf("terminal ws: killing ephemeral agent %s on disconnect", agentID)
		if err := heads.KillHead(context.Background(), s.DockerClient, s.DB, *head); err != nil {
			log.Printf("terminal ws: error killing ephemeral agent %s: %v", agentID, err)
		}
	}
}
