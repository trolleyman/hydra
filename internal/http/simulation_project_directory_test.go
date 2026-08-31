package http

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/trolleyman/hydra/internal/api"
)

func TestSimulationIncludesProjectDirectoryChats(t *testing.T) {
	s := &SimulationServer{}
	recorder := httptest.NewRecorder()
	s.ListAgents(recorder, httptest.NewRequest("GET", "/api/projects/sim-project/agents", nil), "sim-project", api.ListAgentsParams{})

	var agents []api.AgentResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &agents); err != nil {
		t.Fatal(err)
	}
	projectDirectory := make(map[string]api.AgentResponse)
	for _, agent := range agents {
		if agent.WorkspaceKind == api.WorkspaceKindProjectDirectory {
			projectDirectory[agent.Id] = agent
		}
	}
	if len(projectDirectory) != 3 {
		t.Fatalf("project-directory fixtures = %d, want 3", len(projectDirectory))
	}
	for _, id := range []string{"project-directory-edit", "project-directory-readonly", "project-directory-working"} {
		agent, ok := projectDirectory[id]
		if !ok {
			t.Errorf("missing project-directory fixture %q", id)
			continue
		}
		if agent.BranchName != nil || agent.ChatMode == nil || !*agent.ChatMode {
			t.Errorf("project-directory fixture %q has branch/chat mismatch: %+v", id, agent)
		}
	}

	archived := true
	recorder = httptest.NewRecorder()
	s.ListAgents(recorder, httptest.NewRequest("GET", "/api/projects/sim-project/agents?archived=true", nil), "sim-project", api.ListAgentsParams{Archived: &archived})
	if err := json.Unmarshal(recorder.Body.Bytes(), &agents); err != nil {
		t.Fatal(err)
	}
	foundArchivedProjectDirectory := false
	for _, agent := range agents {
		if agent.Id == "archived-project-directory" {
			foundArchivedProjectDirectory = agent.BranchName == nil && agent.WorkspaceKind == api.WorkspaceKindProjectDirectory
		}
	}
	if !foundArchivedProjectDirectory {
		t.Error("archived project-directory fixture missing or incorrectly branch-backed")
	}
}

func TestSimulationRejectsCommitsInReadOnlyMode(t *testing.T) {
	s := &SimulationServer{}
	body := []byte(`{"filesystem_mode":"readonly","allow_commits":true}`)
	recorder := httptest.NewRecorder()
	s.UpdateAgent(recorder, httptest.NewRequest("PATCH", "/api/projects/sim-project/agents/project-directory-edit", bytes.NewReader(body)), "sim-project", "project-directory-edit")
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("update status = %d, want %d; body=%s", recorder.Code, http.StatusBadRequest, recorder.Body.String())
	}
}

func TestSimulationUpdatesProjectDirectoryPermissions(t *testing.T) {
	s := &SimulationServer{}
	body := []byte(`{"filesystem_mode":"readonly","allow_commits":false,"checkout_branch":"release"}`)
	recorder := httptest.NewRecorder()
	s.UpdateAgent(recorder, httptest.NewRequest("PATCH", "/api/projects/sim-project/agents/project-directory-edit", bytes.NewReader(body)), "sim-project", "project-directory-edit")
	if recorder.Code != 200 {
		t.Fatalf("update status = %d, body=%s", recorder.Code, recorder.Body.String())
	}

	agent, ok := s.projectDirectoryAgent("project-directory-edit")
	if !ok || agent.FilesystemMode == nil || *agent.FilesystemMode != api.ProjectDirectoryFilesystemReadonly {
		t.Fatalf("updated project-directory fixture = %+v, ok=%v", agent, ok)
	}
	if agent.AllowCommits == nil || *agent.AllowCommits {
		t.Fatalf("allow_commits was not disabled: %+v", agent.AllowCommits)
	}
	recorder = httptest.NewRecorder()
	s.GetRepositoryBranches(recorder, httptest.NewRequest("GET", "/api/projects/sim-project/repository/branches", nil), "sim-project")
	var branches api.RepositoryBranchesResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &branches); err != nil {
		t.Fatal(err)
	}
	if branches.Current != "release" {
		t.Fatalf("current simulated branch = %q, want release", branches.Current)
	}
}
