package api

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

const version = "0.1.0"

// Server implements StrictServerInterface.
type Server struct {
	WorktreesDir string
}

// newServer creates a handler with the strict wrapper and SSE override.
func NewHandler(s *Server) http.Handler {
	strict := NewStrictHandler(s, nil)
	wrapper := &sseOverride{ServerInterface: strict, server: s}
	return HandlerFromMux(wrapper, http.NewServeMux())
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
