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

const (
	// Time allowed to write a message to the peer.
	writeWait = 10 * time.Second

	// Time allowed to read the next pong message from the peer.
	pongWait = 60 * time.Second

	// Send pings to peer with this period. Must be less than pongWait.
	pingPeriod = (pongWait * 9) / 10
)

type termResizeMsg struct {
	Type string `json:"type"`
	Cols uint   `json:"cols"`
	Rows uint   `json:"rows"`
}

type terminalEvent struct {
	Type string `json:"type"`
}

type terminalStatusEvent struct {
	terminalEvent
	Status string `json:"status"`
}

func sendStatusUpdate(conn *websocket.Conn, status string) {
	msg := terminalStatusEvent{
		terminalEvent: terminalEvent{Type: "status"},
		Status:        status,
	}
	data, _ := json.Marshal(msg)
	_ = conn.WriteMessage(websocket.TextMessage, data)
}

func sendTerminalEvent(conn *websocket.Conn, eventType string) {
	msg := terminalEvent{Type: eventType}
	data, _ := json.Marshal(msg)
	_ = conn.WriteMessage(websocket.TextMessage, data)
}

// HandleTerminalWS handles WebSocket connections for agent terminal access.
// URL pattern: /ws/agent/{id}/terminal?project_id=...
func (s *Server) HandleTerminalWS(w http.ResponseWriter, r *http.Request) {
	log.Printf("terminal ws: incoming request: %s", r.URL.Path)

	// Extract agent ID from path: /ws/agent/{id}/terminal
	path := strings.TrimPrefix(r.URL.Path, "/ws/agent/")
	path = strings.TrimSuffix(path, "/terminal")
	agentID := strings.Trim(path, "/")

	log.Printf("terminal ws: extracted agentID: %q from path %q", agentID, r.URL.Path)

	if agentID == "" {
		log.Printf("terminal ws: agent ID missing in path %q", r.URL.Path)
		http.Error(w, "agent ID required", http.StatusBadRequest)
		return
	}

	projectID := r.URL.Query().Get("project_id")
	projectRoot := s.resolveProjectRoot(&projectID)
	log.Printf("terminal ws: resolved projectRoot: %q", projectRoot)

	head, err := heads.GetHeadByID(r.Context(), s.DockerClient, s.DB, projectRoot, agentID)
	if err != nil {
		log.Printf("terminal ws: error fetching head %q: %v", agentID, err)
		http.Error(w, "failed to find agent", http.StatusInternalServerError)
		return
	}
	if head == nil {
		log.Printf("terminal ws: agent %q not found in project %q", agentID, projectRoot)
		http.Error(w, "agent not found", http.StatusNotFound)
		return
	}

	log.Printf("terminal ws: found head: %s", head.ID)

	conn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("terminal ws: upgrade error for agent %q: %v", agentID, err)
		return
	}
	defer conn.Close()

	log.Printf("terminal ws: upgraded connection for agent %q", agentID)

	// Send initial status
	sendStatusUpdate(conn, head.ContainerStatus)

	// Configure heartbeat
	_ = conn.SetReadDeadline(time.Now().Add(pongWait))
	conn.SetPongHandler(func(string) error {
		_ = conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	// Start ping ticker
	ticker := time.NewTicker(pingPeriod)
	defer ticker.Stop()
	go func() {
		for range ticker.C {
			if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}()

	ctx := r.Context()

	// If the agent is still building (no container ID yet), stream the build log if it exists.
	if head.ContainerID == "" {
		buildLogPath := paths.GetBuildLogFromProjectRoot(projectRoot, agentID)
		log.Printf("terminal ws: container ID empty, checking build log at %s", buildLogPath)
		if _, err := os.Stat(buildLogPath); err == nil {
			log.Printf("terminal ws: streaming build log for agent %q", agentID)
			if !s.streamBuildLog(ctx, conn, projectRoot, agentID, buildLogPath) {
				log.Printf("terminal ws: stream build log interrupted for agent %q", agentID)
				return // Context cancelled or error
			}
			// Build finished! Refresh head info to get the new ContainerID.
			log.Printf("terminal ws: streamBuildLog finished, refreshing head for %q", agentID)
			head, err = heads.GetHeadByID(ctx, s.DockerClient, s.DB, projectRoot, agentID)
			if err != nil || head == nil || head.ContainerID == "" {
				log.Printf("terminal ws: build finished for %q but container still missing: err=%v, head=%+v", agentID, err, head)
				_ = conn.WriteMessage(websocket.BinaryMessage, []byte("\r\n\x1b[31mError: Build finished but container not found.\x1b[0m\r\n"))
				return
			}
			log.Printf("terminal ws: build finished for agent %q, container ID: %s", agentID, head.ContainerID[:12])
			// Explicitly send the new status
			sendStatusUpdate(conn, head.ContainerStatus)
		} else {
			log.Printf("terminal ws: container ID empty and NO build log found for agent %q", agentID)
			_ = conn.WriteMessage(websocket.BinaryMessage, []byte("Agent container not started and no build logs found.\r\n"))
			return
		}
	}

	log.Printf("terminal ws: attaching to container %s for agent %q", head.ContainerID[:12], agentID)
	// Now we (should) have a ContainerID.
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

	// Initial status again just in case it changed between checks
	sendStatusUpdate(conn, "running")

	done := make(chan struct{})

	// WebSocket → container stdin (reads from ws, writes to docker attach)
	go func() {
		defer close(done)
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
				}
			}
		}
	}()

	// Container stdout → WebSocket
	go func() {
		defer func() {
			log.Printf("terminal ws: stdout goroutine exiting for agent %q", agentID)
			sendStatusUpdate(conn, "stopped")
			_ = conn.Close() // Closing the WS will unblock the ReadMessage in the other goroutine
		}()

		buf := make([]byte, 32*1024)
		for {
			n, err := attach.Reader.Read(buf)
			if n > 0 {
				if writeErr := conn.WriteMessage(websocket.BinaryMessage, buf[:n]); writeErr != nil {
					log.Printf("terminal ws: error writing to WS for %q: %v", agentID, writeErr)
					break
				}
			}
			if err != nil {
				if err != io.EOF {
					log.Printf("terminal ws: error reading from container stdout for %q: %v", agentID, err)
				}
				break
			}
		}
		// When stdout ends (container stopped), closing attach.Conn will unblock stdin Write if it was pending
		_ = attach.Conn.Close()
	}()

	// Wait for connection to close or container to stop
	<-done
	log.Printf("terminal ws: handler finished for agent %q", agentID)
}

// streamBuildLog returns true if the build finished successfully and we should transition to attach.
func (s *Server) streamBuildLog(ctx context.Context, conn *websocket.Conn, projectRoot, agentID, logPath string) bool {
	_ = conn.WriteMessage(websocket.BinaryMessage, []byte("\x1b[32mBuilding agent...\x1b[0m\r\n\r\n"))
	sendStatusUpdate(conn, "building")

	f, err := os.Open(logPath)
	if err != nil {
		_ = conn.WriteMessage(websocket.BinaryMessage, []byte("error: failed to open build log: "+err.Error()))
		return false
	}
	defer f.Close()

	lastCheck := time.Now()

	// Simple tail: read current content, then poll for more.
	for {
		select {
		case <-ctx.Done():
			return false
		default:
			buf := make([]byte, 4096)
			n, err := f.Read(buf)
			if n > 0 {
				// Convert newlines to \r\n for the terminal (Xterm.js expects \r\n)
				// Replace any existing \r\n with \n first to avoid \r\r\n, then \n to \r\n
				s := strings.ReplaceAll(string(buf[:n]), "\r\n", "\n")
				data := strings.ReplaceAll(s, "\n", "\r\n")
				_ = conn.WriteMessage(websocket.BinaryMessage, []byte(data))
			}
			if err == io.EOF {
				// Periodically check if build finished
				if time.Since(lastCheck) > 1*time.Second {
					lastCheck = time.Now()
					head, _ := heads.GetHeadByID(ctx, s.DockerClient, s.DB, projectRoot, agentID)
					if head != nil && head.ContainerID != "" {
						log.Printf("streamBuildLog: build finished for %q, container: %s", agentID, head.ContainerID[:12])
						sendTerminalEvent(conn, "build_finished")
						// Small delay to let the frontend see the message
						time.Sleep(100 * time.Millisecond)
						return true
					}
					if head != nil && head.ContainerStatus == "stopped" {
						log.Printf("streamBuildLog: build failed for %q", agentID)
						return false
					}
				}
				time.Sleep(200 * time.Millisecond)
				continue
			}
			if err != nil {
				return false
			}
		}
	}
}
