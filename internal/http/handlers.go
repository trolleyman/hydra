package http

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync/atomic"
	"time"

	"github.com/docker/docker/api/types/container"

	"braces.dev/errtrace"
	dockerclient "github.com/docker/docker/client"
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
	WorktreesDir    string
	ProjectRoot     string
	DefaultProject  projects.ProjectInfo
	ProjectsManager *projects.Manager
	DockerClient    *dockerclient.Client
	DB              *db.Store
	StartTime       time.Time
	Development     bool // set when running under mage dev / mage DevAutoReload

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

// NewHandler creates a handler with routing matching the OpenAPI spec.
func NewHandler(s *Server) http.Handler {
	opts := api.StrictHTTPServerOptions{
		ResponseErrorHandlerFunc: func(w http.ResponseWriter, r *http.Request, err error) {
			RecordError(r, err)
			code := http.StatusInternalServerError
			errType := api.InternalError
			var apiErr *apiError
			if errors.As(err, &apiErr) {
				code = apiErr.Code
				errType = apiErr.Type
			}
			api.WriteError(w, code, string(errType))
		},
	}
	strict := api.NewStrictHandlerWithOptions(s, nil, opts)
	return api.HandlerFromMux(strict, http.NewServeMux())
}

func (s *Server) GetDevToolsConfig(_ context.Context, _ api.GetDevToolsConfigRequestObject) (api.GetDevToolsConfigResponseObject, error) {
	if !s.Development {
		return api.GetDevToolsConfig403JSONResponse{
			Code:    403,
			Error:   "unauthorized",
			Details: "not in dev mode",
		}, nil
	}

	root := s.ProjectRoot
	uid := s.DefaultProject.UUID

	return api.GetDevToolsConfig200JSONResponse{
		Workspace: &struct {
			Root *string `json:"root,omitempty"`
			Uuid *string `json:"uuid,omitempty"`
		}{
			Root: &root,
			Uuid: &uid,
		},
	}, nil
}

// resolveProjectRoot returns the project root for the given project_id path param.
// Returns a 404 apiError if the project is not found.
func (s *Server) resolveProjectRoot(projectID string) (string, error) {
	p := s.ProjectsManager.GetByID(projectID)
	if p == nil {
		return "", errtrace.Wrap(&apiError{Code: 404, Type: api.NotFound, Err: fmt.Errorf("project not found: %s", projectID)})
	}
	norm, err := paths.NormalizePath(p.Path)
	if err != nil {
		return p.Path, nil
	}
	return norm, nil
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
			Uuid: p.UUID,
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
		return nil, errtrace.Wrap(err)
	}
	return api.AddProject201JSONResponse(api.ProjectInfo{
		Id:   p.ID,
		Path: p.Path,
		Name: p.Name,
		Uuid: p.UUID,
	}), nil
}

func (s *Server) ListAgents(ctx context.Context, request api.ListAgentsRequestObject) (api.ListAgentsResponseObject, error) {
	projectRoot, err := s.resolveProjectRoot(request.ProjectId)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	headList, err := heads.ListHeads(ctx, s.DockerClient, s.DB, projectRoot)
	if err != nil {
		errStr := err.Error()
		errorType := api.InternalError
		if dockerclient.IsErrConnectionFailed(err) || strings.Contains(errStr, "error during connect") {
			errorType = api.DockerConnect
			err = fmt.Errorf("Error connecting to Docker: %w", err)
		}

		return nil, errtrace.Wrap(&apiError{
			Code: 500,
			Type: errorType,
			Err:  err,
		})
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
	development := s.Development

	var dockerErr *string
	if lastErr := s.GetDockerError(); lastErr != "" {
		errStr := lastErr
		if strings.Contains(errStr, "error during connect") {
			errStr = "Error connecting to Docker: " + errStr
		}
		dockerErr = &errStr
	}

	terminalBashEnabled := false
	if cfg, err := config.Load(projectRoot); err == nil {
		terminalBashEnabled = cfg.Features.TerminalBash
	}

	return api.GetStatus200JSONResponse(api.StatusResponse{
		Status:           &status,
		DockerError:      dockerErr,
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
	}), nil
}

func (s *Server) GetConfig(_ context.Context, request api.GetConfigRequestObject) (api.GetConfigResponseObject, error) {
	projectRoot, err := s.resolveProjectRoot(request.ProjectId)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}

	var cfg config.Config
	if request.Params.Scope != nil {
		// Load only the raw config for the requested scope (not merged).
		var path string
		var err error
		if *request.Params.Scope == api.GetConfigParamsScopeUser {
			path, err = config.GetUserConfigPath()
			if err != nil {
				return nil, errtrace.Wrap(err)
			}
		} else {
			path = config.GetProjectConfigPath(projectRoot)
		}
		raw, err := config.LoadFile(path)
		if err != nil {
			return nil, errtrace.Wrap(err)
		}
		if raw != nil {
			cfg = *raw
		}
	} else {
		var err error
		cfg, err = config.Load(projectRoot)
		if err != nil {
			return nil, errtrace.Wrap(err)
		}
	}

	defaultDockerfiles := map[string]string{
		"base":    config.DefaultDockerfileBase,
		"claude":  config.DefaultDockerfileClaude,
		"copilot": config.DefaultDockerfileCopilot,
		"gemini":  config.DefaultDockerfileGemini,
		"bash":    config.DefaultDockerfileBash,
	}
	defaultPrePrompt := config.DefaultPrePrompt
	resp := api.ConfigResponse{
		Defaults: api.AgentConfig{
			Dockerfile:           cfg.Defaults.Dockerfile,
			DockerfileContents:   cfg.Defaults.DockerfileContents,
			DockerignoreContents: cfg.Defaults.DockerignoreContents,
			SharedMounts:         &cfg.Defaults.SharedMounts,
			Context:              cfg.Defaults.Context,
			PrePrompt:            cfg.Defaults.PrePrompt,
		},
		Agents: make(map[string]api.AgentConfig),
		Features: &struct {
			TerminalBash *bool `json:"terminal_bash,omitempty"`
		}{
			TerminalBash: &cfg.Features.TerminalBash,
		},
		DefaultDockerfiles: &defaultDockerfiles,
		DefaultPrePrompt:   &defaultPrePrompt,
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
	projectRoot, err := s.resolveProjectRoot(request.ProjectId)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}

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
	if request.Body.Features != nil && request.Body.Features.TerminalBash != nil {
		newCfg.Features.TerminalBash = *request.Body.Features.TerminalBash
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
			return nil, errtrace.Wrap(err)
		}
	} else {
		savePath = config.GetProjectConfigPath(projectRoot)
	}

	if err := config.SaveToFile(savePath, newCfg); err != nil {
		return nil, errtrace.Wrap(err)
	}

	return api.SaveConfig200Response{}, nil
}

func (s *Server) DevRestart(_ context.Context, _ api.DevRestartRequestObject) (api.DevRestartResponseObject, error) {
	if !s.Development {
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

	projectRoot, err := s.resolveProjectRoot(request.ProjectId)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
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
		return nil, errtrace.Wrap(err)
	}

	resolved := cfg.GetResolvedConfig(string(agentType))

	prePrompt := config.BuildFinalPrePrompt(cfg, string(agentType))
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
			return nil, errtrace.Wrap(fmt.Errorf("read dockerfile: %w", readErr))
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
		return nil, errtrace.Wrap(err)
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
	projectRoot, err := s.resolveProjectRoot(request.ProjectId)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	head, err := heads.GetHeadByID(ctx, s.DockerClient, s.DB, projectRoot, request.Id)
	if err != nil {
		return nil, errtrace.Wrap(err)
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
	projectRoot, err := s.resolveProjectRoot(request.ProjectId)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	head, err := heads.GetHeadByID(ctx, s.DockerClient, s.DB, projectRoot, request.Id)
	if err != nil {
		return nil, errtrace.Wrap(err)
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
			return nil, errtrace.Wrap(err)
		}
		if !ok {
			return api.MergeAgent409JSONResponse{
				Error:   "conflict",
				Code:    409,
				Details: "operation already in progress",
			}, nil
		}
	}

	if err := git.ValidateRef(branchName); err != nil {
		return nil, errtrace.Wrap(&apiError{Code: 400, Type: "bad_request", Err: err})
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
		return nil, errtrace.Wrap(err)
	}

	return api.MergeAgent204Response{}, nil
}

func (s *Server) UpdateAgentFromBase(ctx context.Context, request api.UpdateAgentFromBaseRequestObject) (api.UpdateAgentFromBaseResponseObject, error) {
	projectRoot, err := s.resolveProjectRoot(request.ProjectId)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	head, err := heads.GetHeadByID(ctx, s.DockerClient, s.DB, projectRoot, request.Id)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	if head == nil {
		return api.UpdateAgentFromBase404JSONResponse{
			Error:   "not_found",
			Code:    404,
			Details: "agent not found",
		}, nil
	}

	if head.Branch == nil {
		return nil, errtrace.Wrap(&apiError{
			Code: 500,
			Type: "bad_request",
			Err:  errors.New("agent has no git branch to update"),
		})
	}

	mergeDir := projectRoot
	if head.Worktree != nil {
		mergeDir = *head.Worktree
	}

	if err := git.ValidateRef(head.BaseBranch); err != nil {
		return nil, errtrace.Wrap(&apiError{Code: 400, Type: "bad_request", Err: err})
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
	projectRoot, err := s.resolveProjectRoot(request.ProjectId)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	head, err := heads.GetHeadByID(ctx, s.DockerClient, s.DB, projectRoot, request.Id)
	if err != nil {
		return nil, errtrace.Wrap(err)
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
		return nil, errtrace.Wrap(err)
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
		return nil, errtrace.Wrap(err)
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
	projectRoot, err := s.resolveProjectRoot(request.ProjectId)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	log.Printf("api: kill agent request: id=%q, project=%q", request.Id, projectRoot)
	head, err := heads.GetHeadByID(ctx, s.DockerClient, s.DB, projectRoot, request.Id)
	if err != nil {
		return nil, errtrace.Wrap(err)
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
		return nil, errtrace.Wrap(err)
	}

	return api.KillAgent204Response{}, nil
}

func (s *Server) GetAgentCommits(ctx context.Context, request api.GetAgentCommitsRequestObject) (api.GetAgentCommitsResponseObject, error) {
	projectRoot, err := s.resolveProjectRoot(request.ProjectId)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	head, err := heads.GetHeadByID(ctx, s.DockerClient, s.DB, projectRoot, request.Id)
	if err != nil {
		return nil, errtrace.Wrap(err)
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
		return nil, errtrace.Wrap(err)
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
	projectRoot, err := s.resolveProjectRoot(request.ProjectId)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	head, err := heads.GetHeadByID(ctx, s.DockerClient, s.DB, projectRoot, request.Id)
	if err != nil {
		return nil, errtrace.Wrap(err)
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

	path := ""
	if request.Params.Path != nil {
		path = *request.Params.Path
	}

	contextLines := 3
	if request.Params.Context != nil {
		contextLines = *request.Params.Context
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

	diffFiles, err := git.GetDiff(diffRoot, baseRef, headRef, ignoreWhitespace, useTripleDot, path, contextLines)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}

	// Append untracked files when including uncommitted changes.
	if includeUncommitted && head.Worktree != nil {
		if untrackedDiffs, err := git.GetUntrackedDiff(*head.Worktree, path, contextLines); err == nil {
			diffFiles = append(diffFiles, untrackedDiffs...)
		}
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
	var uncommittedSummary *api.UncommittedSummary
	if head.Worktree != nil {
		if summary, err := git.GetUncommittedSummary(*head.Worktree); err == nil {
			uncommittedChanges = summary.TrackedCount > 0 || summary.UntrackedCount > 0
			uncommittedSummary = &api.UncommittedSummary{
				TrackedCount:   summary.TrackedCount,
				UntrackedCount: summary.UntrackedCount,
			}
		}
	}

	var conflictFiles *[]string
	if mergeConflict && head.Branch != nil {
		if files, err := git.GetConflictingFiles(projectRoot, head.BaseBranch, *head.Branch); err == nil && len(files) > 0 {
			conflictFiles = &files
		}
	}

	resp := api.DiffResponse{
		Files:              apiFiles,
		BaseRef:            baseRef,
		HeadRef:            headRef,
		MergeConflict:      &mergeConflict,
		ConflictFiles:      conflictFiles,
		UncommittedChanges: &uncommittedChanges,
		UncommittedSummary: uncommittedSummary,
		BaseCommit:         baseCommitInfo,
		HeadCommit:         headCommitInfo,
	}
	return api.GetAgentDiff200JSONResponse(resp), nil
}

func (s *Server) GetAgentDiffFiles(ctx context.Context, request api.GetAgentDiffFilesRequestObject) (api.GetAgentDiffFilesResponseObject, error) {
	projectRoot, err := s.resolveProjectRoot(request.ProjectId)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	head, err := heads.GetHeadByID(ctx, s.DockerClient, s.DB, projectRoot, request.Id)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	if head == nil {
		return api.GetAgentDiffFiles404JSONResponse{
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
		return api.GetAgentDiffFiles200JSONResponse(empty), nil
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

	includeUncommitted := false
	if request.Params.IncludeUncommitted != nil {
		includeUncommitted = *request.Params.IncludeUncommitted
	}

	useTripleDot := (request.Params.BaseRef == nil || *request.Params.BaseRef == "") &&
		(request.Params.HeadRef == nil || *request.Params.HeadRef == "") &&
		!includeUncommitted

	diffRoot := projectRoot
	if includeUncommitted && head.Worktree != nil {
		diffRoot = *head.Worktree
		if (request.Params.BaseRef == nil || *request.Params.BaseRef == "") &&
			(request.Params.HeadRef == nil || *request.Params.HeadRef == "") {
			if mb, err := git.GetMergeBase(diffRoot, baseRef, "HEAD"); err == nil {
				baseRef = mb
				headRef = ""
				useTripleDot = false
			}
		} else if headRef == headBranch {
			headRef = ""
			useTripleDot = false
		}
	}

	diffFiles, err := git.GetDiffFiles(diffRoot, baseRef, headRef, useTripleDot)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}

	// Append untracked files when including uncommitted changes.
	if includeUncommitted && head.Worktree != nil {
		if untrackedFiles, err := git.GetUntrackedDiffFiles(*head.Worktree); err == nil {
			diffFiles = append(diffFiles, untrackedFiles...)
		}
	}

	apiFiles := make([]api.DiffFile, len(diffFiles))
	for i, f := range diffFiles {
		apiFiles[i] = api.DiffFile{
			Path:       f.Path,
			OldPath:    f.OldPath,
			ChangeType: api.DiffFileChangeType(f.ChangeType),
			Additions:  f.Additions,
			Deletions:  f.Deletions,
		}
	}

	mergeConflict := false
	if head.Branch != nil {
		if conflicts, err := git.HasConflicts(projectRoot, head.BaseBranch, *head.Branch); err == nil {
			mergeConflict = conflicts
		}
	}

	uncommittedChanges := false
	var uncommittedSummary *api.UncommittedSummary
	if head.Worktree != nil {
		if summary, err := git.GetUncommittedSummary(*head.Worktree); err == nil {
			uncommittedChanges = summary.TrackedCount > 0 || summary.UntrackedCount > 0
			uncommittedSummary = &api.UncommittedSummary{
				TrackedCount:   summary.TrackedCount,
				UntrackedCount: summary.UntrackedCount,
			}
		}
	}

	var conflictFiles *[]string
	if mergeConflict && head.Branch != nil {
		if files, err := git.GetConflictingFiles(projectRoot, head.BaseBranch, *head.Branch); err == nil && len(files) > 0 {
			conflictFiles = &files
		}
	}

	resp := api.DiffResponse{
		Files:              apiFiles,
		BaseRef:            baseRef,
		HeadRef:            headRef,
		MergeConflict:      &mergeConflict,
		ConflictFiles:      conflictFiles,
		UncommittedChanges: &uncommittedChanges,
		UncommittedSummary: uncommittedSummary,
	}
	return api.GetAgentDiffFiles200JSONResponse(resp), nil
}

func (s *Server) CleanBuildCache(ctx context.Context, request api.CleanBuildCacheRequestObject) (api.CleanBuildCacheResponseObject, error) {
	_, err := s.resolveProjectRoot(request.ProjectId)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}

	var agentType docker.AgentType
	if request.Params.AgentType != nil && *request.Params.AgentType != "" {
		agentType = docker.AgentType(*request.Params.AgentType)
	}

	if err := docker.CleanBuildCache(ctx, s.DockerClient, agentType); err != nil {
		return nil, errtrace.Wrap(err)
	}

	return api.CleanBuildCache204Response{}, nil
}

func (s *Server) SendAgentInput(ctx context.Context, request api.SendAgentInputRequestObject) (api.SendAgentInputResponseObject, error) {
	projectRoot, err := s.resolveProjectRoot(request.ProjectId)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	head, err := heads.GetHeadByID(ctx, s.DockerClient, s.DB, projectRoot, request.Id)
	if err != nil {
		return api.SendAgentInput500JSONResponse{
			Code:    500,
			Error:   "internal_error",
			Details: err.Error(),
		}, nil
	}
	if head == nil || head.ContainerID == "" {
		return api.SendAgentInput404JSONResponse{
			Code:    404,
			Error:   "not_found",
			Details: "agent not found or not running",
		}, nil
	}

	text := request.Body.Text + "\r"

	attach, err := s.DockerClient.ContainerAttach(ctx, head.ContainerID, container.AttachOptions{
		Stream: true,
		Stdin:  true,
		Stdout: false,
		Stderr: false,
	})
	if err != nil {
		return api.SendAgentInput500JSONResponse{
			Code:    500,
			Error:   "internal_error",
			Details: "failed to attach to container: " + err.Error(),
		}, nil
	}
	defer attach.Close()

	if _, err := attach.Conn.Write([]byte(text)); err != nil {
		return api.SendAgentInput500JSONResponse{
			Code:    500,
			Error:   "internal_error",
			Details: "failed to write to container stdin: " + err.Error(),
		}, nil
	}

	return api.SendAgentInput200Response{}, nil
}
