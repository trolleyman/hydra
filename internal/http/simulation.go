package http

import (
	"fmt"
	"net/http"
	"strings"
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
	ctx := simContext(params)
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
		resp.Files = expandDiffContext(resp.Files, ctx)
		api.WriteJSON(w, http.StatusOK, resp)
		return
	}

	if id == "agent-1" {
		resp := api.DiffResponse{
			BaseRef: "main",
			HeadRef: "hydra/feat-1",
			Files: []api.DiffFile{
				{
					Path:       "internal/heads/heads.go",
					ChangeType: api.Modified,
					Additions:  47,
					Deletions:  18,
					Hunks: []api.DiffHunk{
						{
							Header:   "@@ -1,12 +1,14 @@",
							OldStart: 1,
							NewStart: 1,
							Lines: []api.DiffLine{
								{Type: api.Context, Content: "package heads", OldLineNum: ptr(1), NewLineNum: ptr(1)},
								{Type: api.Context, Content: "", OldLineNum: ptr(2), NewLineNum: ptr(2)},
								{Type: api.Context, Content: "import (", OldLineNum: ptr(3), NewLineNum: ptr(3)},
								{Type: api.Context, Content: "\t\"context\"", OldLineNum: ptr(4), NewLineNum: ptr(4)},
								{Type: api.Addition, Content: "\t\"errors\"", NewLineNum: ptr(5)},
								{Type: api.Context, Content: "\t\"fmt\"", OldLineNum: ptr(5), NewLineNum: ptr(6)},
								{Type: api.Context, Content: "\t\"log\"", OldLineNum: ptr(6), NewLineNum: ptr(7)},
								{Type: api.Addition, Content: "\t\"sync\"", NewLineNum: ptr(8)},
								{Type: api.Context, Content: "\t\"time\"", OldLineNum: ptr(7), NewLineNum: ptr(9)},
								{Type: api.Context, Content: ")", OldLineNum: ptr(8), NewLineNum: ptr(10)},
							},
						},
						{
							Header:   "@@ -42,19 +44,31 @@ type Head struct {",
							OldStart: 42,
							NewStart: 44,
							Lines: []api.DiffLine{
								{Type: api.Context, Content: "// SpawnHead creates a new agent head.", OldLineNum: ptr(42), NewLineNum: ptr(44)},
								{Type: api.Deletion, Content: "func SpawnHead(ctx context.Context, opts SpawnOptions) (*Head, error) {", OldLineNum: ptr(43)},
								{Type: api.Addition, Content: "func SpawnHead(ctx context.Context, store *db.Store, opts SpawnOptions) (*Head, error) {", NewLineNum: ptr(45)},
								{Type: api.Context, Content: "\tif opts.ID == \"\" {", OldLineNum: ptr(44), NewLineNum: ptr(46)},
								{Type: api.Context, Content: "\t\topts.ID = generateID()", OldLineNum: ptr(45), NewLineNum: ptr(47)},
								{Type: api.Context, Content: "\t}", OldLineNum: ptr(46), NewLineNum: ptr(48)},
								{Type: api.Deletion, Content: "\tif err := validateOptions(opts); err != nil {", OldLineNum: ptr(47)},
								{Type: api.Deletion, Content: "\t\treturn nil, err", OldLineNum: ptr(48)},
								{Type: api.Addition, Content: "\tif err := validateOptions(opts); err != nil {", NewLineNum: ptr(49)},
								{Type: api.Addition, Content: "\t\treturn nil, fmt.Errorf(\"spawn %s: %w\", opts.ID, err)", NewLineNum: ptr(50)},
								{Type: api.Context, Content: "\t}", OldLineNum: ptr(49), NewLineNum: ptr(51)},
								{Type: api.Context, Content: "", OldLineNum: ptr(50), NewLineNum: ptr(52)},
								{Type: api.Addition, Content: "\tif store != nil {", NewLineNum: ptr(53)},
								{Type: api.Addition, Content: "\t\tif err := store.UpsertAgent(&db.Agent{ID: opts.ID, ContainerStatus: \"pending\"}); err != nil {", NewLineNum: ptr(54)},
								{Type: api.Addition, Content: "\t\t\treturn nil, fmt.Errorf(\"upsert agent: %w\", err)", NewLineNum: ptr(55)},
								{Type: api.Addition, Content: "\t\t}", NewLineNum: ptr(56)},
								{Type: api.Addition, Content: "\t}", NewLineNum: ptr(57)},
								{Type: api.Addition, Content: "", NewLineNum: ptr(58)},
								{Type: api.Context, Content: "\treturn spawnInternal(ctx, opts)", OldLineNum: ptr(51), NewLineNum: ptr(59)},
								{Type: api.Context, Content: "}", OldLineNum: ptr(52), NewLineNum: ptr(60)},
							},
						},
						{
							Header:   "@@ -98,22 +112,28 @@ func SpawnHead(ctx context.Context, opts SpawnOptions) (*Head, error) {",
							OldStart: 98,
							NewStart: 112,
							Lines: []api.DiffLine{
								{Type: api.Context, Content: "// KillHead stops and removes a head's container, worktree, and branch.", OldLineNum: ptr(98), NewLineNum: ptr(112)},
								{Type: api.Deletion, Content: "func KillHead(ctx context.Context, cli *dockerclient.Client, head Head) error {", OldLineNum: ptr(99)},
								{Type: api.Addition, Content: "func KillHead(ctx context.Context, cli *dockerclient.Client, store *db.Store, head Head) error {", NewLineNum: ptr(113)},
								{Type: api.Context, Content: "\tlog.Printf(\"heads: kill requested for agent %s\", head.ID)", OldLineNum: ptr(100), NewLineNum: ptr(114)},
								{Type: api.Deletion, Content: "\tcontainerRef := head.ContainerID", OldLineNum: ptr(101)},
								{Type: api.Addition, Content: "\tif store != nil {", NewLineNum: ptr(115)},
								{Type: api.Addition, Content: "\t\tok, err := store.TrySetHeadStatus(head.ID, \"idle\", \"killing\")", NewLineNum: ptr(116)},
								{Type: api.Addition, Content: "\t\tif err != nil {", NewLineNum: ptr(117)},
								{Type: api.Addition, Content: "\t\t\treturn errtrace.Wrap(err)", NewLineNum: ptr(118)},
								{Type: api.Addition, Content: "\t\t}", NewLineNum: ptr(119)},
								{Type: api.Addition, Content: "\t\tif !ok {", NewLineNum: ptr(120)},
								{Type: api.Addition, Content: "\t\t\treturn errtrace.Wrap(db.ErrOperationInProgress)", NewLineNum: ptr(121)},
								{Type: api.Addition, Content: "\t\t}", NewLineNum: ptr(122)},
								{Type: api.Addition, Content: "\t}", NewLineNum: ptr(123)},
								{Type: api.Addition, Content: "\tcontainerRef := head.ContainerID", NewLineNum: ptr(124)},
								{Type: api.Context, Content: "\tif containerRef == \"\" {", OldLineNum: ptr(102), NewLineNum: ptr(125)},
								{Type: api.Context, Content: "\t\tcontainerRef = \"hydra-agent-\" + head.ID", OldLineNum: ptr(103), NewLineNum: ptr(126)},
								{Type: api.Context, Content: "\t}", OldLineNum: ptr(104), NewLineNum: ptr(127)},
								{Type: api.Deletion, Content: "\treturn killInternal(ctx, cli, head, containerRef)", OldLineNum: ptr(105)},
								{Type: api.Addition, Content: "\treturn killInternal(ctx, cli, store, head, containerRef)", NewLineNum: ptr(128)},
								{Type: api.Context, Content: "}", OldLineNum: ptr(106), NewLineNum: ptr(129)},
							},
						},
					},
				},
				{
					Path:       "internal/http/simulation.go",
					ChangeType: api.Modified,
					Additions:  22,
					Deletions:  8,
					Hunks: []api.DiffHunk{
						{
							Header:   "@@ -61,14 +61,28 @@ func (s *SimulationServer) ListAgents(...) {",
							OldStart: 61,
							NewStart: 61,
							Lines: []api.DiffLine{
								{Type: api.Context, Content: "\trunning := api.Running", OldLineNum: ptr(61), NewLineNum: ptr(61)},
								{Type: api.Context, Content: "\twaiting := api.Waiting", OldLineNum: ptr(62), NewLineNum: ptr(62)},
								{Type: api.Addition, Content: "\tbuilding := api.Building", NewLineNum: ptr(63)},
								{Type: api.Addition, Content: "\tkilling := api.Killing", NewLineNum: ptr(64)},
								{Type: api.Context, Content: "", OldLineNum: ptr(63), NewLineNum: ptr(65)},
								{Type: api.Context, Content: "\tresp := api.ListAgents200JSONResponse{", OldLineNum: ptr(64), NewLineNum: ptr(66)},
								{Type: api.Deletion, Content: "\t\t{Id: \"agent-1\", AgentType: \"claude\", AgentStatus: &api.AgentStatusInfo{Status: running}},", OldLineNum: ptr(65)},
								{Type: api.Deletion, Content: "\t\t{Id: \"agent-2\", AgentType: \"gemini\", AgentStatus: &api.AgentStatusInfo{Status: waiting}},", OldLineNum: ptr(66)},
								{Type: api.Addition, Content: "\t\t{Id: \"agent-1\", AgentType: \"claude\", AgentStatus: &api.AgentStatusInfo{Status: running}},", NewLineNum: ptr(67)},
								{Type: api.Addition, Content: "\t\t{Id: \"agent-2\", AgentType: \"gemini\", AgentStatus: &api.AgentStatusInfo{Status: waiting}},", NewLineNum: ptr(68)},
								{Type: api.Addition, Content: "\t\t{Id: \"agent-3\", AgentType: \"claude\", AgentStatus: &api.AgentStatusInfo{Status: building}},", NewLineNum: ptr(69)},
								{Type: api.Addition, Content: "\t\t{Id: \"agent-4\", AgentType: \"gemini\", AgentStatus: &api.AgentStatusInfo{Status: killing}},", NewLineNum: ptr(70)},
								{Type: api.Context, Content: "\t}", OldLineNum: ptr(67), NewLineNum: ptr(71)},
							},
						},
					},
				},
				{
					Path:       "web/src/components/AgentDetail.tsx",
					ChangeType: api.Modified,
					Additions:  38,
					Deletions:  14,
					Hunks: []api.DiffHunk{
						{
							Header:   "@@ -1,8 +1,10 @@",
							OldStart: 1,
							NewStart: 1,
							Lines: []api.DiffLine{
								{Type: api.Context, Content: "import { useState, useEffect, useCallback } from 'react'", OldLineNum: ptr(1), NewLineNum: ptr(1)},
								{Type: api.Deletion, Content: "import { api } from '../stores/apiClient'", OldLineNum: ptr(2)},
								{Type: api.Addition, Content: "import { api, type RequestError } from '../stores/apiClient'", NewLineNum: ptr(2)},
								{Type: api.Context, Content: "import type { AgentResponse } from '../api'", OldLineNum: ptr(3), NewLineNum: ptr(3)},
								{Type: api.Addition, Content: "import { useAgentStore } from '../stores/agentStore'", NewLineNum: ptr(4)},
								{Type: api.Context, Content: "import { DiffViewer } from '../DiffViewer'", OldLineNum: ptr(4), NewLineNum: ptr(5)},
								{Type: api.Deletion, Content: "import { GitMerge, Trash2 } from 'lucide-react'", OldLineNum: ptr(5)},
								{Type: api.Addition, Content: "import { GitMerge, Trash2, RefreshCw, AlertCircle } from 'lucide-react'", NewLineNum: ptr(6)},
							},
						},
						{
							Header:   "@@ -44,18 +46,32 @@ export function AgentDetail({ agent, projectId }: Props) {",
							OldStart: 44,
							NewStart: 46,
							Lines: []api.DiffLine{
								{Type: api.Context, Content: "  const [killing, setKilling] = useState(false)", OldLineNum: ptr(44), NewLineNum: ptr(46)},
								{Type: api.Addition, Content: "  const [restarting, setRestarting] = useState(false)", NewLineNum: ptr(47)},
								{Type: api.Addition, Content: "  const [error, setError] = useState<string | null>(null)", NewLineNum: ptr(48)},
								{Type: api.Context, Content: "", OldLineNum: ptr(45), NewLineNum: ptr(49)},
								{Type: api.Deletion, Content: "  async function handleKill() {", OldLineNum: ptr(46)},
								{Type: api.Addition, Content: "  async function handleKill() {", NewLineNum: ptr(50)},
								{Type: api.Context, Content: "    setKilling(true)", OldLineNum: ptr(47), NewLineNum: ptr(51)},
								{Type: api.Deletion, Content: "    await api.killAgent(projectId, agent.id)", OldLineNum: ptr(48)},
								{Type: api.Deletion, Content: "    setKilling(false)", OldLineNum: ptr(49)},
								{Type: api.Addition, Content: "    setError(null)", NewLineNum: ptr(52)},
								{Type: api.Addition, Content: "    try {", NewLineNum: ptr(53)},
								{Type: api.Addition, Content: "      await api.killAgent(projectId, agent.id)", NewLineNum: ptr(54)},
								{Type: api.Addition, Content: "    } catch (e) {", NewLineNum: ptr(55)},
								{Type: api.Addition, Content: "      setError((e as RequestError).message ?? 'Kill failed')", NewLineNum: ptr(56)},
								{Type: api.Addition, Content: "    } finally {", NewLineNum: ptr(57)},
								{Type: api.Addition, Content: "      setKilling(false)", NewLineNum: ptr(58)},
								{Type: api.Addition, Content: "    }", NewLineNum: ptr(59)},
								{Type: api.Context, Content: "  }", OldLineNum: ptr(50), NewLineNum: ptr(60)},
								{Type: api.Context, Content: "", OldLineNum: ptr(51), NewLineNum: ptr(61)},
								{Type: api.Addition, Content: "  async function handleRestart() {", NewLineNum: ptr(62)},
								{Type: api.Addition, Content: "    setRestarting(true)", NewLineNum: ptr(63)},
								{Type: api.Addition, Content: "    setError(null)", NewLineNum: ptr(64)},
								{Type: api.Addition, Content: "    try {", NewLineNum: ptr(65)},
								{Type: api.Addition, Content: "      await api.restartAgent(projectId, agent.id)", NewLineNum: ptr(66)},
								{Type: api.Addition, Content: "    } catch (e) {", NewLineNum: ptr(67)},
								{Type: api.Addition, Content: "      setError((e as RequestError).message ?? 'Restart failed')", NewLineNum: ptr(68)},
								{Type: api.Addition, Content: "    } finally {", NewLineNum: ptr(69)},
								{Type: api.Addition, Content: "      setRestarting(false)", NewLineNum: ptr(70)},
								{Type: api.Addition, Content: "    }", NewLineNum: ptr(71)},
								{Type: api.Addition, Content: "  }", NewLineNum: ptr(72)},
							},
						},
						{
							Header:   "@@ -89,10 +103,14 @@ export function AgentDetail({ agent, projectId }: Props) {",
							OldStart: 89,
							NewStart: 103,
							Lines: []api.DiffLine{
								{Type: api.Context, Content: "  return (", OldLineNum: ptr(89), NewLineNum: ptr(103)},
								{Type: api.Context, Content: "    <div className=\"flex flex-col gap-4\">", OldLineNum: ptr(90), NewLineNum: ptr(104)},
								{Type: api.Addition, Content: "      {error && (", NewLineNum: ptr(105)},
								{Type: api.Addition, Content: "        <div className=\"flex items-center gap-2 text-red-400 text-sm\">", NewLineNum: ptr(106)},
								{Type: api.Addition, Content: "          <AlertCircle className=\"w-4 h-4\" />", NewLineNum: ptr(107)},
								{Type: api.Addition, Content: "          <span>{error}</span>", NewLineNum: ptr(108)},
								{Type: api.Addition, Content: "        </div>", NewLineNum: ptr(109)},
								{Type: api.Addition, Content: "      )}", NewLineNum: ptr(110)},
								{Type: api.Context, Content: "      <div className=\"flex gap-2\">", OldLineNum: ptr(91), NewLineNum: ptr(111)},
								{Type: api.Deletion, Content: "        <KillButton onClick={handleKill} loading={killing} />", OldLineNum: ptr(92)},
								{Type: api.Addition, Content: "        <KillButton onClick={handleKill} loading={killing} />", NewLineNum: ptr(112)},
								{Type: api.Addition, Content: "        <RestartButton onClick={handleRestart} loading={restarting} />", NewLineNum: ptr(113)},
								{Type: api.Context, Content: "      </div>", OldLineNum: ptr(93), NewLineNum: ptr(114)},
								{Type: api.Context, Content: "    </div>", OldLineNum: ptr(94), NewLineNum: ptr(115)},
							},
						},
					},
				},
				{
					Path:       "internal/db/queries.go",
					ChangeType: api.Modified,
					Additions:  29,
					Deletions:  4,
					Hunks: []api.DiffHunk{
						{
							Header:   "@@ -78,10 +78,35 @@ func (s *Store) SoftDeleteAgent(id string) error {",
							OldStart: 78,
							NewStart: 78,
							Lines: []api.DiffLine{
								{Type: api.Context, Content: "// TrySetHeadStatus atomically sets head_status from expected to next.", OldLineNum: ptr(78), NewLineNum: ptr(78)},
								{Type: api.Context, Content: "// Returns (true, nil) on success, (false, nil) if CAS failed.", OldLineNum: ptr(79), NewLineNum: ptr(79)},
								{Type: api.Deletion, Content: "func (s *Store) TrySetHeadStatus(id, from, to string) (bool, error) {", OldLineNum: ptr(80)},
								{Type: api.Deletion, Content: "\tres := s.db.Model(&Agent{}).Where(\"id = ? AND head_status = ?\", id, from).Update(\"head_status\", to)", OldLineNum: ptr(81)},
								{Type: api.Deletion, Content: "\treturn res.RowsAffected > 0, res.Error", OldLineNum: ptr(82)},
								{Type: api.Deletion, Content: "}", OldLineNum: ptr(83)},
								{Type: api.Addition, Content: "func (s *Store) TrySetHeadStatus(id, from, to string) (bool, error) {", NewLineNum: ptr(80)},
								{Type: api.Addition, Content: "\tvar affected int64", NewLineNum: ptr(81)},
								{Type: api.Addition, Content: "\terr := s.db.Transaction(func(tx *gorm.DB) error {", NewLineNum: ptr(82)},
								{Type: api.Addition, Content: "\t\tvar a Agent", NewLineNum: ptr(83)},
								{Type: api.Addition, Content: "\t\tif err := tx.First(&a, \"id = ?\", id).Error; err != nil {", NewLineNum: ptr(84)},
								{Type: api.Addition, Content: "\t\t\treturn err", NewLineNum: ptr(85)},
								{Type: api.Addition, Content: "\t\t}", NewLineNum: ptr(86)},
								{Type: api.Addition, Content: "\t\tif a.HeadStatus != from {", NewLineNum: ptr(87)},
								{Type: api.Addition, Content: "\t\t\treturn nil", NewLineNum: ptr(88)},
								{Type: api.Addition, Content: "\t\t}", NewLineNum: ptr(89)},
								{Type: api.Addition, Content: "\t\tres := tx.Model(&a).Update(\"head_status\", to)", NewLineNum: ptr(90)},
								{Type: api.Addition, Content: "\t\taffected = res.RowsAffected", NewLineNum: ptr(91)},
								{Type: api.Addition, Content: "\t\treturn res.Error", NewLineNum: ptr(92)},
								{Type: api.Addition, Content: "\t})", NewLineNum: ptr(93)},
								{Type: api.Addition, Content: "\tif err != nil {", NewLineNum: ptr(94)},
								{Type: api.Addition, Content: "\t\treturn false, errtrace.Wrap(err)", NewLineNum: ptr(95)},
								{Type: api.Addition, Content: "\t}", NewLineNum: ptr(96)},
								{Type: api.Addition, Content: "\treturn affected > 0, nil", NewLineNum: ptr(97)},
								{Type: api.Addition, Content: "}", NewLineNum: ptr(98)},
								{Type: api.Context, Content: "", OldLineNum: ptr(84), NewLineNum: ptr(99)},
								{Type: api.Addition, Content: "var ErrOperationInProgress = errors.New(\"operation already in progress\")", NewLineNum: ptr(100)},
								{Type: api.Context, Content: "", OldLineNum: ptr(85), NewLineNum: ptr(101)},
								{Type: api.Context, Content: "// ClearHeadStatus resets head_status back to idle.", OldLineNum: ptr(86), NewLineNum: ptr(102)},
							},
						},
					},
				},
				{
					Path:       "internal/http/server.go",
					ChangeType: api.Modified,
					Additions:  12,
					Deletions:  3,
					Hunks: []api.DiffHunk{
						{
							Header:   "@@ -134,9 +134,18 @@ func (s *Server) KillAgent(w http.ResponseWriter, r *http.Request, ...) {",
							OldStart: 134,
							NewStart: 134,
							Lines: []api.DiffLine{
								{Type: api.Context, Content: "\thead, err := heads.GetHeadByID(r.Context(), s.DockerClient, s.DB, projectRoot, id)", OldLineNum: ptr(134), NewLineNum: ptr(134)},
								{Type: api.Context, Content: "\tif err != nil || head == nil {", OldLineNum: ptr(135), NewLineNum: ptr(135)},
								{Type: api.Context, Content: "\t\tapi.WriteError(w, http.StatusNotFound, \"agent not found\")", OldLineNum: ptr(136), NewLineNum: ptr(136)},
								{Type: api.Context, Content: "\t\treturn", OldLineNum: ptr(137), NewLineNum: ptr(137)},
								{Type: api.Context, Content: "\t}", OldLineNum: ptr(138), NewLineNum: ptr(138)},
								{Type: api.Deletion, Content: "\tif err := heads.KillHead(r.Context(), s.DockerClient, *head); err != nil {", OldLineNum: ptr(139)},
								{Type: api.Deletion, Content: "\t\tapi.WriteError(w, http.StatusInternalServerError, err.Error())", OldLineNum: ptr(140)},
								{Type: api.Deletion, Content: "\t\treturn", OldLineNum: ptr(141)},
								{Type: api.Addition, Content: "\tif err := heads.KillHead(r.Context(), s.DockerClient, s.DB, *head); err != nil {", NewLineNum: ptr(139)},
								{Type: api.Addition, Content: "\t\tif errors.Is(err, db.ErrOperationInProgress) {", NewLineNum: ptr(140)},
								{Type: api.Addition, Content: "\t\t\tapi.WriteError(w, http.StatusConflict, \"kill already in progress\")", NewLineNum: ptr(141)},
								{Type: api.Addition, Content: "\t\t\treturn", NewLineNum: ptr(142)},
								{Type: api.Addition, Content: "\t\t}", NewLineNum: ptr(143)},
								{Type: api.Addition, Content: "\t\tapi.WriteError(w, http.StatusInternalServerError, err.Error())", NewLineNum: ptr(144)},
								{Type: api.Addition, Content: "\t\treturn", NewLineNum: ptr(145)},
								{Type: api.Context, Content: "\t}", OldLineNum: ptr(142), NewLineNum: ptr(146)},
								{Type: api.Context, Content: "\tw.WriteHeader(http.StatusNoContent)", OldLineNum: ptr(143), NewLineNum: ptr(147)},
								{Type: api.Context, Content: "}", OldLineNum: ptr(144), NewLineNum: ptr(148)},
							},
						},
					},
				},
				{
					Path:       "internal/db/model.go",
					ChangeType: api.Deleted,
					Additions:  0,
					Deletions:  42,
					Hunks: []api.DiffHunk{
						{
							Header:   "@@ -1,42 +0,0 @@",
							OldStart: 1,
							NewStart: 0,
							Lines: []api.DiffLine{
								{Type: api.Deletion, Content: "package db", OldLineNum: ptr(1)},
								{Type: api.Deletion, Content: "", OldLineNum: ptr(2)},
								{Type: api.Deletion, Content: "import \"time\"", OldLineNum: ptr(3)},
								{Type: api.Deletion, Content: "", OldLineNum: ptr(4)},
								{Type: api.Deletion, Content: "// Agent is the GORM model for a Hydra agent.", OldLineNum: ptr(5)},
								{Type: api.Deletion, Content: "type Agent struct {", OldLineNum: ptr(6)},
								{Type: api.Deletion, Content: "\tID              string    `gorm:\"primaryKey\"`", OldLineNum: ptr(7)},
								{Type: api.Deletion, Content: "\tProjectPath     string", OldLineNum: ptr(8)},
								{Type: api.Deletion, Content: "\tContainerID     string", OldLineNum: ptr(9)},
								{Type: api.Deletion, Content: "\tContainerName   string", OldLineNum: ptr(10)},
								{Type: api.Deletion, Content: "\tContainerStatus string", OldLineNum: ptr(11)},
								{Type: api.Deletion, Content: "\tAgentStatus     *string", OldLineNum: ptr(12)},
								{Type: api.Deletion, Content: "\tAgentStatusTime string", OldLineNum: ptr(13)},
								{Type: api.Deletion, Content: "\tHeadStatus      string    `gorm:\"default:idle\"`", OldLineNum: ptr(14)},
								{Type: api.Deletion, Content: "\tBranchName      string", OldLineNum: ptr(15)},
								{Type: api.Deletion, Content: "\tBaseBranch      string", OldLineNum: ptr(16)},
								{Type: api.Deletion, Content: "\tAgentType       string", OldLineNum: ptr(17)},
								{Type: api.Deletion, Content: "\tPrePrompt       string", OldLineNum: ptr(18)},
								{Type: api.Deletion, Content: "\tPrompt          string", OldLineNum: ptr(19)},
								{Type: api.Deletion, Content: "\tEphemeral       bool", OldLineNum: ptr(20)},
								{Type: api.Deletion, Content: "\tCreatedAt       time.Time", OldLineNum: ptr(21)},
								{Type: api.Deletion, Content: "\tDeletedAt       gorm.DeletedAt `gorm:\"index\"`", OldLineNum: ptr(22)},
								{Type: api.Deletion, Content: "}", OldLineNum: ptr(23)},
							},
						},
					},
				},
				{
					Path:       "internal/db/schema.go",
					ChangeType: api.Added,
					Additions:  58,
					Deletions:  0,
					Hunks: []api.DiffHunk{
						{
							Header:   "@@ -0,0 +1,58 @@",
							OldStart: 0,
							NewStart: 1,
							Lines: []api.DiffLine{
								{Type: api.Addition, Content: "package db", NewLineNum: ptr(1)},
								{Type: api.Addition, Content: "", NewLineNum: ptr(2)},
								{Type: api.Addition, Content: "import (", NewLineNum: ptr(3)},
								{Type: api.Addition, Content: "\t\"errors\"", NewLineNum: ptr(4)},
								{Type: api.Addition, Content: "\t\"time\"", NewLineNum: ptr(5)},
								{Type: api.Addition, Content: "", NewLineNum: ptr(6)},
								{Type: api.Addition, Content: "\t\"gorm.io/gorm\"", NewLineNum: ptr(7)},
								{Type: api.Addition, Content: ")", NewLineNum: ptr(8)},
								{Type: api.Addition, Content: "", NewLineNum: ptr(9)},
								{Type: api.Addition, Content: "// Agent is the GORM model for a Hydra agent.", NewLineNum: ptr(10)},
								{Type: api.Addition, Content: "type Agent struct {", NewLineNum: ptr(11)},
								{Type: api.Addition, Content: "\tID              string         `gorm:\"primaryKey\"`", NewLineNum: ptr(12)},
								{Type: api.Addition, Content: "\tProjectPath     string", NewLineNum: ptr(13)},
								{Type: api.Addition, Content: "\tContainerID     string", NewLineNum: ptr(14)},
								{Type: api.Addition, Content: "\tContainerName   string", NewLineNum: ptr(15)},
								{Type: api.Addition, Content: "\tContainerStatus string", NewLineNum: ptr(16)},
								{Type: api.Addition, Content: "\tAgentStatus     *string", NewLineNum: ptr(17)},
								{Type: api.Addition, Content: "\tAgentStatusTime string", NewLineNum: ptr(18)},
								{Type: api.Addition, Content: "\tHeadStatus      string         `gorm:\"default:idle\"`", NewLineNum: ptr(19)},
								{Type: api.Addition, Content: "\tBranchName      string", NewLineNum: ptr(20)},
								{Type: api.Addition, Content: "\tBaseBranch      string", NewLineNum: ptr(21)},
								{Type: api.Addition, Content: "\tAgentType       string", NewLineNum: ptr(22)},
								{Type: api.Addition, Content: "\tPrePrompt       string", NewLineNum: ptr(23)},
								{Type: api.Addition, Content: "\tPrompt          string", NewLineNum: ptr(24)},
								{Type: api.Addition, Content: "\tEphemeral       bool", NewLineNum: ptr(25)},
								{Type: api.Addition, Content: "\tCreatedAt       time.Time", NewLineNum: ptr(26)},
								{Type: api.Addition, Content: "\tDeletedAt       gorm.DeletedAt `gorm:\"index\"`", NewLineNum: ptr(27)},
								{Type: api.Addition, Content: "}", NewLineNum: ptr(28)},
								{Type: api.Addition, Content: "", NewLineNum: ptr(29)},
								{Type: api.Addition, Content: "// ErrOperationInProgress is returned when a CAS update fails.", NewLineNum: ptr(30)},
								{Type: api.Addition, Content: "var ErrOperationInProgress = errors.New(\"operation already in progress\")", NewLineNum: ptr(31)},
								{Type: api.Addition, Content: "", NewLineNum: ptr(32)},
								{Type: api.Addition, Content: "// Migrate runs auto-migration for all models.", NewLineNum: ptr(33)},
								{Type: api.Addition, Content: "func Migrate(db *gorm.DB) error {", NewLineNum: ptr(34)},
								{Type: api.Addition, Content: "\treturn db.AutoMigrate(&Agent{})", NewLineNum: ptr(35)},
								{Type: api.Addition, Content: "}", NewLineNum: ptr(36)},
							},
						},
					},
				},
			},
		}
		resp.Files = expandDiffContext(resp.Files, ctx)
		api.WriteJSON(w, http.StatusOK, resp)
		return
	}

	api.WriteJSON(w, http.StatusOK, api.DiffResponse{Files: []api.DiffFile{}})
}

func simContext(params api.GetAgentDiffParams) int {
	if params.Context != nil {
		return *params.Context
	}
	return 3
}

func (s *SimulationServer) GetAgentDiffFiles(w http.ResponseWriter, r *http.Request, projectId string, id string, params api.GetAgentDiffFilesParams) {
	if id == "agent-1" {
		resp := api.DiffResponse{
			Files: []api.DiffFile{
				{Path: "internal/heads/heads.go", ChangeType: api.Modified, Additions: 47, Deletions: 18},
				{Path: "internal/http/simulation.go", ChangeType: api.Modified, Additions: 22, Deletions: 8},
				{Path: "web/src/components/AgentDetail.tsx", ChangeType: api.Modified, Additions: 38, Deletions: 14},
				{Path: "internal/db/queries.go", ChangeType: api.Modified, Additions: 29, Deletions: 4},
				{Path: "internal/http/server.go", ChangeType: api.Modified, Additions: 12, Deletions: 3},
				{Path: "internal/db/model.go", ChangeType: api.Deleted, Additions: 0, Deletions: 42},
				{Path: "internal/db/schema.go", ChangeType: api.Added, Additions: 58, Deletions: 0},
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

// expandHunkContext adds extra context lines before/after a hunk's existing lines
// when the requested context is greater than the default 3.
func expandHunkContext(hunk api.DiffHunk, extraCtx int, fileExt string) api.DiffHunk {
	if extraCtx <= 0 {
		return hunk
	}

	comment := "//"
	if fileExt == "tsx" || fileExt == "ts" || fileExt == "js" || fileExt == "jsx" {
		comment = "//"
	}

	// Find the old/new line ranges in the hunk
	firstOld, firstNew := hunk.OldStart, hunk.NewStart
	lastOld, lastNew := firstOld, firstNew
	for _, l := range hunk.Lines {
		if l.OldLineNum != nil && *l.OldLineNum > lastOld {
			lastOld = *l.OldLineNum
		}
		if l.NewLineNum != nil && *l.NewLineNum > lastNew {
			lastNew = *l.NewLineNum
		}
	}

	// Prepend context lines before the hunk
	var prefix []api.DiffLine
	for i := extraCtx; i > 0; i-- {
		oldN := firstOld - i
		newN := firstNew - i
		if oldN < 1 || newN < 1 {
			continue
		}
		prefix = append(prefix, api.DiffLine{
			Type:       api.Context,
			Content:    comment + fmt.Sprintf(" context line %d", oldN),
			OldLineNum: ptr(oldN),
			NewLineNum: ptr(newN),
		})
	}

	// Append context lines after the hunk
	var suffix []api.DiffLine
	for i := 1; i <= extraCtx; i++ {
		oldN := lastOld + i
		newN := lastNew + i
		suffix = append(suffix, api.DiffLine{
			Type:       api.Context,
			Content:    comment + fmt.Sprintf(" context line %d", oldN),
			OldLineNum: ptr(oldN),
			NewLineNum: ptr(newN),
		})
	}

	newLines := append(prefix, hunk.Lines...)
	newLines = append(newLines, suffix...)
	hunk.Lines = newLines
	return hunk
}

func expandDiffContext(files []api.DiffFile, context int) []api.DiffFile {
	extra := context - 3
	if extra <= 0 {
		return files
	}
	result := make([]api.DiffFile, len(files))
	for i, f := range files {
		ext := ""
		parts := strings.Split(f.Path, ".")
		if len(parts) > 1 {
			ext = parts[len(parts)-1]
		}
		hunks := make([]api.DiffHunk, len(f.Hunks))
		for j, h := range f.Hunks {
			hunks[j] = expandHunkContext(h, extra, ext)
		}
		f.Hunks = hunks
		result[i] = f
	}
	return result
}

func ptr[T any](v T) *T {
	return &v
}
