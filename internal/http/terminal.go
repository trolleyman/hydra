package http

import (
	"bufio"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"braces.dev/errtrace"
	"github.com/gorilla/websocket"
	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/heads"
	"github.com/trolleyman/hydra/internal/paths"
)

// checkOrigin allows WebSocket connections only from localhost origins.
// Requests with no Origin header (e.g. native clients) are also allowed.
func checkOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	host := u.Hostname()
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

var wsUpgrader = websocket.Upgrader{
	CheckOrigin:     checkOrigin,
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
}

const (
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

type safeConn struct {
	*websocket.Conn
	mu sync.Mutex
}

func (c *safeConn) WriteMessage(messageType int, data []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return errtrace.Wrap(c.Conn.WriteMessage(messageType, data))
}

func (c *safeConn) WriteControl(messageType int, data []byte, deadline time.Time) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return errtrace.Wrap(c.Conn.WriteControl(messageType, data, deadline))
}

func sendStatusUpdate(conn *safeConn, status string) {
	msg := terminalStatusEvent{
		terminalEvent: terminalEvent{Type: "status"},
		Status:        status,
	}
	data, _ := json.Marshal(msg)
	_ = conn.WriteMessage(websocket.TextMessage, data)
}

func sendTerminalEvent(conn *safeConn, eventType string) {
	msg := terminalEvent{Type: eventType}
	data, _ := json.Marshal(msg)
	_ = conn.WriteMessage(websocket.TextMessage, data)
}

// HandleTerminalWS handles WebSocket connections for agent terminal access.
// URL pattern: /ws/projects/{project_id}/agents/{id}/terminal
func (s *Server) HandleTerminalWS(w http.ResponseWriter, r *http.Request) {
	log.Printf("terminal ws: incoming request: %s", r.URL.Path)

	// Extract project ID and agent ID from path params.
	projectID := r.PathValue("project_id")
	agentID := r.PathValue("id")

	log.Printf("terminal ws: projectID: %q, agentID: %q from path %q", projectID, agentID, r.URL.Path)

	if agentID == "" {
		log.Printf("terminal ws: agent ID missing in path %q", r.URL.Path)
		http.Error(w, "agent ID required", http.StatusBadRequest)
		return
	}

	useShell := r.URL.Query().Get("shell") == "true"
	projectRoot, err := s.resolveProjectRoot(projectID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	log.Printf("terminal ws: resolved projectRoot: %q, useShell: %v", projectRoot, useShell)

	if useShell {
		cfg, err := config.Load(projectRoot)
		if err != nil || !cfg.Features.TerminalBash {
			log.Printf("terminal ws: bash shell disabled or config error: %v", err)
			http.Error(w, "bash shell is disabled", http.StatusForbidden)
			return
		}
	}

	head, err := heads.GetHeadByID(r.Context(), s.Sessions, s.DB, projectRoot, agentID)
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

	rawConn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("terminal ws: upgrade error for agent %q: %v", agentID, err)
		return
	}
	conn := &safeConn{Conn: rawConn}
	defer conn.Close()

	log.Printf("terminal ws: upgraded connection for agent %q", agentID)

	// Send initial status
	sendStatusUpdate(conn, head.SessionStatus)

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
		defer func() {
			if r := recover(); r != nil {
				log.Printf("terminal ws: panic in ping goroutine for agent %q: %v", agentID, r)
			}
		}()
		for range ticker.C {
			if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}()

	ctx := r.Context()

	// Resolve the session to attach to. The shell tab gets a transient sandboxed
	// bash session sharing the agent's worktree; otherwise we attach the agent.
	sessionID := head.ID
	if useShell {
		// Sandboxed unless the client explicitly opts into a regular host shell.
		sandboxed := r.URL.Query().Get("sandboxed") != "false"
		shellID, err := heads.StartShellSession(s.Sessions, projectRoot, *head, 24, 80, sandboxed)
		if err != nil {
			log.Printf("terminal ws: start shell session for %q: %v", agentID, err)
			_ = conn.WriteMessage(websocket.TextMessage, []byte("error: "+err.Error()))
			return
		}
		sessionID = shellID
	} else if !s.Sessions.IsLive(head.ID) && head.Worktree != nil {
		// The agent's session isn't running (e.g. the daemon was restarted).
		// Resume it on demand so opening the page brings the agent back via its
		// own --resume, instead of showing "Agent is not running".
		log.Printf("terminal ws: resuming agent %q (no live session)", head.ID)
		sendStatusUpdate(conn, "starting")
		if err := heads.ResumeHead(s.Sessions, s.DB, projectRoot, *head, 24, 80); err != nil {
			log.Printf("terminal ws: resume agent %q failed: %v", head.ID, err)
		}
	}

	att, err := s.Sessions.Attach(sessionID, 24, 80)
	if err != nil {
		log.Printf("terminal ws: attach session %q: %v", sessionID, err)
		_ = conn.WriteMessage(websocket.BinaryMessage, []byte("\r\n\x1b[31mAgent is not running.\x1b[0m\r\n"))
		sendStatusUpdate(conn, "stopped")
		return
	}
	defer att.Close()

	// Initial status again just in case it changed between checks
	sendStatusUpdate(conn, "running")

	done := make(chan struct{})

	// WebSocket → session stdin (and resize control messages)
	go func() {
		defer close(done)
		defer func() {
			if r := recover(); r != nil {
				log.Printf("terminal ws: panic in stdin goroutine for agent %q: %v", agentID, r)
			}
		}()
		for {
			msgType, data, err := conn.ReadMessage()
			if err != nil {
				return
			}
			switch msgType {
			case websocket.BinaryMessage:
				if err := s.Sessions.Write(sessionID, data); err != nil {
					return
				}
			case websocket.TextMessage:
				var msg termResizeMsg
				if err := json.Unmarshal(data, &msg); err == nil && msg.Type == "resize" && msg.Cols > 0 && msg.Rows > 0 {
					_ = s.Sessions.Resize(sessionID, uint16(msg.Rows), uint16(msg.Cols))
				}
			}
		}
	}()

	// Session output → WebSocket
	go func() {
		defer func() {
			if r := recover(); r != nil {
				log.Printf("terminal ws: panic in stdout goroutine for agent %q: %v", agentID, r)
			}
		}()
		defer func() {
			log.Printf("terminal ws: stdout goroutine exiting for agent %q", agentID)
			if !useShell {
				sendStatusUpdate(conn, "stopped")
			}
			_ = conn.Close() // Closing the WS will unblock the ReadMessage in the other goroutine
		}()

		for {
			select {
			case <-att.Done:
				return
			case data, ok := <-att.Output:
				if !ok {
					return
				}
				if writeErr := conn.WriteMessage(websocket.BinaryMessage, data); writeErr != nil {
					log.Printf("terminal ws: error writing to WS for %q: %v", agentID, writeErr)
					return
				}
			}
		}
	}()

	// Tail the status log and send diff_refresh events when git commands are detected,
	// and also on a 20-second periodic timer.
	go func() {
		defer func() {
			if r := recover(); r != nil {
				log.Printf("terminal ws: panic in diff-refresh goroutine for agent %q: %v", agentID, r)
			}
		}()
		statusLogPath := paths.GetStatusLogFromProjectRoot(projectRoot, agentID)
		ticker := time.NewTicker(20 * time.Second)
		defer ticker.Stop()

		var scanner *bufio.Scanner
		f, err := os.Open(statusLogPath)
		if err == nil {
			defer f.Close()
			// Seek to end so we only tail new entries.
			_, _ = f.Seek(0, io.SeekEnd)
			scanner = bufio.NewScanner(f)
			// Allow large lines (e.g. tool output containing large diffs)
			scanner.Buffer(make([]byte, 256*1024), 256*1024)
		}

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				sendTerminalEvent(conn, "diff_refresh")
			default:
				if scanner != nil && scanner.Scan() {
					if looksLikeGitCommand(scanner.Text()) {
						sendTerminalEvent(conn, "diff_refresh")
					}
				} else {
					time.Sleep(200 * time.Millisecond)
				}
			}
		}
	}()

	// Wait for connection to close or container to stop
	<-done
	log.Printf("terminal ws: handler finished for agent %q", agentID)
}

// looksLikeGitCommand returns true if the JSONL hook line contains a git command invocation.
// It handles both Claude (PostToolUse / Bash) and Gemini (postToolUse / bash) formats.
func looksLikeGitCommand(line string) bool {
	var entry struct {
		Hook map[string]interface{} `json:"hook"`
	}
	if err := json.Unmarshal([]byte(line), &entry); err != nil || entry.Hook == nil {
		return false
	}
	hook := entry.Hook

	// Check tool_name field (Claude: "Bash", Gemini: "bash", others: "shell", "run_command", etc.)
	toolName, _ := hook["tool_name"].(string)
	toolNameLower := strings.ToLower(toolName)
	isBashTool := toolNameLower == "bash" || toolNameLower == "shell" || toolNameLower == "run_command" || toolNameLower == "execute_command"
	if !isBashTool {
		return false
	}

	// Check tool_input.command for "git " prefix or substring
	if toolInput, ok := hook["tool_input"].(map[string]interface{}); ok {
		if cmd, ok := toolInput["command"].(string); ok {
			return strings.Contains(cmd, "git ") || strings.HasPrefix(strings.TrimSpace(cmd), "git")
		}
	}
	return false
}
