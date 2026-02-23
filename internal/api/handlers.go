package api

import (
	"context"
	"net/http"
	"time"

	dockerclient "github.com/docker/docker/client"
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
			BranchName:      h.BranchName,
			HasBranch:       h.HasBranch,
			WorktreePath:    h.WorktreePath,
			HasWorktree:     h.HasWorktree,
			ProjectPath:     h.ProjectPath,
			ContainerId:     h.ContainerID,
			ContainerStatus: h.ContainerStatus,
			AgentType:       string(h.AgentType),
			PrePrompt:       h.PrePrompt,
			Prompt:          h.Prompt,
			BaseBranch:      h.BaseBranch,
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
		BranchName:      head.BranchName,
		HasBranch:       head.HasBranch,
		WorktreePath:    head.WorktreePath,
		HasWorktree:     head.HasWorktree,
		ProjectPath:     head.ProjectPath,
		ContainerId:     head.ContainerID,
		ContainerStatus: head.ContainerStatus,
		AgentType:       string(head.AgentType),
		PrePrompt:       head.PrePrompt,
		Prompt:          head.Prompt,
		BaseBranch:      head.BaseBranch,
	}), nil
}
