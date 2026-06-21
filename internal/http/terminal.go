package http

import (
	"bufio"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"braces.dev/errtrace"
	"github.com/gorilla/websocket"
	"github.com/trolleyman/hydra/internal/git"
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

// terminalDiffRefreshEvent tells the diff viewer to re-fetch. HeadMoved
// distinguishes a new commit (HEAD moved) from a plain uncommitted edit: the
// client re-fetches the diff text on either, but only re-snapshots the
// per-commit artifacts (screenshots) when the commit actually changed, since
// those are memoized by commit SHA and regenerating them on every edit would
// be wasted work.
type terminalDiffRefreshEvent struct {
	terminalEvent
	HeadMoved bool `json:"head_moved"`
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

// sendDiffRefresh emits a diff_refresh event, flagging whether the worktree
// change was a new commit (headMoved) so the client knows to also regenerate
// the per-commit artifacts.
func sendDiffRefresh(conn *safeConn, headMoved bool) {
	msg := terminalDiffRefreshEvent{terminalEvent: terminalEvent{Type: "diff_refresh"}, HeadMoved: headMoved}
	data, _ := json.Marshal(msg)
	_ = conn.WriteMessage(websocket.TextMessage, data)
}

// HandleShellClose terminates a single web bash shell immediately, so closing a
// terminal tab kills its process now instead of waiting out the idle grace
// period (which only covers reloads / transient disconnects).
// URL pattern: POST /shells/projects/{project_id}/agents/{id}/close?shell_id=…&sandboxed=…
func (s *Server) HandleShellClose(w http.ResponseWriter, r *http.Request) {
	agentID := r.PathValue("id")
	if agentID == "" {
		http.Error(w, "agent ID required", http.StatusBadRequest)
		return
	}
	token := r.URL.Query().Get("shell_id")
	sandboxed := r.URL.Query().Get("sandboxed") != "false"
	log.Printf("shell close: agent=%q shell_id=%q sandboxed=%v", agentID, token, sandboxed)
	heads.KillShellSession(s.Sessions, agentID, sandboxed, token)
	w.WriteHeader(http.StatusNoContent)
}

// parseTermSize reads the client-seeded cols/rows query params, falling back to
// the supplied defaults (the project's last persisted geometry) for any value
// that's missing, unparseable, or out of a sane range (rows/cols are uint16, and
// an absurd size would only hurt). Order is (rows, cols) to match the rest of
// the session API.
func parseTermSize(r *http.Request, defRows, defCols uint16) (uint16, uint16) {
	parse := func(key string, def uint16) uint16 {
		v := r.URL.Query().Get(key)
		if v == "" {
			return def
		}
		n, err := strconv.Atoi(v)
		if err != nil || n <= 0 || n > 2000 {
			return def
		}
		return uint16(n)
	}
	return parse("rows", defRows), parse("cols", defCols)
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
	// Client-seeded initial PTY size. Used only when we have to start or resume a
	// session here, so a fresh/resumed agent renders at the right width straight
	// away instead of flashing the default and reflowing. Falls back to this
	// head's last persisted geometry (then the project fallback, then 80x24) when
	// absent or out of range. This never resizes an already-live PTY — that path
	// attaches with 0,0 and waits for the client's settled resize.
	defRows, defCols := heads.LoadResumeSize(s.DB, projectRoot, agentID)
	initRows, initCols := parseTermSize(r, defRows, defCols)
	log.Printf("terminal ws: resolved projectRoot: %q, useShell: %v", projectRoot, useShell)

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
		// shell_id identifies the terminal tab so each gets its own shell process
		// and a refresh reattaches to the same one.
		shellToken := r.URL.Query().Get("shell_id")
		shellID, err := heads.StartShellSession(s.Sessions, projectRoot, *head, initRows, initCols, sandboxed, shellToken)
		if err != nil {
			log.Printf("terminal ws: start shell session for %q: %v", agentID, err)
			_ = conn.WriteMessage(websocket.TextMessage, []byte("error: "+err.Error()))
			return
		}
		sessionID = shellID
	}

	resumed := false
	if !useShell && !s.Sessions.IsLive(head.ID) && head.Worktree != nil {
		// The agent's session isn't running (e.g. the daemon was restarted).
		// Resume it on demand so opening the page brings the agent back via its
		// own --resume, instead of showing "Agent is not running".
		log.Printf("terminal ws: resuming agent %q (no live session)", head.ID)
		sendStatusUpdate(conn, "starting")
		if err := heads.ResumeHead(s.Sessions, s.DB, projectRoot, *head, initRows, initCols); err != nil {
			log.Printf("terminal ws: resume agent %q failed: %v", head.ID, err)
		} else {
			resumed = true
		}
	}

	// Attach without imposing a size (0,0). The session already has a width —
	// either from its initial start or from the last client that sized it — and a
	// detached agent keeps producing output at that width. Passing a concrete size
	// here would resize the live PTY on every reconnect, and since the browser
	// opens this socket on a fresh mount (e.g. navigating back to an agent) before
	// its flex layout has settled, that size is frequently wrong — it would reflow
	// the agent narrow, baking narrow-wrapped lines into the scrollback ring that
	// then look broken when the user scrolls up. Instead we leave the PTY at its
	// current width and let the client send a single resize once its layout is
	// stable (see fitAndSend in AgentTerminal.tsx), which is a no-op when the width
	// is unchanged. This keeps detached agents and their history at a stable width.
	att, err := s.Sessions.Attach(sessionID, 0, 0)
	if err != nil {
		log.Printf("terminal ws: attach session %q: %v", sessionID, err)
		_ = conn.WriteMessage(websocket.BinaryMessage, []byte("\r\n\x1b[31mAgent is not running.\x1b[0m\r\n"))
		sendStatusUpdate(conn, "stopped")
		return
	}
	defer att.Close()

	// Initial status again just in case it changed between checks. A just-resumed
	// agent is idle waiting for the user (it restored its conversation but isn't
	// working), so report waiting rather than a misleading "running".
	if resumed {
		sendStatusUpdate(conn, "waiting")
	} else {
		sendStatusUpdate(conn, "running")
	}

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
					// Remember this size for this head so a later clientless resume
					// (daemon boot, TUI) seeds the PTY at the right width instead of
					// 80x24. The agent tab and the head's bash tabs share one panel, so
					// either keys the same head.
					heads.SaveResumeSize(s.DB, agentID, uint16(msg.Rows), uint16(msg.Cols))
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

	// Send diff_refresh events only when the worktree content actually changes.
	//
	// We poll a cheap content fingerprint of the worktree (git.WorktreeStateHash —
	// HEAD + porcelain status + tracked diff + untracked sizes) on a short timer and
	// emit only when it differs from what we last reported. A git command detected in
	// the agent's status log triggers an immediate re-check so commits/checkouts show
	// up faster than the poll interval. This replaces the previous unconditional
	// 20-second ticker (issue #35), which forced every attached client to re-fetch the
	// full diff on every idle tick — wasted work, and the trigger behind issue #34
	// (the re-fetch periodically reset the user's in-progress text selection).
	go func() {
		defer func() {
			if r := recover(); r != nil {
				log.Printf("terminal ws: panic in diff-refresh goroutine for agent %q: %v", agentID, r)
			}
		}()
		statusLogPath := paths.GetStatusLogFromProjectRoot(projectRoot, agentID)

		// Worktree path captured at attach time; nil if the head has no worktree
		// (e.g. host shell), in which case we never emit content-driven refreshes.
		var worktree string
		if head.Worktree != nil {
			worktree = *head.Worktree
		}

		// lastHash/lastHead start at the current state so attaching never fires a
		// spurious initial refresh — the client already fetched the diff on mount.
		var lastHash string
		var lastHead string
		if worktree != "" {
			if h, err := git.WorktreeStateHash(worktree); err == nil {
				lastHash = h
			}
			if c, err := git.ResolveRef(worktree, "HEAD"); err == nil {
				lastHead = c
			}
		}

		// checkAndEmit recomputes the worktree fingerprint and emits diff_refresh only
		// when it has changed since the last emit. Read-only git commands (status, log,
		// diff) and idle ticks therefore never trigger a client re-fetch. It also
		// reports, via the event's head_moved flag, whether HEAD advanced (a commit) so
		// the client re-snapshots the per-commit artifacts only then, not on every edit.
		checkAndEmit := func() {
			if worktree == "" {
				return
			}
			h, err := git.WorktreeStateHash(worktree)
			if err != nil || h == lastHash {
				return
			}
			lastHash = h
			headMoved := false
			if c, err := git.ResolveRef(worktree, "HEAD"); err == nil && c != lastHead {
				lastHead = c
				headMoved = true
			}
			sendDiffRefresh(conn, headMoved)
		}

		// checkHeadAndEmit is a cheap HEAD-only check (a single git rev-parse, no
		// `git diff HEAD`) so a new commit surfaces within ~1s without paying the
		// full worktree-hash cost on every tick. When HEAD moves it falls through to
		// checkAndEmit, which recomputes the full fingerprint and emits.
		checkHeadAndEmit := func() {
			if worktree == "" {
				return
			}
			c, err := git.ResolveRef(worktree, "HEAD")
			if err != nil || c == lastHead {
				return
			}
			checkAndEmit()
		}

		// Full worktree fingerprint poll (catches uncommitted edits) on a slow
		// timer; cheap HEAD-only poll (catches new commits) on a faster one. The
		// expensive full poll can be infrequent because agent-driven edits already
		// trigger an immediate re-check via the status-log git-command scan below.
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		headTicker := time.NewTicker(1 * time.Second)
		defer headTicker.Stop()

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
				checkAndEmit()
			case <-headTicker.C:
				checkHeadAndEmit()
			default:
				if scanner != nil && scanner.Scan() {
					if looksLikeGitCommand(scanner.Text()) {
						checkAndEmit()
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
