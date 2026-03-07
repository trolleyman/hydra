package http

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync/atomic"
	"time"

	dockerclient "github.com/docker/docker/client"
	"github.com/google/uuid"
	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/db"
	"github.com/trolleyman/hydra/internal/docker"
	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/heads"
	"github.com/trolleyman/hydra/internal/paths"
	"github.com/trolleyman/hydra/internal/projects"
)

const version = "0.1.0"

// devRestartExitCode is the process exit code that signals mage to rebuild and restart.
const devRestartExitCode = 42

// Server implements StrictServerInterface.
type Server struct {
	WorktreesDir      string
	ProjectRoot       string
	DefaultProject    projects.ProjectInfo
	ProjectsManager   *projects.Manager
	DockerClient      *dockerclient.Client
	DB                *db.Store
	StartTime         time.Time
	DevRestartEnabled bool // set when running under mage dev / mage DevAutoReload

	lastDockerError atomic.Value // holds string
}

func (s *Server) SetDockerError(err error) {
	if err == nil {
		s.lastDockerError.Store("")
	} else {
		s.lastDockerError.Store(err.Error())
	}
}

func (s *Server) GetDockerError() string {
	v := s.lastDockerError.Load()
	if v == nil {
		return ""
	}
	return v.(string)
}

// DevToolsNamespace is used for generating stable UUIDs for workspace roots.
var DevToolsNamespace = uuid.MustParse("d63f9661-d707-4054-9467-33f7d247f0e3")

func (s *Server) HandleDevToolsJSON(w http.ResponseWriter, r *http.Request) {
	// Generate a stable UUID for this project root
	u := uuid.NewSHA1(DevToolsNamespace, []byte(s.ProjectRoot))

	resp := map[string]interface{}{
		"workspace": map[string]string{
			"root": s.ProjectRoot,
			"uuid": u.String(),
		},
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(resp); err != nil {
		log.Printf("error encoding devtools json: %v", err)
	}
}

// NewHandler creates a handler with routing matching the OpenAPI spec.
func NewHandler(s *Server) http.Handler {
	strict := api.NewStrictHandler(s, nil)
	return api.HandlerFromMux(strict, http.NewServeMux())
}

// resolveProjectRoot returns the project root for the given project_id query param.
// Falls back to the server's default project root when project_id is absent or unknown.
func (s *Server) resolveProjectRoot(projectID *string) string {
	path := s.ProjectRoot
	if projectID != nil && *projectID != "" {
		p := s.ProjectsManager.GetByID(*projectID)
		if p != nil {
			path = p.Path
		}
	}
	norm, err := paths.NormalizePath(path)
	if err != nil {
		return path // fallback to unnormalized if error
	}
	return norm
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
		return api.AddProject400JSONResponse{
			Code:    400,
			Error:   "bad_request",
			Details: "path is required",
		}, nil
	}

	projectPath := strings.TrimSpace(request.Body.Path)

	// Validate it's a git repository.
	if _, err := paths.GetProjectRoot(projectPath); err != nil {
		return api.AddProject400JSONResponse{
			Code:    400,
			Error:   "bad_request",
			Details: "path is not a git repository: " + err.Error(),
		}, nil
	}

	p, err := s.ProjectsManager.AddProject(projectPath)
	if err != nil {
		return api.AddProject500JSONResponse{
			Code:    500,
			Error:   "internal_error",
			Details: err.Error(),
		}, nil
	}
	return api.AddProject201JSONResponse(api.ProjectInfo{
		Id:   p.ID,
		Path: p.Path,
		Name: p.Name,
	}), nil
}

func (s *Server) ListAgents(ctx context.Context, request api.ListAgentsRequestObject) (api.ListAgentsResponseObject, error) {
	projectRoot := s.resolveProjectRoot(request.Params.ProjectId)
	headList, err := heads.ListHeads(ctx, s.DockerClient, s.DB, projectRoot)
	if err != nil {
		errStr := err.Error()
		errorType := api.InternalError
		if dockerclient.IsErrConnectionFailed(err) || strings.Contains(errStr, "error during connect") {
			errorType = api.DockerConnect
			errStr = "Error connecting to Docker: " + errStr
		}

		return api.ListAgents500JSONResponse{
			Code:    500,
			Error:   errorType,
			Details: errStr,
		}, nil
	}
	resp := make(api.ListAgents200JSONResponse, len(headList))
	for i, h := range headList {
		var createdAt *int64
		if h.CreatedAt != 0 {
			createdAt = &h.CreatedAt
		}
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
			Ephemeral:       &h.Ephemeral,
			CreatedAt:       createdAt,
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
	devRestartAvailable := s.DevRestartEnabled

	var dockerErr *string
	if lastErr := s.GetDockerError(); lastErr != "" {
		errStr := lastErr
		if strings.Contains(errStr, "error during connect") {
			errStr = "Error connecting to Docker: " + errStr
		}
		dockerErr = &errStr
	}

	return api.GetStatus200JSONResponse(api.StatusResponse{
		Status:              &status,
		DockerError:         dockerErr,
		Version:             &v,
		UptimeSeconds:       &uptime,
		ProjectRoot:         &projectRoot,
		DefaultProjectId:    &defaultProjectID,
		DevRestartAvailable: &devRestartAvailable,
	}), nil
}

func (s *Server) GetConfig(_ context.Context, request api.GetConfigRequestObject) (api.GetConfigResponseObject, error) {
	projectRoot := s.resolveProjectRoot(request.Params.ProjectId)

	var cfg config.Config
	if request.Params.Scope != nil {
		// Load only the raw config for the requested scope (not merged).
		var path string
		var err error
		if *request.Params.Scope == api.GetConfigParamsScopeUser {
			path, err = config.GetUserConfigPath()
			if err != nil {
				return api.GetConfig500JSONResponse{Code: 500, Error: "internal_error", Details: err.Error()}, nil
			}
		} else {
			path = config.GetProjectConfigPath(projectRoot)
		}
		raw, err := config.LoadFile(path)
		if err != nil {
			return api.GetConfig500JSONResponse{Code: 500, Error: "internal_error", Details: err.Error()}, nil
		}
		if raw != nil {
			cfg = *raw
		}
	} else {
		var err error
		cfg, err = config.Load(projectRoot)
		if err != nil {
			return api.GetConfig500JSONResponse{
				Code:    500,
				Error:   "internal_error",
				Details: err.Error(),
			}, nil
		}
	}

	defaultDockerfiles := map[string]string{
		"base":    config.DefaultDockerfileBase,
		"claude":  config.DefaultDockerfileClaude,
		"copilot": config.DefaultDockerfileCopilot,
		"gemini":  config.DefaultDockerfileGemini,
		"bash":    config.DefaultDockerfileBash,
	}
	resp := api.ConfigResponse{
		Defaults: api.AgentConfig{
			Dockerfile:           cfg.Defaults.Dockerfile,
			DockerfileContents:   cfg.Defaults.DockerfileContents,
			DockerignoreContents: cfg.Defaults.DockerignoreContents,
			SharedMounts:         &cfg.Defaults.SharedMounts,
			Context:              cfg.Defaults.Context,
			PrePrompt:            cfg.Defaults.PrePrompt,
		},
		Agents:             make(map[string]api.AgentConfig),
		DefaultDockerfiles: &defaultDockerfiles,
	}

	for name, agent := range cfg.Agents {
		sharedMounts := agent.SharedMounts
		resp.Agents[name] = api.AgentConfig{
			Dockerfile:           agent.Dockerfile,
			DockerfileContents:   agent.DockerfileContents,
			DockerignoreContents: agent.DockerignoreContents,
			SharedMounts:         &sharedMounts,
			Context:              agent.Context,
			PrePrompt:            agent.PrePrompt,
		}
	}

	return api.GetConfig200JSONResponse(resp), nil
}

func (s *Server) SaveConfig(_ context.Context, request api.SaveConfigRequestObject) (api.SaveConfigResponseObject, error) {
	projectRoot := s.resolveProjectRoot(request.Params.ProjectId)

	var defaultSm []string
	if request.Body.Defaults.SharedMounts != nil {
		defaultSm = *request.Body.Defaults.SharedMounts
	}

	newCfg := config.Config{
		Defaults: config.AgentConfig{
			Dockerfile:           request.Body.Defaults.Dockerfile,
			DockerfileContents:   request.Body.Defaults.DockerfileContents,
			DockerignoreContents: request.Body.Defaults.DockerignoreContents,
			SharedMounts:         defaultSm,
			Context:              request.Body.Defaults.Context,
			PrePrompt:            request.Body.Defaults.PrePrompt,
		},
		Agents: make(map[string]config.AgentConfig),
	}
	for name, agent := range request.Body.Agents {
		var sm []string
		if agent.SharedMounts != nil {
			sm = *agent.SharedMounts
		}
		newCfg.Agents[name] = config.AgentConfig{
			Dockerfile:           agent.Dockerfile,
			DockerfileContents:   agent.DockerfileContents,
			DockerignoreContents: agent.DockerignoreContents,
			SharedMounts:         sm,
			Context:              agent.Context,
			PrePrompt:            agent.PrePrompt,
		}
	}

	scope := api.SaveConfigParamsScopeProject
	if request.Params.Scope != nil {
		scope = *request.Params.Scope
	}

	var savePath string
	if scope == api.SaveConfigParamsScopeUser {
		var err error
		savePath, err = config.GetUserConfigPath()
		if err != nil {
			return api.SaveConfig500JSONResponse{
				Code:    500,
				Error:   "internal_error",
				Details: err.Error(),
			}, nil
		}
	} else {
		savePath = config.GetProjectConfigPath(projectRoot)
	}

	if err := config.SaveToFile(savePath, newCfg); err != nil {
		return api.SaveConfig500JSONResponse{
			Code:    500,
			Error:   "internal_error",
			Details: err.Error(),
		}, nil
	}

	return api.SaveConfig200Response{}, nil
}

func (s *Server) DevRestart(_ context.Context, _ api.DevRestartRequestObject) (api.DevRestartResponseObject, error) {
	if !s.DevRestartEnabled {
		return api.DevRestart403JSONResponse{
			Code:    403,
			Error:   "unauthorized",
			Details: "not in dev mode",
		}, nil
	}
	// Respond 200 then exit with the restart code after a short delay to allow the response to flush.
	go func() {
		time.Sleep(100 * time.Millisecond)
		os.Exit(devRestartExitCode)
	}()
	return api.DevRestart200Response{}, nil
}

func (s *Server) SpawnAgent(ctx context.Context, request api.SpawnAgentRequestObject) (api.SpawnAgentResponseObject, error) {
	if request.Body == nil {
		return api.SpawnAgent400JSONResponse{
			Code:    400,
			Error:   "bad_request",
			Details: "request body is required",
		}, nil
	}

	projectRoot := s.resolveProjectRoot(request.Params.ProjectId)
	log.Printf("api: spawn agent request: id=%q, type=%v, project=%q", request.Body.Id, request.Body.AgentType, projectRoot)
	var agentType docker.AgentType
	if request.Body.AgentType != nil && *request.Body.AgentType != "" {
		agentType = docker.AgentType(*request.Body.AgentType)
	}
	if agentType != docker.AgentTypeClaude && agentType != docker.AgentTypeGemini && agentType != docker.AgentTypeBash && agentType != docker.AgentTypeCopilot {
		return api.SpawnAgent400JSONResponse{
			Code:    400,
			Error:   "bad_request",
			Details: "unknown agent_type; supported: claude, gemini, copilot, bash",
		}, nil
	}

	cfg, err := config.Load(projectRoot)
	if err != nil {
		return api.SpawnAgent500JSONResponse{
			Code:    500,
			Error:   "internal_error",
			Details: err.Error(),
		}, nil
	}

	resolved := cfg.GetResolvedConfig(string(agentType))

	prePrompt := config.DefaultPrePrompt
	if resolved.PrePrompt != nil {
		prePrompt = *resolved.PrePrompt
	}
	prompt := ""
	if request.Body.Prompt != nil {
		prompt = strings.TrimSpace(*request.Body.Prompt)
	}

	// Resolve Dockerfile path and contents
	dockerfilePath := ""
	dockerfileContents := ""
	dockerignoreContents := ""
	var sharedMounts []string
	if resolved.Dockerfile != nil {
		dockerfilePath = *resolved.Dockerfile
	}
	if resolved.DockerfileContents != nil {
		dockerfileContents = *resolved.DockerfileContents
	}
	if resolved.DockerignoreContents != nil {
		dockerignoreContents = *resolved.DockerignoreContents
	}
	if resolved.SharedMounts != nil {
		sharedMounts = resolved.SharedMounts
	}
	if dockerfilePath != "" {
		if _, readErr := os.ReadFile(dockerfilePath); readErr != nil {
			return api.SpawnAgent500JSONResponse{
				Code:    500,
				Error:   "internal_error",
				Details: "read dockerfile: " + readErr.Error(),
			}, nil
		}
	}

	id := strings.TrimSpace(request.Body.Id)
	var baseBranch string
	if request.Body.BaseBranch != nil {
		baseBranch = strings.TrimSpace(*request.Body.BaseBranch)
	}

	ephemeral := false
	if request.Body.Ephemeral != nil {
		ephemeral = *request.Body.Ephemeral
	}

	head, err := heads.SpawnHead(ctx, s.DockerClient, s.DB, projectRoot, heads.SpawnHeadOptions{
		ID:                   id,
		PrePrompt:            prePrompt,
		Prompt:               prompt,
		AgentType:            agentType,
		BaseBranch:           baseBranch,
		DockerfilePath:       dockerfilePath,
		DockerfileContents:   dockerfileContents,
		DockerignoreContents: dockerignoreContents,
		SharedMounts:         sharedMounts,
		Ephemeral:            ephemeral,
	})
	if err != nil {
		return api.SpawnAgent500JSONResponse{
			Code:    500,
			Error:   "internal_error",
			Details: err.Error(),
		}, nil
	}
	var spawnCreatedAt *int64
	if head.CreatedAt != 0 {
		spawnCreatedAt = &head.CreatedAt
	}
	return api.SpawnAgent201JSONResponse(api.AgentResponse{
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
		Ephemeral:       &head.Ephemeral,
		CreatedAt:       spawnCreatedAt,
		AgentStatus:     head.AgentStatus,
	}), nil
}

func (s *Server) GetAgent(ctx context.Context, request api.GetAgentRequestObject) (api.GetAgentResponseObject, error) {
	projectRoot := s.resolveProjectRoot(request.Params.ProjectId)
	head, err := heads.GetHeadByID(ctx, s.DockerClient, s.DB, projectRoot, request.Id)
	if err != nil {
		return api.GetAgent500JSONResponse{
			Code:    500,
			Error:   "internal_error",
			Details: err.Error(),
		}, nil
	}
	if head == nil {
		return api.GetAgent404JSONResponse{
			Code:    404,
			Error:   "not_found",
			Details: "agent not found",
		}, nil
	}
	var getCreatedAt *int64
	if head.CreatedAt != 0 {
		getCreatedAt = &head.CreatedAt
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
		Ephemeral:       &head.Ephemeral,
		CreatedAt:       getCreatedAt,
		AgentStatus:     head.AgentStatus,
	}), nil
}

func (s *Server) MergeAgent(ctx context.Context, request api.MergeAgentRequestObject) (api.MergeAgentResponseObject, error) {
	projectRoot := s.resolveProjectRoot(request.Params.ProjectId)
	head, err := heads.GetHeadByID(ctx, s.DockerClient, s.DB, projectRoot, request.Id)
	if err != nil {
		return api.MergeAgent500JSONResponse{
			Error:   "internal_error",
			Code:    500,
			Details: err.Error(),
		}, nil
	}
	if head == nil {
		return api.MergeAgent404JSONResponse{
			Error:   "not_found",
			Code:    404,
			Details: "agent not found",
		}, nil
	}

	if head.Branch == nil {
		return api.MergeAgent400JSONResponse{
			Error:   "bad_request",
			Code:    400,
			Details: "agent has no git branch to merge",
		}, nil
	}
	branchName := *head.Branch

	// Atomically claim the merge operation.
	if s.DB != nil {
		ok, err := s.DB.TrySetHeadStatus(head.ID, "idle", "merging")
		if err != nil {
			return api.MergeAgent500JSONResponse{
				Error:   "internal_error",
				Code:    500,
				Details: err.Error(),
			}, nil
		}
		if !ok {
			return api.MergeAgent409JSONResponse{
				Error:   "conflict",
				Code:    409,
				Details: "operation already in progress",
			}, nil
		}
	}

	var stderr bytes.Buffer
	gitMergeCmd := exec.CommandContext(ctx, "git", "-C", projectRoot, "merge", branchName)
	gitMergeCmd.Stderr = &stderr
	if err := gitMergeCmd.Run(); err != nil {
		// If merge fails, abort it to keep the base branch clean.
		exec.CommandContext(ctx, "git", "-C", projectRoot, "merge", "--abort").Run()

		errMsg := fmt.Sprintf("git merge failed: %s", strings.TrimSpace(stderr.String()))
		if s.DB != nil {
			_ = s.DB.ClearHeadStatus(head.ID, &errMsg)
		}
		return api.MergeAgent409JSONResponse(api.MergeConflictError{
			Error:   api.MergeConflict,
			Code:    409,
			Details: errMsg,
		}), nil
	}

	// Kill cleanup without re-doing the CAS (already in "merging" state).
	if err := heads.KillHeadNoLock(ctx, s.DockerClient, s.DB, *head); err != nil {
		return api.MergeAgent500JSONResponse{
			Error:   "internal_error",
			Code:    500,
			Details: err.Error(),
		}, nil
	}

	return api.MergeAgent204Response{}, nil
}

func (s *Server) UpdateAgentFromBase(ctx context.Context, request api.UpdateAgentFromBaseRequestObject) (api.UpdateAgentFromBaseResponseObject, error) {
	projectRoot := s.resolveProjectRoot(request.Params.ProjectId)
	head, err := heads.GetHeadByID(ctx, s.DockerClient, s.DB, projectRoot, request.Id)
	if err != nil {
		return api.UpdateAgentFromBase500JSONResponse{
			Error:   "internal_error",
			Code:    500,
			Details: err.Error(),
		}, nil
	}
	if head == nil {
		return api.UpdateAgentFromBase404JSONResponse{
			Error:   "not_found",
			Code:    404,
			Details: "agent not found",
		}, nil
	}

	if head.Branch == nil {
		return api.UpdateAgentFromBase500JSONResponse{
			Error:   "bad_request",
			Code:    500,
			Details: "agent has no git branch to update",
		}, nil
	}

	mergeDir := projectRoot
	if head.Worktree != nil {
		mergeDir = *head.Worktree
	}

	// Attempt merge (base branch into current branch)
	var stderr bytes.Buffer
	gitMergeCmd := exec.CommandContext(ctx, "git", "-C", mergeDir, "merge", head.BaseBranch)
	gitMergeCmd.Stderr = &stderr
	if err := gitMergeCmd.Run(); err != nil {
		// If merge fails, abort it to keep worktree clean
		exec.CommandContext(ctx, "git", "-C", mergeDir, "merge", "--abort").Run()

		errMsg := fmt.Sprintf("git merge failed: %s", strings.TrimSpace(stderr.String()))
		return api.UpdateAgentFromBase409JSONResponse(api.MergeConflictError{
			Error:   api.MergeConflict,
			Code:    409,
			Details: errMsg,
		}), nil
	}

	return api.UpdateAgentFromBase204Response{}, nil
}

func (s *Server) RestartAgent(ctx context.Context, request api.RestartAgentRequestObject) (api.RestartAgentResponseObject, error) {
	projectRoot := s.resolveProjectRoot(request.Params.ProjectId)
	head, err := heads.GetHeadByID(ctx, s.DockerClient, s.DB, projectRoot, request.Id)
	if err != nil {
		return api.RestartAgent500JSONResponse{
			Code:    500,
			Error:   "internal_error",
			Details: err.Error(),
		}, nil
	}
	if head == nil {
		return api.RestartAgent404JSONResponse{
			Code:    404,
			Error:   "not_found",
			Details: "agent not found",
		}, nil
	}

	// Save the fields we need to respawn.
	id := head.ID
	prompt := head.Prompt
	prePrompt := head.PrePrompt
	agentType := head.AgentType
	baseBranch := head.BaseBranch

	// Kill the existing head (container, worktree, branch).
	if err := heads.KillHead(ctx, s.DockerClient, s.DB, *head); err != nil {
		if errors.Is(err, db.ErrOperationInProgress) {
			return api.RestartAgent409JSONResponse{
				Code:    409,
				Error:   "conflict",
				Details: "operation already in progress",
			}, nil
		}
		return api.RestartAgent500JSONResponse{
			Code:    500,
			Error:   "internal_error",
			Details: err.Error(),
		}, nil
	}

	// Resolve dockerfile from config (same as SpawnAgent).
	dockerfilePath := ""
	dockerfileContents := ""
	dockerignoreContents := ""
	var sharedMounts []string
	if cfg, cfgErr := config.Load(projectRoot); cfgErr == nil {
		resolved := cfg.GetResolvedConfig(string(agentType))
		if resolved.Dockerfile != nil {
			dockerfilePath = *resolved.Dockerfile
		}
		if resolved.DockerfileContents != nil {
			dockerfileContents = *resolved.DockerfileContents
		}
		if resolved.DockerignoreContents != nil {
			dockerignoreContents = *resolved.DockerignoreContents
		}
		if resolved.SharedMounts != nil {
			sharedMounts = resolved.SharedMounts
		}
		// Override pre_prompt from config if we didn't already have one stored.
		if prePrompt == "" && resolved.PrePrompt != nil {
			prePrompt = *resolved.PrePrompt
		}
	}

	newHead, err := heads.SpawnHead(ctx, s.DockerClient, s.DB, projectRoot, heads.SpawnHeadOptions{
		ID:                   id,
		PrePrompt:            prePrompt,
		Prompt:               prompt,
		AgentType:            agentType,
		BaseBranch:           baseBranch,
		DockerfilePath:       dockerfilePath,
		DockerfileContents:   dockerfileContents,
		DockerignoreContents: dockerignoreContents,
		SharedMounts:         sharedMounts,
	})
	if err != nil {
		return api.RestartAgent500JSONResponse{
			Code:    500,
			Error:   "internal_error",
			Details: err.Error(),
		}, nil
	}

	var restartCreatedAt *int64
	if newHead.CreatedAt != 0 {
		restartCreatedAt = &newHead.CreatedAt
	}
	return api.RestartAgent200JSONResponse(api.AgentResponse{
		Id:              newHead.ID,
		BranchName:      newHead.Branch,
		WorktreePath:    newHead.Worktree,
		ProjectPath:     newHead.ProjectPath,
		ContainerId:     newHead.ContainerID,
		ContainerStatus: newHead.ContainerStatus,
		AgentType:       string(newHead.AgentType),
		PrePrompt:       newHead.PrePrompt,
		Prompt:          newHead.Prompt,
		BaseBranch:      newHead.BaseBranch,
		Ephemeral:       &newHead.Ephemeral,
		CreatedAt:       restartCreatedAt,
		AgentStatus:     newHead.AgentStatus,
	}), nil
}

func (s *Server) KillAgent(ctx context.Context, request api.KillAgentRequestObject) (api.KillAgentResponseObject, error) {
	projectRoot := s.resolveProjectRoot(request.Params.ProjectId)
	log.Printf("api: kill agent request: id=%q, project=%q", request.Id, projectRoot)
	head, err := heads.GetHeadByID(ctx, s.DockerClient, s.DB, projectRoot, request.Id)
	if err != nil {
		return api.KillAgent500JSONResponse{
			Code:    500,
			Error:   "internal_error",
			Details: err.Error(),
		}, nil
	}
	if head == nil {
		return api.KillAgent404JSONResponse{
			Code:    404,
			Error:   "not_found",
			Details: "agent not found",
		}, nil
	}

	if err := heads.KillHead(ctx, s.DockerClient, s.DB, *head); err != nil {
		if errors.Is(err, db.ErrOperationInProgress) {
			return api.KillAgent409JSONResponse{
				Code:    409,
				Error:   "conflict",
				Details: "operation already in progress",
			}, nil
		}
		return api.KillAgent500JSONResponse{
			Code:    500,
			Error:   "internal_error",
			Details: err.Error(),
		}, nil
	}

	return api.KillAgent204Response{}, nil
}

func (s *Server) GetAgentCommits(ctx context.Context, request api.GetAgentCommitsRequestObject) (api.GetAgentCommitsResponseObject, error) {
	projectRoot := s.resolveProjectRoot(request.Params.ProjectId)
	head, err := heads.GetHeadByID(ctx, s.DockerClient, s.DB, projectRoot, request.Id)
	if err != nil {
		return api.GetAgentCommits500JSONResponse{
			Code:    500,
			Error:   "internal_error",
			Details: err.Error(),
		}, nil
	}
	if head == nil {
		return api.GetAgentCommits404JSONResponse{
			Code:    404,
			Error:   "not_found",
			Details: "agent not found",
		}, nil
	}

	baseBranch := head.BaseBranch
	headBranch := ""
	if head.Branch != nil {
		headBranch = *head.Branch
	}
	if headBranch == "" {
		return api.GetAgentCommits200JSONResponse{}, nil
	}

	commits, err := git.ListCommits(projectRoot, baseBranch, headBranch)
	if err != nil {
		return api.GetAgentCommits500JSONResponse{
			Code:    500,
			Error:   "internal_error",
			Details: err.Error(),
		}, nil
	}

	resp := make(api.GetAgentCommits200JSONResponse, len(commits))
	for i, c := range commits {
		subject := c.Subject
		resp[i] = api.CommitInfo{
			Sha:         c.SHA,
			ShortSha:    c.ShortSHA,
			Message:     c.Message,
			Subject:     &subject,
			AuthorName:  c.AuthorName,
			AuthorEmail: c.AuthorEmail,
			Timestamp:   c.Timestamp,
		}
	}
	return resp, nil
}

func (s *Server) GetAgentDiff(ctx context.Context, request api.GetAgentDiffRequestObject) (api.GetAgentDiffResponseObject, error) {
	projectRoot := s.resolveProjectRoot(request.Params.ProjectId)
	head, err := heads.GetHeadByID(ctx, s.DockerClient, s.DB, projectRoot, request.Id)
	if err != nil {
		return api.GetAgentDiff500JSONResponse{
			Code:    500,
			Error:   "internal_error",
			Details: err.Error(),
		}, nil
	}
	if head == nil {
		return api.GetAgentDiff404JSONResponse{
			Code:    404,
			Error:   "not_found",
			Details: "agent not found",
		}, nil
	}

	headBranch := ""
	if head.Branch != nil {
		headBranch = *head.Branch
	}
	if headBranch == "" {
		empty := api.DiffResponse{Files: []api.DiffFile{}, BaseRef: head.BaseBranch, HeadRef: ""}
		return api.GetAgentDiff200JSONResponse(empty), nil
	}

	// Resolve base and head refs.
	baseRef := head.BaseBranch
	headRef := headBranch
	if request.Params.BaseRef != nil && *request.Params.BaseRef != "" {
		baseRef = *request.Params.BaseRef
	}
	if request.Params.HeadRef != nil && *request.Params.HeadRef != "" {
		headRef = *request.Params.HeadRef
	}

	ignoreWhitespace := false
	if request.Params.IgnoreWhitespace != nil {
		ignoreWhitespace = *request.Params.IgnoreWhitespace
	}

	includeUncommitted := false
	if request.Params.IncludeUncommitted != nil {
		includeUncommitted = *request.Params.IncludeUncommitted
	}

	// Use triple-dot (merge-base) diff when using default branch refs (whole MR view).
	// Use double-dot when specific commits are given (commit-to-commit view).
	useTripleDot := (request.Params.BaseRef == nil || *request.Params.BaseRef == "") &&
		(request.Params.HeadRef == nil || *request.Params.HeadRef == "") &&
		!includeUncommitted

	diffRoot := projectRoot
	if includeUncommitted && head.Worktree != nil {
		// Use the agent's worktree to see uncommitted changes.
		diffRoot = *head.Worktree

		// If using default refs (full diff), compare merge-base with worktree.
		if (request.Params.BaseRef == nil || *request.Params.BaseRef == "") &&
			(request.Params.HeadRef == nil || *request.Params.HeadRef == "") {
			if mb, err := git.GetMergeBase(diffRoot, baseRef, "HEAD"); err == nil {
				baseRef = mb
				headRef = "" // git diff baseRef compares baseRef to worktree
				useTripleDot = false
			}
		} else if headRef == headBranch {
			// If headRef is the current branch tip, compare baseRef with worktree.
			headRef = ""
			useTripleDot = false
		}
	}

	diffFiles, err := git.GetDiff(diffRoot, baseRef, headRef, ignoreWhitespace, useTripleDot)
	if err != nil {
		return api.GetAgentDiff500JSONResponse{
			Code:    500,
			Error:   "internal_error",
			Details: err.Error(),
		}, nil
	}

	// Fetch commit info for base and head if they look like SHAs.
	var baseCommitInfo *api.CommitInfo
	var headCommitInfo *api.CommitInfo

	fetchCommitInfo := func(ref string) *api.CommitInfo {
		c, err := git.GetCommitInfo(projectRoot, ref)
		if err != nil || c == nil {
			return nil
		}
		subject := c.Subject
		return &api.CommitInfo{
			Sha:         c.SHA,
			ShortSha:    c.ShortSHA,
			Message:     c.Message,
			Subject:     &subject,
			AuthorName:  c.AuthorName,
			AuthorEmail: c.AuthorEmail,
			Timestamp:   c.Timestamp,
		}
	}

	if request.Params.BaseRef != nil && *request.Params.BaseRef != "" {
		baseCommitInfo = fetchCommitInfo(baseRef)
	}
	if request.Params.HeadRef != nil && *request.Params.HeadRef != "" {
		headCommitInfo = fetchCommitInfo(headRef)
	}

	// Convert git.DiffFile slice to api.DiffFile slice.
	apiFiles := make([]api.DiffFile, len(diffFiles))
	for i, f := range diffFiles {
		apiHunks := make([]api.DiffHunk, len(f.Hunks))
		for j, h := range f.Hunks {
			apiLines := make([]api.DiffLine, len(h.Lines))
			for k, l := range h.Lines {
				apiLines[k] = api.DiffLine{
					Type:       api.DiffLineType(l.Type),
					Content:    l.Content,
					OldLineNum: l.OldLineNum,
					NewLineNum: l.NewLineNum,
				}
			}
			apiHunks[j] = api.DiffHunk{
				Header:   h.Header,
				OldStart: h.OldStart,
				NewStart: h.NewStart,
				Lines:    apiLines,
			}
		}
		apiFiles[i] = api.DiffFile{
			Path:       f.Path,
			OldPath:    f.OldPath,
			ChangeType: api.DiffFileChangeType(f.ChangeType),
			Additions:  f.Additions,
			Deletions:  f.Deletions,
			Binary:     f.Binary,
			Hunks:      apiHunks,
		}
	}

	mergeConflict := false
	if head.Branch != nil {
		if conflicts, err := git.HasConflicts(projectRoot, head.BaseBranch, *head.Branch); err == nil {
			mergeConflict = conflicts
		}
	}

	uncommittedChanges := false
	if head.Worktree != nil {
		if uncommitted, err := git.HasUncommittedChanges(*head.Worktree); err == nil {
			uncommittedChanges = uncommitted
		}
	}

	resp := api.DiffResponse{
		Files:              apiFiles,
		BaseRef:            baseRef,
		HeadRef:            headRef,
		MergeConflict:      &mergeConflict,
		UncommittedChanges: &uncommittedChanges,
		BaseCommit:         baseCommitInfo,
		HeadCommit:         headCommitInfo,
	}
	return api.GetAgentDiff200JSONResponse(resp), nil
}
