package http

import (
	"net/http"
	"time"

	"github.com/gorilla/websocket"
	"github.com/trolleyman/hydra/internal/api"
)

// SimulationServer implements api.ServerInterface with mock data.
type SimulationServer struct {
	StartTime time.Time
}

func (s *SimulationServer) CheckHealth(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	w.Write([]byte("OK"))
}

func (s *SimulationServer) GetStatus(w http.ResponseWriter, r *http.Request) {
	status := "OK"
	v := "0.1.0-sim"
	uptime := float32(time.Since(s.StartTime).Seconds())
	projectRoot := "/simulated/project"
	defaultProjectID := "sim-project"
	development := true
	terminalBashEnabled := true

	api.WriteJSON(w, http.StatusOK, api.StatusResponse{
		Status:           &status,
		Version:          &v,
		UptimeSeconds:    &uptime,
		ProjectRoot:      &projectRoot,
		DefaultProjectId: &defaultProjectID,
		Development:      &development,
		Features: &struct {
			TerminalBash *bool `json:"terminal_bash,omitempty"`
		}{
			TerminalBash: &terminalBashEnabled,
		},
	})
}

func (s *SimulationServer) ListProjects(w http.ResponseWriter, r *http.Request) {
	resp := api.ListProjects200JSONResponse{
		{
			Id:   "sim-project",
			Path: "/simulated/project",
			Name: "simulated-project",
			Uuid: "sim-uuid-1",
		},
	}
	api.WriteJSON(w, http.StatusOK, resp)
}

func (s *SimulationServer) AddProject(w http.ResponseWriter, r *http.Request) {
	api.WriteError(w, http.StatusNotImplemented, "Not implemented in simulation mode")
}

func (s *SimulationServer) ListAgents(w http.ResponseWriter, r *http.Request, projectId string) {
	createdAt1 := time.Now().Add(-1 * time.Hour).Unix()
	createdAt2 := time.Now().Add(-2 * time.Hour).Unix()

	running := api.Running
	waiting := api.Waiting

	resp := api.ListAgents200JSONResponse{
		{
			Id:              "agent-1",
			AgentType:       "claude",
			BaseBranch:      "main",
			BranchName:      ptr("hydra/feat-1"),
			ContainerId:     "sim-cont-1",
			ContainerStatus: "running",
			CreatedAt:       &createdAt1,
			AgentStatus: &api.AgentStatusInfo{
				Status:    running,
				Timestamp: time.Now().Format(time.RFC3339),
			},
		},
		{
			Id:              "agent-2",
			AgentType:       "gemini",
			BaseBranch:      "main",
			BranchName:      ptr("hydra/feat-2"),
			ContainerId:     "sim-cont-2",
			ContainerStatus: "running",
			CreatedAt:       &createdAt2,
			AgentStatus: &api.AgentStatusInfo{
				Status:    waiting,
				Timestamp: time.Now().Format(time.RFC3339),
			},
		},
	}
	api.WriteJSON(w, http.StatusOK, resp)
}

func (s *SimulationServer) GetAgent(w http.ResponseWriter, r *http.Request, projectId string, id string) {
	if id == "agent-1" {
		createdAt := time.Now().Add(-1 * time.Hour).Unix()
		api.WriteJSON(w, http.StatusOK, api.AgentResponse{
			Id:              "agent-1",
			AgentType:       "claude",
			BaseBranch:      "main",
			BranchName:      ptr("hydra/feat-1"),
			ContainerId:     "sim-cont-1",
			ContainerStatus: "running",
			CreatedAt:       &createdAt,
			AgentStatus: &api.AgentStatusInfo{
				Status:    api.Running,
				Timestamp: time.Now().Format(time.RFC3339),
			},
		})
		return
	}
	api.WriteError(w, http.StatusNotFound, "Agent not found")
}

func (s *SimulationServer) SpawnAgent(w http.ResponseWriter, r *http.Request, projectId string) {
	api.WriteError(w, http.StatusNotImplemented, "Not implemented in simulation mode")
}

func (s *SimulationServer) KillAgent(w http.ResponseWriter, r *http.Request, projectId string, id string) {
	w.WriteHeader(http.StatusNoContent)
}

func (s *SimulationServer) RestartAgent(w http.ResponseWriter, r *http.Request, projectId string, id string) {
	api.WriteError(w, http.StatusNotImplemented, "Not implemented in simulation mode")
}

func (s *SimulationServer) MergeAgent(w http.ResponseWriter, r *http.Request, projectId string, id string) {
	w.WriteHeader(http.StatusNoContent)
}

func (s *SimulationServer) UpdateAgentFromBase(w http.ResponseWriter, r *http.Request, projectId string, id string) {
	w.WriteHeader(http.StatusNoContent)
}

func (s *SimulationServer) GetAgentCommits(w http.ResponseWriter, r *http.Request, projectId string, id string) {
	if id == "agent-1" {
		resp := api.GetAgentCommits200JSONResponse{
			{
				Sha:         "abcd1234efgh5678ijkl9012mnop3456qrst7890",
				ShortSha:    "abcd123",
				Subject:     ptr("Add feature X"),
				Message:     "Add feature X\n\nMore details about feature X",
				AuthorName:  "Agent Claude",
				AuthorEmail: "claude@hydra.ai",
				Timestamp:   time.Now().Add(-10 * time.Minute).Format(time.RFC3339),
			},
			{
				Sha:         "bcde1234efgh5678ijkl9012mnop3456qrst7890",
				ShortSha:    "bcde123",
				Subject:     ptr("Fix bug Y"),
				Message:     "Fix bug Y",
				AuthorName:  "Agent Claude",
				AuthorEmail: "claude@hydra.ai",
				Timestamp:   time.Now().Add(-20 * time.Minute).Format(time.RFC3339),
			},
			{
				Sha:         "cdef1234efgh5678ijkl9012mnop3456qrst7890",
				ShortSha:    "cdef123",
				Subject:     ptr("Refactor Z"),
				Message:     "Refactor Z",
				AuthorName:  "Agent Claude",
				AuthorEmail: "claude@hydra.ai",
				Timestamp:   time.Now().Add(-30 * time.Minute).Format(time.RFC3339),
			},
			{
				Sha:         "defg1234efgh5678ijkl9012mnop3456qrst7890",
				ShortSha:    "defg123",
				Subject:     ptr("Initial work for feature X"),
				Message:     "Initial work for feature X",
				AuthorName:  "Agent Claude",
				AuthorEmail: "claude@hydra.ai",
				Timestamp:   time.Now().Add(-40 * time.Minute).Format(time.RFC3339),
			},
		}
		api.WriteJSON(w, http.StatusOK, resp)
		return
	}
	api.WriteJSON(w, http.StatusOK, api.GetAgentCommits200JSONResponse{})
}

func (s *SimulationServer) GetAgentDiff(w http.ResponseWriter, r *http.Request, projectId string, id string, params api.GetAgentDiffParams) {
	if id == "agent-2" {
		// Mock uncommitted changes
		uncommitted := true
		resp := api.DiffResponse{
			BaseRef:            "main",
			HeadRef:            "hydra/feat-2",
			UncommittedChanges: &uncommitted,
			UncommittedSummary: &api.UncommittedSummary{
				TrackedCount:   2,
				UntrackedCount: 1,
			},
			Files: []api.DiffFile{
				{
					Path:       "README.md",
					ChangeType: api.Modified,
					Additions:  2,
					Deletions:  1,
					Hunks: []api.DiffHunk{
						{
							Header:   "@@ -1,3 +1,4 @@",
							OldStart: 1,
							NewStart: 1,
							Lines: []api.DiffLine{
								{Type: api.Context, Content: "# Hydra", OldLineNum: ptr(1), NewLineNum: ptr(1)},
								{Type: api.Deletion, Content: "Old description", OldLineNum: ptr(2)},
								{Type: api.Addition, Content: "New improved description", NewLineNum: ptr(2)},
								{Type: api.Addition, Content: "With more info", NewLineNum: ptr(3)},
								{Type: api.Context, Content: "", OldLineNum: ptr(3), NewLineNum: ptr(4)},
							},
						},
					},
				},
				{
					Path:       "new_file.txt",
					ChangeType: api.Added,
					Additions:  1,
					Deletions:  0,
					Hunks: []api.DiffHunk{
						{
							Header:   "@@ -0,0 +1 @@",
							OldStart: 0,
							NewStart: 1,
							Lines: []api.DiffLine{
								{Type: api.Addition, Content: "Hello world", NewLineNum: ptr(1)},
							},
						},
					},
				},
			},
		}
		api.WriteJSON(w, http.StatusOK, resp)
		return
	}

	if id == "agent-1" {
		// Mock 4 commits diff
		resp := api.DiffResponse{
			BaseRef: "main",
			HeadRef: "hydra/feat-1",
			Files: []api.DiffFile{
				{
					Path:       "src/main.go",
					ChangeType: api.Modified,
					Additions:  10,
					Deletions:  5,
					Hunks: []api.DiffHunk{
						{
							Header:   "@@ -10,10 +10,15 @@",
							OldStart: 10,
							NewStart: 10,
							Lines: []api.DiffLine{
								{Type: api.Context, Content: "func main() {", OldLineNum: ptr(10), NewLineNum: ptr(10)},
								{Type: api.Deletion, Content: "\tfmt.Println(\"Hello\")", OldLineNum: ptr(11)},
								{Type: api.Addition, Content: "\tlog.Println(\"Starting...\")", NewLineNum: ptr(11)},
								{Type: api.Addition, Content: "\tfmt.Println(\"Hydra Simulation\")", NewLineNum: ptr(12)},
								{Type: api.Context, Content: "\t// ...", OldLineNum: ptr(12), NewLineNum: ptr(13)},
							},
						},
					},
				},
				{
					Path:       "docs/guide.md",
					ChangeType: api.Added,
					Additions:  100,
					Deletions:  0,
					Hunks: []api.DiffHunk{
						{
							Header:   "@@ -0,0 +1,100 @@",
							OldStart: 0,
							NewStart: 1,
							Lines: []api.DiffLine{
								{Type: api.Addition, Content: "# Guide", NewLineNum: ptr(1)},
								{Type: api.Addition, Content: "", NewLineNum: ptr(2)},
								{Type: api.Addition, Content: "Welcome to Hydra.", NewLineNum: ptr(3)},
							},
						},
					},
				},
				{
					Path:       "internal/old_file.go",
					ChangeType: api.Deleted,
					Additions:  0,
					Deletions:  50,
					Hunks: []api.DiffHunk{
						{
							Header:   "@@ -1,50 +0,0 @@",
							OldStart: 1,
							NewStart: 0,
							Lines: []api.DiffLine{
								{Type: api.Deletion, Content: "package internal", OldLineNum: ptr(1)},
							},
						},
					},
				},
				{
					Path:       "web/src/App.tsx",
					ChangeType: api.Modified,
					Additions:  5,
					Deletions:  5,
					Hunks: []api.DiffHunk{
						{
							Header:   "@@ -20,10 +20,10 @@",
							OldStart: 20,
							NewStart: 20,
							Lines: []api.DiffLine{
								{Type: api.Context, Content: "  return (", OldLineNum: ptr(20), NewLineNum: ptr(20)},
								{Type: api.Deletion, Content: "    <div>Original</div>", OldLineNum: ptr(21)},
								{Type: api.Addition, Content: "    <div>Simulated</div>", NewLineNum: ptr(21)},
								{Type: api.Context, Content: "    <p>", OldLineNum: ptr(22), NewLineNum: ptr(22)},
								{Type: api.Addition, Content: "      Indented with spaces", NewLineNum: ptr(23)},
								{Type: api.Deletion, Content: "\tIndented with tabs", OldLineNum: ptr(23)},
							},
						},
					},
				},
				{
					Path:       "new_folder/subfile.go",
					ChangeType: api.Added,
					Additions:  5,
					Deletions:  0,
					Hunks: []api.DiffHunk{
						{
							Header:   "@@ -0,0 +1,5 @@",
							OldStart: 0,
							NewStart: 1,
							Lines: []api.DiffLine{
								{Type: api.Addition, Content: "package new_folder", NewLineNum: ptr(1)},
							},
						},
					},
				},
			},
		}
		api.WriteJSON(w, http.StatusOK, resp)
		return
	}

	api.WriteJSON(w, http.StatusOK, api.DiffResponse{Files: []api.DiffFile{}})
}

func (s *SimulationServer) GetAgentDiffFiles(w http.ResponseWriter, r *http.Request, projectId string, id string, params api.GetAgentDiffFilesParams) {
	if id == "agent-1" {
		resp := api.DiffResponse{
			Files: []api.DiffFile{
				{Path: "src/main.go", ChangeType: api.Modified, Additions: 10, Deletions: 5},
				{Path: "docs/guide.md", ChangeType: api.Added, Additions: 100, Deletions: 0},
				{Path: "internal/old_file.go", ChangeType: api.Deleted, Additions: 0, Deletions: 50},
				{Path: "web/src/App.tsx", ChangeType: api.Modified, Additions: 5, Deletions: 5},
			},
		}
		api.WriteJSON(w, http.StatusOK, resp)
		return
	}
	api.WriteJSON(w, http.StatusOK, api.DiffResponse{Files: []api.DiffFile{}})
}

func (s *SimulationServer) SendAgentInput(w http.ResponseWriter, r *http.Request, projectId string, id string) {
	w.WriteHeader(http.StatusOK)
}

func (s *SimulationServer) GetConfig(w http.ResponseWriter, r *http.Request, projectId string, params api.GetConfigParams) {
	resp := api.ConfigResponse{
		Defaults: api.AgentConfig{
			PrePrompt: ptr("Default pre-prompt"),
		},
		Agents: map[string]api.AgentConfig{
			"claude": {
				PrePrompt: ptr("Claude pre-prompt"),
			},
		},
	}
	api.WriteJSON(w, http.StatusOK, resp)
}

func (s *SimulationServer) SaveConfig(w http.ResponseWriter, r *http.Request, projectId string, params api.SaveConfigParams) {
	w.WriteHeader(http.StatusOK)
}

func (s *SimulationServer) DevRestart(w http.ResponseWriter, r *http.Request) {
	api.WriteError(w, http.StatusForbidden, "Not available in simulation mode")
}

func (s *SimulationServer) GetDevToolsConfig(w http.ResponseWriter, r *http.Request) {
	api.WriteError(w, http.StatusForbidden, "Not available in simulation mode")
}

// HandleTerminalWS handles WebSocket connections for simulated agent terminal access.
func (s *SimulationServer) HandleTerminalWS(w http.ResponseWriter, r *http.Request) {
	// Extract agent ID from path: /ws/projects/{project_id}/agents/{id}/terminal
	agentID := r.PathValue("id")

	rawConn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	conn := &safeConn{Conn: rawConn}
	defer conn.Close()

	// 1. Simulate Building
	sendStatusUpdate(conn, "building")
	_ = conn.WriteMessage(websocket.BinaryMessage, []byte("\x1b[32m[Simulation] Building agent "+agentID+"...\x1b[0m\r\n"))
	time.Sleep(1 * time.Second)
	_ = conn.WriteMessage(websocket.BinaryMessage, []byte("Step 1/3: Pulling base image...\r\n"))
	time.Sleep(1 * time.Second)
	_ = conn.WriteMessage(websocket.BinaryMessage, []byte("Step 2/3: Installing dependencies...\r\n"))
	time.Sleep(1 * time.Second)
	_ = conn.WriteMessage(websocket.BinaryMessage, []byte("Step 3/3: Finalizing...\r\n"))
	time.Sleep(500 * time.Millisecond)
	_ = conn.WriteMessage(websocket.BinaryMessage, []byte("\x1b[32mSuccessfully built simulated agent.\x1b[0m\r\n\r\n"))

	// 2. Transition to Running
	sendStatusUpdate(conn, "running")
	_ = conn.WriteMessage(websocket.BinaryMessage, []byte("agent@hydra-sim:~$ \x1b[?25h"))

	// 3. Simulate interactive session (echo what user types)
	for {
		msgType, data, err := conn.ReadMessage()
		if err != nil {
			break
		}
		if msgType == websocket.BinaryMessage {
			// Echo back with a slight modification to show it's a simulation
			if string(data) == "\r" {
				_ = conn.WriteMessage(websocket.BinaryMessage, []byte("\r\nagent@hydra-sim:~$ "))
			} else {
				_ = conn.WriteMessage(websocket.BinaryMessage, data)
			}
		}
	}
}

func ptr[T any](v T) *T {
	return &v
}
