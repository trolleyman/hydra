package http

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/gorilla/websocket"
	"github.com/trolleyman/hydra/internal/heads"
	"github.com/trolleyman/hydra/internal/paths"
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

	// If the agent is still building (no container ID yet), stream the build log if it exists.
	if head.ContainerID == "" {
		buildLogPath := paths.GetBuildLogFromProjectRoot(projectRoot, agentID)
		if _, err := os.Stat(buildLogPath); err == nil {
			conn, err := wsUpgrader.Upgrade(w, r, nil)
			if err != nil {
				log.Printf("terminal ws: upgrade (build log): %v", err)
				return
			}
			defer conn.Close()
			s.streamBuildLog(r.Context(), conn, projectRoot, agentID, buildLogPath)
			return
		}

		log.Printf("terminal ws: container ID is empty for agent %q and no build log found", agentID)
		http.Error(w, "agent container not started", http.StatusAccepted)
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

func (s *Server) streamBuildLog(ctx context.Context, conn *websocket.Conn, projectRoot, agentID, logPath string) {
	_ = conn.WriteMessage(websocket.BinaryMessage, []byte("\x1b[32mAgent is building. Showing build logs...\x1b[0m\r\n\r\n"))

	f, err := os.Open(logPath)
	if err != nil {
		_ = conn.WriteMessage(websocket.BinaryMessage, []byte("error: failed to open build log: "+err.Error()))
		return
	}
	defer f.Close()

	lastCheck := time.Now()

	// Simple tail: read current content, then poll for more.
	for {
		select {
		case <-ctx.Done():
			return
		default:
			buf := make([]byte, 4096)
			n, err := f.Read(buf)
			if n > 0 {
				// Convert newlines to \r\n for the terminal (Xterm.js expects \r\n)
				data := strings.ReplaceAll(string(buf[:n]), "\n", "\r\n")
				_ = conn.WriteMessage(websocket.BinaryMessage, []byte(data))
			}
			if err == io.EOF {
				// Periodically check if build finished
				if time.Since(lastCheck) > 1*time.Second {
					lastCheck = time.Now()
					head, _ := heads.GetHeadByID(ctx, s.DockerClient, s.DB, projectRoot, agentID)
					if head != nil && head.ContainerID != "" {
						_ = conn.WriteMessage(websocket.BinaryMessage, []byte("\r\n\x1b[32mBuild finished. Terminal will now switch to the agent.\x1b[0m\r\n"))
						// We could potentially try to transition here, but for now just exit and let the user refresh
						// OR we can tell the frontend to reconnect?
						// For now, let's just exit and let the frontend notice the closure.
						time.Sleep(1 * time.Second)
						return
					}
				}
				time.Sleep(200 * time.Millisecond)
				continue
			}
			if err != nil {
				return
			}
		}
	}
}
