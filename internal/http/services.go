package http

import (
	"context"

	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/services"
)

// toServiceStatusResponse maps the supervisor's status snapshots to the API shape.
func toServiceStatusResponse(sts []services.Status) api.ServiceStatusResponse {
	out := api.ServiceStatusResponse{Services: make([]api.ServiceStatus, 0, len(sts))}
	for _, s := range sts {
		pid, msg := s.PID, s.Message
		out.Services = append(out.Services, api.ServiceStatus{
			Name:        s.Name,
			Script:      s.Script,
			Host:        s.Host,
			State:       api.ServiceStatusState(s.State),
			Restarts:    s.Restarts,
			MaxRestarts: s.MaxRestarts,
			Pid:         &pid,
			Message:     &msg,
		})
	}
	return out
}

// GetServices returns the live status of the project's supervised services.
func (s *Server) GetServices(_ context.Context, request api.GetServicesRequestObject) (api.GetServicesResponseObject, error) {
	p := s.ProjectsManager.GetByID(request.ProjectId)
	if p == nil {
		return api.GetServices404JSONResponse{
			Code:    404,
			Error:   api.ErrorResponseErrorNotFound,
			Details: "project not found",
		}, nil
	}
	var sts []services.Status
	if s.Services != nil {
		sts = s.Services.Status(p.Path)
	}
	return api.GetServices200JSONResponse(toServiceStatusResponse(sts)), nil
}

// RestartServices stops and restarts the project's supervised services, picking
// up any [[services]] config changes, and returns the fresh status.
func (s *Server) RestartServices(_ context.Context, request api.RestartServicesRequestObject) (api.RestartServicesResponseObject, error) {
	p := s.ProjectsManager.GetByID(request.ProjectId)
	if p == nil {
		return api.RestartServices404JSONResponse{
			Code:    404,
			Error:   api.ErrorResponseErrorNotFound,
			Details: "project not found",
		}, nil
	}
	var sts []services.Status
	if s.Services != nil {
		s.Services.RestartProject(p.Path)
		sts = s.Services.Status(p.Path)
	}
	return api.RestartServices200JSONResponse(toServiceStatusResponse(sts)), nil
}
