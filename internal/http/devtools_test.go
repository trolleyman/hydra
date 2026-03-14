package http

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/projects"
)

func TestGetDevToolsConfig(t *testing.T) {
	s := &Server{
		ProjectRoot: "/tmp/test-project",
		DefaultProject: projects.ProjectInfo{
			UUID: "test-uuid",
		},
	}

	handler := NewHandler(s)
	req := httptest.NewRequest(http.MethodGet, "/.well-known/appspecific/com.chrome.devtools.json", nil)
	rr := httptest.NewRecorder()

	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", rr.Code)
	}

	var resp struct {
		Workspace struct {
			Root string `json:"root"`
			Uuid string `json:"uuid"`
		} `json:"workspace"`
	}
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if resp.Workspace.Root != "/tmp/test-project" {
		t.Errorf("expected root /tmp/test-project, got %s", resp.Workspace.Root)
	}
	if resp.Workspace.Uuid != "test-uuid" {
		t.Errorf("expected uuid test-uuid, got %s", resp.Workspace.Uuid)
	}
}

func TestGetDevToolsConfigSimulation(t *testing.T) {
	s := &SimulationServer{}
	mux := http.NewServeMux()
	api.HandlerFromMux(s, mux)

	req := httptest.NewRequest(http.MethodGet, "/.well-known/appspecific/com.chrome.devtools.json", nil)
	rr := httptest.NewRecorder()

	mux.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", rr.Code)
	}

	var resp struct {
		Workspace struct {
			Root string `json:"root"`
			Uuid string `json:"uuid"`
		} `json:"workspace"`
	}
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if resp.Workspace.Root != "/simulated/project" {
		t.Errorf("expected root /simulated/project, got %s", resp.Workspace.Root)
	}
	if resp.Workspace.Uuid != "sim-uuid-1" {
		t.Errorf("expected uuid sim-uuid-1, got %s", resp.Workspace.Uuid)
	}
}
