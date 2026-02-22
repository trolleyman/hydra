package api

import (
	"context"
	"net/http"
)

const version = "0.1.0"

// Server implements StrictServerInterface.
type Server struct {
	WorktreesDir string
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

func (s *Server) GetStatus(_ context.Context, _ GetStatusRequestObject) (GetStatusResponseObject, error) {
	status := "OK"
	v := version
	return GetStatus200JSONResponse(StatusResponse{Status: &status, Version: &v}), nil
}
