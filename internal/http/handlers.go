package http

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"

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
	WorktreesDir      string
	ProjectRoot       string
	DefaultProject    projects.ProjectInfo
	ProjectsManager   *projects.Manager
	DockerClient      *dockerclient.Client
	DB                *db.Store
	StartTime         time.Time
	DevRestartEnabled bool // set when running under mage dev / mage DevAutoReload
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
	headList, err := heads.ListHeads(ctx, s.DockerClient, s.DB, projectRoot)
	if err != nil {
		code := 500
		msg := err.Error()
		return api.ListAgents500JSONResponse{Code: code, Error: msg}, nil
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
	return api.GetStatus200JSONResponse(api.StatusResponse{
		Status:              &status,
		Version:             &v,
		UptimeSeconds:       &uptime,
		ProjectRoot:         &projectRoot,
		DefaultProjectId:    &defaultProjectID,
		DevRestartAvailable: &devRestartAvailable,
	}), nil
}

func (s *Server) GetConfig(_ context.Context, request api.GetConfigRequestObject) (api.GetConfigResponseObject, error) {
	projectRoot := s.resolveProjectRoot(request.Params.ProjectId)
	cfg, err := config.Load(projectRoot)
	if err != nil {
		return api.GetConfig500JSONResponse{Code: 500, Error: err.Error()}, nil
	}

	resp := api.ConfigResponse{
		Defaults: api.AgentConfig{
			Dockerfile:         cfg.Defaults.Dockerfile,
			DockerfileContents: cfg.Defaults.DockerfileContents,
			Context:            cfg.Defaults.Context,
			PrePrompt:          cfg.Defaults.PrePrompt,
		},
		Agents: make(map[string]api.AgentConfig),
	}

	for name, agent := range cfg.Agents {
		resp.Agents[name] = api.AgentConfig{
			Dockerfile:         agent.Dockerfile,
			DockerfileContents: agent.DockerfileContents,
			Context:            agent.Context,
			PrePrompt:          agent.PrePrompt,
		}
	}

	return api.GetConfig200JSONResponse(resp), nil
}

func (s *Server) SaveConfig(_ context.Context, request api.SaveConfigRequestObject) (api.SaveConfigResponseObject, error) {
	projectRoot := s.resolveProjectRoot(request.Params.ProjectId)

	newCfg := config.Config{
		Defaults: config.AgentConfig{
			Dockerfile:         request.Body.Defaults.Dockerfile,
			DockerfileContents: request.Body.Defaults.DockerfileContents,
			Context:            request.Body.Defaults.Context,
			PrePrompt:          request.Body.Defaults.PrePrompt,
		},
		Agents: make(map[string]config.AgentConfig),
	}
	for name, agent := range request.Body.Agents {
		newCfg.Agents[name] = config.AgentConfig{
			Dockerfile:         agent.Dockerfile,
			DockerfileContents: agent.DockerfileContents,
			Context:            agent.Context,
			PrePrompt:          agent.PrePrompt,
		}
	}

	scope := api.Project
	if request.Params.Scope != nil {
		scope = *request.Params.Scope
	}

	var savePath string
	if scope == api.User {
		var err error
		savePath, err = config.GetUserConfigPath()
		if err != nil {
			return api.SaveConfig500JSONResponse{Code: 500, Error: err.Error()}, nil
		}
	} else {
		savePath = config.GetProjectConfigPath(projectRoot)
	}

	if err := config.SaveToFile(savePath, newCfg); err != nil {
		return api.SaveConfig500JSONResponse{Code: 500, Error: err.Error()}, nil
	}

	return api.SaveConfig200Response{}, nil
}

func (s *Server) DevRestart(_ context.Context, _ api.DevRestartRequestObject) (api.DevRestartResponseObject, error) {
	if !s.DevRestartEnabled {
		code := 403
		return api.DevRestart403JSONResponse{Code: code, Error: "not in dev mode"}, nil
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
		code := 400
		msg := "request body is required"
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
	if resolved.Dockerfile != nil {
		dockerfilePath = *resolved.Dockerfile
	}
	if resolved.DockerfileContents != nil {
		dockerfileContents = *resolved.DockerfileContents
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

	ephemeral := false
	if request.Body.Ephemeral != nil {
		ephemeral = *request.Body.Ephemeral
	}

	head, err := heads.SpawnHead(ctx, s.DockerClient, s.DB, projectRoot, heads.SpawnHeadOptions{
		ID:                 id,
		PrePrompt:          prePrompt,
		Prompt:             prompt,
		AgentType:          agentType,
		BaseBranch:         baseBranch,
		DockerfilePath:     dockerfilePath,
		DockerfileContents: dockerfileContents,
		Ephemeral:          ephemeral,
	})
	if err != nil {
		code := 500
		msg := err.Error()
		return api.SpawnAgent500JSONResponse{Code: code, Error: msg}, nil
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
		Prompt:          head.Prompt,
		BaseBranch:      head.BaseBranch,
		CreatedAt:       spawnCreatedAt,
		AgentStatus:     head.AgentStatus,
	}), nil
}

func (s *Server) GetAgent(ctx context.Context, request api.GetAgentRequestObject) (api.GetAgentResponseObject, error) {
	projectRoot := s.resolveProjectRoot(request.Params.ProjectId)
	head, err := heads.GetHeadByID(ctx, s.DockerClient, s.DB, projectRoot, request.Id)
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
		CreatedAt:       getCreatedAt,
		AgentStatus:     head.AgentStatus,
	}), nil
}

func (s *Server) MergeAgent(ctx context.Context, request api.MergeAgentRequestObject) (api.MergeAgentResponseObject, error) {
	projectRoot := s.resolveProjectRoot(request.Params.ProjectId)
	head, err := heads.GetHeadByID(ctx, s.DockerClient, s.DB, projectRoot, request.Id)
	if err != nil {
		code := 500
		msg := err.Error()
		return api.MergeAgent500JSONResponse{Code: code, Error: msg}, nil
	}
	if head == nil {
		code := 404
		msg := "agent not found"
		return api.MergeAgent404JSONResponse{Code: code, Error: msg}, nil
	}

	if head.Branch == nil {
		code := 400
		msg := "agent has no git branch to merge"
		return api.MergeAgent400JSONResponse{Code: code, Error: msg}, nil
	}
	branchName := *head.Branch

	// Atomically claim the merge operation.
	if s.DB != nil {
		ok, err := s.DB.TrySetHeadStatus(head.ID, "idle", "merging")
		if err != nil {
			code := 500
			msg := err.Error()
			return api.MergeAgent500JSONResponse{Code: code, Error: msg}, nil
		}
		if !ok {
			code := 409
			msg := "operation already in progress"
			return api.MergeAgent409JSONResponse{Code: code, Error: msg}, nil
		}
	}

	var stderr bytes.Buffer
	gitMergeCmd := exec.CommandContext(ctx, "git", "-C", projectRoot, "merge", branchName)
	gitMergeCmd.Stderr = &stderr
	if err := gitMergeCmd.Run(); err != nil {
		if s.DB != nil {
			errMsg := fmt.Sprintf("git merge failed: %s", strings.TrimSpace(stderr.String()))
			_ = s.DB.ClearHeadStatus(head.ID, &errMsg)
		}
		code := 500
		msg := fmt.Sprintf("git merge failed: %s", strings.TrimSpace(stderr.String()))
		return api.MergeAgent500JSONResponse{Code: code, Error: msg}, nil
	}

	// Kill cleanup without re-doing the CAS (already in "merging" state).
	if err := heads.KillHeadNoLock(ctx, s.DockerClient, s.DB, *head); err != nil {
		code := 500
		msg := err.Error()
		return api.MergeAgent500JSONResponse{Code: code, Error: msg}, nil
	}

	return api.MergeAgent204Response{}, nil
}

func (s *Server) RestartAgent(ctx context.Context, request api.RestartAgentRequestObject) (api.RestartAgentResponseObject, error) {
	projectRoot := s.resolveProjectRoot(request.Params.ProjectId)
	head, err := heads.GetHeadByID(ctx, s.DockerClient, s.DB, projectRoot, request.Id)
	if err != nil {
		code := 500
		msg := err.Error()
		return api.RestartAgent500JSONResponse{Code: code, Error: msg}, nil
	}
	if head == nil {
		code := 404
		msg := "agent not found"
		return api.RestartAgent404JSONResponse{Code: code, Error: msg}, nil
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
			code := 409
			msg := "operation already in progress"
			return api.RestartAgent409JSONResponse{Code: code, Error: msg}, nil
		}
		code := 500
		msg := err.Error()
		return api.RestartAgent500JSONResponse{Code: code, Error: msg}, nil
	}

	// Resolve dockerfile from config (same as SpawnAgent).
	dockerfilePath := ""
	dockerfileContents := ""
	if cfg, cfgErr := config.Load(projectRoot); cfgErr == nil {
		resolved := cfg.GetResolvedConfig(string(agentType))
		if resolved.Dockerfile != nil {
			dockerfilePath = *resolved.Dockerfile
		}
		if resolved.DockerfileContents != nil {
			dockerfileContents = *resolved.DockerfileContents
		}
		// Override pre_prompt from config if we didn't already have one stored.
		if prePrompt == "" && resolved.PrePrompt != nil {
			prePrompt = *resolved.PrePrompt
		}
	}

	newHead, err := heads.SpawnHead(ctx, s.DockerClient, s.DB, projectRoot, heads.SpawnHeadOptions{
		ID:                 id,
		PrePrompt:          prePrompt,
		Prompt:             prompt,
		AgentType:          agentType,
		BaseBranch:         baseBranch,
		DockerfilePath:     dockerfilePath,
		DockerfileContents: dockerfileContents,
	})
	if err != nil {
		code := 500
		msg := err.Error()
		return api.RestartAgent500JSONResponse{Code: code, Error: msg}, nil
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
		CreatedAt:       restartCreatedAt,
		AgentStatus:     newHead.AgentStatus,
	}), nil
}

func (s *Server) KillAgent(ctx context.Context, request api.KillAgentRequestObject) (api.KillAgentResponseObject, error) {
	projectRoot := s.resolveProjectRoot(request.Params.ProjectId)
	head, err := heads.GetHeadByID(ctx, s.DockerClient, s.DB, projectRoot, request.Id)
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

	if err := heads.KillHead(ctx, s.DockerClient, s.DB, *head); err != nil {
		if errors.Is(err, db.ErrOperationInProgress) {
			code := 409
			msg := "operation already in progress"
			return api.KillAgent409JSONResponse{Code: code, Error: msg}, nil
		}
		code := 500
		msg := err.Error()
		return api.KillAgent500JSONResponse{Code: code, Error: msg}, nil
	}

	return api.KillAgent204Response{}, nil
}

func (s *Server) GetAgentCommits(ctx context.Context, request api.GetAgentCommitsRequestObject) (api.GetAgentCommitsResponseObject, error) {
	projectRoot := s.resolveProjectRoot(request.Params.ProjectId)
	head, err := heads.GetHeadByID(ctx, s.DockerClient, s.DB, projectRoot, request.Id)
	if err != nil {
		code := 500
		msg := err.Error()
		return api.GetAgentCommits500JSONResponse{Code: code, Error: msg}, nil
	}
	if head == nil {
		code := 404
		msg := "agent not found"
		return api.GetAgentCommits404JSONResponse{Code: code, Error: msg}, nil
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
		code := 500
		msg := err.Error()
		return api.GetAgentCommits500JSONResponse{Code: code, Error: msg}, nil
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
		code := 500
		msg := err.Error()
		return api.GetAgentDiff500JSONResponse{Code: code, Error: msg}, nil
	}
	if head == nil {
		code := 404
		msg := "agent not found"
		return api.GetAgentDiff404JSONResponse{Code: code, Error: msg}, nil
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

	// Use triple-dot (merge-base) diff when using default branch refs (whole MR view).
	// Use double-dot when specific commits are given (commit-to-commit view).
	useTripleDot := (request.Params.BaseRef == nil || *request.Params.BaseRef == "") &&
		(request.Params.HeadRef == nil || *request.Params.HeadRef == "")

	diffFiles, err := git.GetDiff(projectRoot, baseRef, headRef, ignoreWhitespace, useTripleDot)
	if err != nil {
		code := 500
		msg := err.Error()
		return api.GetAgentDiff500JSONResponse{Code: code, Error: msg}, nil
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

	resp := api.DiffResponse{
		Files:      apiFiles,
		BaseRef:    baseRef,
		HeadRef:    headRef,
		BaseCommit: baseCommitInfo,
		HeadCommit: headCommitInfo,
	}
	return api.GetAgentDiff200JSONResponse(resp), nil
}
