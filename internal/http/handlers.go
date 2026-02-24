package http

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	dockerclient "github.com/docker/docker/client"
	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/docker"
	"github.com/trolleyman/hydra/internal/heads"
	"github.com/trolleyman/hydra/internal/paths"
	"github.com/trolleyman/hydra/internal/projects"
)

const version = "0.1.0"

// Server implements StrictServerInterface.
type Server struct {
	WorktreesDir    string
	ProjectRoot     string
	DefaultProject  projects.ProjectInfo
	ProjectsManager *projects.Manager
	DockerClient    *dockerclient.Client
	StartTime       time.Time
}

// NewHandler creates a handler with routing matching the OpenAPI spec.
func NewHandler(s *Server) http.Handler {
	strict := api.NewStrictHandler(s, nil)
	return api.HandlerFromMux(strict, http.NewServeMux())
}

// resolveProjectRoot returns the project root for the given project_id query param.
// Falls back to the server's default project root when project_id is absent or unknown.
func (s *Server) resolveProjectRoot(projectID *string) string {
	if projectID == nil || *projectID == "" {
		return s.ProjectRoot
	}
	p := s.ProjectsManager.GetByID(*projectID)
	if p == nil {
		return s.ProjectRoot
	}
	return p.Path
}

// --- StrictServerInterface implementations ---

func (s *Server) CheckHealth(_ context.Context, _ api.CheckHealthRequestObject) (api.CheckHealthResponseObject, error) {
	return api.CheckHealth200TextResponse("OK"), nil
}

func (s *Server) ListProjects(_ context.Context, _ api.ListProjectsRequestObject) (api.ListProjectsResponseObject, error) {
	ps := s.ProjectsManager.ListProjects()
	resp := make(api.ListProjects200JSONResponse, len(ps))
	for i, p := range ps {
		resp[i] = api.ProjectInfo{
			Id:   p.ID,
			Path: p.Path,
			Name: p.Name,
		}
	}
	return resp, nil
}

func (s *Server) AddProject(_ context.Context, request api.AddProjectRequestObject) (api.AddProjectResponseObject, error) {
	if request.Body == nil || strings.TrimSpace(request.Body.Path) == "" {
		code := 400
		msg := "path is required"
		return api.AddProject400JSONResponse{Code: code, Error: msg}, nil
	}

	projectPath := strings.TrimSpace(request.Body.Path)

	// Validate it's a git repository.
	if _, err := paths.GetProjectRoot(projectPath); err != nil {
		code := 400
		msg := "path is not a git repository: " + err.Error()
		return api.AddProject400JSONResponse{Code: code, Error: msg}, nil
	}

	p, err := s.ProjectsManager.AddProject(projectPath)
	if err != nil {
		code := 500
		msg := err.Error()
		return api.AddProject500JSONResponse{Code: code, Error: msg}, nil
	}
	return api.AddProject201JSONResponse(api.ProjectInfo{
		Id:   p.ID,
		Path: p.Path,
		Name: p.Name,
	}), nil
}

func (s *Server) ListAgents(ctx context.Context, request api.ListAgentsRequestObject) (api.ListAgentsResponseObject, error) {
	projectRoot := s.resolveProjectRoot(request.Params.ProjectId)
	headList, err := heads.ListHeads(ctx, s.DockerClient, projectRoot)
	if err != nil {
		code := 500
		msg := err.Error()
		return api.ListAgents500JSONResponse{Code: code, Error: msg}, nil
	}
	resp := make(api.ListAgents200JSONResponse, len(headList))
	for i, h := range headList {
		resp[i] = api.AgentResponse{
			Id:              h.ID,
			BranchName:      h.Branch,
			WorktreePath:    h.Worktree,
			ProjectPath:     h.ProjectPath,
			ContainerId:     h.ContainerID,
			ContainerStatus: h.ContainerStatus,
			AgentType:       string(h.AgentType),
			PrePrompt:       h.PrePrompt,
			Prompt:          h.Prompt,
			BaseBranch:      h.BaseBranch,
			AgentStatus:     h.AgentStatus,
		}
	}
	return resp, nil
}

func (s *Server) GetStatus(_ context.Context, _ api.GetStatusRequestObject) (api.GetStatusResponseObject, error) {
	status := "OK"
	v := version
	uptime := float32(time.Since(s.StartTime).Seconds())
	projectRoot := s.ProjectRoot
	defaultProjectID := s.DefaultProject.ID
	return api.GetStatus200JSONResponse(api.StatusResponse{
		Status:           &status,
		Version:          &v,
		UptimeSeconds:    &uptime,
		ProjectRoot:      &projectRoot,
		DefaultProjectId: &defaultProjectID,
	}), nil
}

func (s *Server) SpawnAgent(ctx context.Context, request api.SpawnAgentRequestObject) (api.SpawnAgentResponseObject, error) {
	if request.Body == nil || strings.TrimSpace(request.Body.Prompt) == "" {
		code := 400
		msg := "prompt is required"
		return api.SpawnAgent400JSONResponse{Code: code, Error: msg}, nil
	}

	projectRoot := s.resolveProjectRoot(request.Params.ProjectId)

	agentType := docker.AgentTypeClaude
	if request.Body.AgentType != nil && *request.Body.AgentType != "" {
		agentType = docker.AgentType(*request.Body.AgentType)
	}
	if agentType != docker.AgentTypeClaude && agentType != docker.AgentTypeGemini {
		code := 400
		msg := "unknown agent_type; supported: claude, gemini"
		return api.SpawnAgent400JSONResponse{Code: code, Error: msg}, nil
	}

	cfg, err := config.Load(projectRoot)
	if err != nil {
		code := 500
		msg := err.Error()
		return api.SpawnAgent500JSONResponse{Code: code, Error: msg}, nil
	}
	prePrompt := config.DefaultPrePrompt
	if cfg.PrePrompt != nil {
		prePrompt = *cfg.PrePrompt
	}
	prompt := strings.TrimSpace(request.Body.Prompt)

	// Resolve Dockerfile path
	dockerfilePath := ""
	rel := cfg.GetDockerfileForAgent(projectRoot, string(agentType))
	if rel != "" {
		if filepath.IsAbs(rel) {
			dockerfilePath = rel
		} else {
			dockerfilePath = filepath.Join(projectRoot, rel)
		}
	}
	if dockerfilePath != "" {
		if _, readErr := os.ReadFile(dockerfilePath); readErr != nil {
			code := 500
			msg := "read dockerfile: " + readErr.Error()
			return api.SpawnAgent500JSONResponse{Code: code, Error: msg}, nil
		}
	}

	id := strings.TrimSpace(request.Body.Id)
	var baseBranch string
	if request.Body.BaseBranch != nil {
		baseBranch = strings.TrimSpace(*request.Body.BaseBranch)
	}

	head, err := heads.SpawnHead(ctx, s.DockerClient, projectRoot, heads.SpawnHeadOptions{
		ID:             id,
		PrePrompt:      prePrompt,
		Prompt:         prompt,
		AgentType:      agentType,
		BaseBranch:     baseBranch,
		DockerfilePath: dockerfilePath,
	})
	if err != nil {
		code := 500
		msg := err.Error()
		return api.SpawnAgent500JSONResponse{Code: code, Error: msg}, nil
	}
	return api.SpawnAgent201JSONResponse(api.AgentResponse{
		Id:              head.ID,
		BranchName:      head.Branch,
		WorktreePath:    head.Worktree,
		ProjectPath:     head.ProjectPath,
		ContainerId:     head.ContainerID,
		ContainerStatus: head.ContainerStatus,
		AgentType:       string(head.AgentType),
		Prompt:          head.Prompt,
		BaseBranch:      head.BaseBranch,
		AgentStatus:     head.AgentStatus,
	}), nil
}

func (s *Server) GetAgent(ctx context.Context, request api.GetAgentRequestObject) (api.GetAgentResponseObject, error) {
	projectRoot := s.resolveProjectRoot(request.Params.ProjectId)
	head, err := heads.GetHeadByID(ctx, s.DockerClient, projectRoot, request.Id)
	if err != nil {
		code := 500
		msg := err.Error()
		return api.GetAgent500JSONResponse{Code: code, Error: msg}, nil
	}
	if head == nil {
		code := 404
		msg := "agent not found"
		return api.GetAgent404JSONResponse{Code: code, Error: msg}, nil
	}
	return api.GetAgent200JSONResponse(api.AgentResponse{
		Id:              head.ID,
		BranchName:      head.Branch,
		WorktreePath:    head.Worktree,
		ProjectPath:     head.ProjectPath,
		ContainerId:     head.ContainerID,
		ContainerStatus: head.ContainerStatus,
		AgentType:       string(head.AgentType),
		PrePrompt:       head.PrePrompt,
		Prompt:          head.Prompt,
		BaseBranch:      head.BaseBranch,
		AgentStatus:     head.AgentStatus,
	}), nil
}

func (s *Server) KillAgent(ctx context.Context, request api.KillAgentRequestObject) (api.KillAgentResponseObject, error) {
	projectRoot := s.resolveProjectRoot(request.Params.ProjectId)
	head, err := heads.GetHeadByID(ctx, s.DockerClient, projectRoot, request.Id)
	if err != nil {
		code := 500
		msg := err.Error()
		return api.KillAgent500JSONResponse{Code: code, Error: msg}, nil
	}
	if head == nil {
		code := 404
		msg := "agent not found"
		return api.KillAgent404JSONResponse{Code: code, Error: msg}, nil
	}

	if err := heads.KillHead(ctx, s.DockerClient, *head); err != nil {
		code := 500
		msg := err.Error()
		return api.KillAgent500JSONResponse{Code: code, Error: msg}, nil
	}

	return api.KillAgent204Response{}, nil
}
