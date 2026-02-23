package api

import (
	"context"
	"net/http"
	"strings"
	"time"

	dockerclient "github.com/docker/docker/client"
	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/docker"
	"github.com/trolleyman/hydra/internal/heads"
)

const version = "0.1.0"

// Server implements StrictServerInterface.
type Server struct {
	WorktreesDir string
	ProjectRoot  string
	DockerClient *dockerclient.Client
	StartTime    time.Time
}

// NewHandler creates a handler with routing matching the OpenAPI spec.
func NewHandler(s *Server) http.Handler {
	strict := NewStrictHandler(s, nil)
	return HandlerFromMux(strict, http.NewServeMux())
}

// toAPIClaudeStatus converts a heads.ClaudeStatus to its API representation.
func toAPIClaudeStatus(s *heads.ClaudeStatus) *ClaudeStatusInfo {
	if s == nil {
		return nil
	}
	info := &ClaudeStatusInfo{
		Status:    s.Status,
		Event:     s.Event,
		Timestamp: s.Timestamp,
	}
	if s.LastMessage != "" {
		info.LastMessage = &s.LastMessage
	}
	if s.Reason != "" {
		info.Reason = &s.Reason
	}
	return info
}

// --- StrictServerInterface implementations ---

func (s *Server) CheckHealth(_ context.Context, _ CheckHealthRequestObject) (CheckHealthResponseObject, error) {
	return CheckHealth200TextResponse("OK"), nil
}

func (s *Server) ListAgents(ctx context.Context, _ ListAgentsRequestObject) (ListAgentsResponseObject, error) {
	headList, err := heads.ListHeads(ctx, s.DockerClient, s.ProjectRoot)
	if err != nil {
		code := 500
		msg := err.Error()
		return ListAgents500JSONResponse{Code: code, Error: msg}, nil
	}
	resp := make(ListAgents200JSONResponse, len(headList))
	for i, h := range headList {
		resp[i] = AgentResponse{
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
			ClaudeStatus:    toAPIClaudeStatus(h.ClaudeStatus),
		}
	}
	return resp, nil
}

func (s *Server) GetStatus(_ context.Context, _ GetStatusRequestObject) (GetStatusResponseObject, error) {
	status := "OK"
	v := version
	uptime := float32(time.Since(s.StartTime).Seconds())
	projectRoot := s.ProjectRoot
	return GetStatus200JSONResponse(StatusResponse{
		Status:        &status,
		Version:       &v,
		UptimeSeconds: &uptime,
		ProjectRoot:   &projectRoot,
	}), nil
}

func (s *Server) SpawnAgent(ctx context.Context, request SpawnAgentRequestObject) (SpawnAgentResponseObject, error) {
	if request.Body == nil || strings.TrimSpace(request.Body.Prompt) == "" {
		code := 400
		msg := "prompt is required"
		return SpawnAgent400JSONResponse{Code: code, Error: msg}, nil
	}

	agentType := docker.AgentTypeClaude
	if request.Body.AgentType != nil && *request.Body.AgentType != "" {
		agentType = docker.AgentType(*request.Body.AgentType)
	}
	if agentType != docker.AgentTypeClaude && agentType != docker.AgentTypeGemini {
		code := 400
		msg := "unknown agent_type; supported: claude, gemini"
		return SpawnAgent400JSONResponse{Code: code, Error: msg}, nil
	}

	cfg, err := config.Load(s.ProjectRoot)
	if err != nil {
		code := 500
		msg := err.Error()
		return SpawnAgent500JSONResponse{Code: code, Error: msg}, nil
	}
	prePrompt := config.DefaultPrePrompt
	if cfg.PrePrompt != nil {
		prePrompt = *cfg.PrePrompt
	}
	prompt := strings.TrimSpace(request.Body.Prompt)

	id := strings.TrimSpace(request.Body.Id)
	var baseBranch string
	if request.Body.BaseBranch != nil {
		baseBranch = strings.TrimSpace(*request.Body.BaseBranch)
	}

	head, err := heads.SpawnHead(ctx, s.DockerClient, s.ProjectRoot, heads.SpawnHeadOptions{
		ID:         id,
		PrePrompt:  prePrompt,
		Prompt:     prompt,
		AgentType:  agentType,
		BaseBranch: baseBranch,
	})
	if err != nil {
		code := 500
		msg := err.Error()
		return SpawnAgent500JSONResponse{Code: code, Error: msg}, nil
	}
	return SpawnAgent201JSONResponse(AgentResponse{
		Id:              head.ID,
		BranchName:      head.Branch,
		WorktreePath:    head.Worktree,
		ProjectPath:     head.ProjectPath,
		ContainerId:     head.ContainerID,
		ContainerStatus: head.ContainerStatus,
		AgentType:       string(head.AgentType),
		Prompt:          head.Prompt,
		BaseBranch:      head.BaseBranch,
		ClaudeStatus:    toAPIClaudeStatus(head.ClaudeStatus),
	}), nil
}

func (s *Server) GetAgent(ctx context.Context, request GetAgentRequestObject) (GetAgentResponseObject, error) {
	head, err := heads.GetHeadByID(ctx, s.DockerClient, s.ProjectRoot, request.Id)
	if err != nil {
		code := 500
		msg := err.Error()
		return GetAgent500JSONResponse{Code: code, Error: msg}, nil
	}
	if head == nil {
		code := 404
		msg := "agent not found"
		return GetAgent404JSONResponse{Code: code, Error: msg}, nil
	}
	return GetAgent200JSONResponse(AgentResponse{
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
		ClaudeStatus:    toAPIClaudeStatus(head.ClaudeStatus),
	}), nil
}

func (s *Server) KillAgent(ctx context.Context, request KillAgentRequestObject) (KillAgentResponseObject, error) {
	head, err := heads.GetHeadByID(ctx, s.DockerClient, s.ProjectRoot, request.Id)
	if err != nil {
		code := 500
		msg := err.Error()
		return KillAgent500JSONResponse{Code: code, Error: msg}, nil
	}
	if head == nil {
		code := 404
		msg := "agent not found"
		return KillAgent404JSONResponse{Code: code, Error: msg}, nil
	}

	if err := heads.KillHead(ctx, s.DockerClient, *head); err != nil {
		code := 500
		msg := err.Error()
		return KillAgent500JSONResponse{Code: code, Error: msg}, nil
	}

	return KillAgent204Response{}, nil
}
