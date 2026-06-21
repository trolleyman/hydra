package http

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/artifacts"
	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/db"
	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/heads"
	"github.com/trolleyman/hydra/internal/paths"
	"github.com/trolleyman/hydra/internal/projects"
	"github.com/trolleyman/hydra/internal/sandbox"
	"github.com/trolleyman/hydra/internal/services"
	"github.com/trolleyman/hydra/internal/session"
	"github.com/trolleyman/hydra/internal/usage"
)

const version = "0.1.0"

// gitConfigVal reads a single git config value for the repo at dir.
func gitConfigVal(dir, key string) string {
	out, err := exec.Command("git", "-C", dir, "config", "--get", key).Output()
	if err != nil {
		return ""
	}
	return strings.TrimRight(string(out), "\n")
}

// devRestartExitCode is the process exit code that signals mage to rebuild and restart.
const devRestartExitCode = 42

// Server implements StrictServerInterface.
type Server struct {
	WorktreesDir    string
	ProjectRoot     string
	DefaultProject  projects.ProjectInfo
	ProjectsManager *projects.Manager
	Sessions        *session.Registry
	DB              *db.Store
	StartTime       time.Time
	Development     bool // set when running under mage dev / mage DevAutoReload
	// BackgroundCtx is the server-lifetime context (cancelled on shutdown). It's
	// handed to detached best-effort work started by a request — e.g. async title
	// refinement — so that work outlives the request but still dies on shutdown.
	BackgroundCtx context.Context
	// Artifacts generates/caches diff artifacts (screenshots etc.), one Manager
	// per registered project (resolved per request). nil disables the feature.
	Artifacts *artifacts.Registry

	// Services supervises each project's [[services]] (long-running host/sandbox
	// commands, e.g. an emulator pool). nil disables the feature (e.g. in tests).
	Services *services.Manager

	lastSandboxError atomic.Value // holds string

	// claudeUsage caches the account-global Claude Code usage snapshot, lazily
	// initialised on first request (the probe is host-account-wide, so it's not
	// scoped per project).
	claudeUsageOnce sync.Once
	claudeUsage     *usage.Cache

	// Memoise git history reads keyed by resolved commit SHAs. Commits are
	// immutable, so the commit list and committed diff between a fixed pair of SHAs
	// never change — repeated reads (e.g. a terminal-WS reconnect re-loading the
	// diff/commits panels) can be served without re-invoking git. Only committed
	// state is cached; the uncommitted/working-tree diff is always recomputed live.
	commitsCache immutableCache[[]git.CommitInfo]
	diffCache    immutableCache[[]git.DiffFile]
}

// claudeUsageTTL is how long a probed usage snapshot is served before re-probing.
const claudeUsageTTL = 30 * time.Second

// claudeUsageEnabled gates the /api/usage/claude probe. Disabled for now: the
// probe drives `claude /usage` under a PTY (up to ~20s) and a never-settling TUI
// could spike CPU / make the daemon feel stuck. When disabled the endpoint still
// responds, but reports "unavailable" without probing, so the UI indicator just
// hides. Flip back to true to re-enable.
const claudeUsageEnabled = false

// claudeUsageCache returns the lazily-created usage cache. The probe runs the
// host `claude` CLI in the default project root (a directory the user's real
// Claude is most likely to already trust); the probe also auto-accepts the
// trust prompt, so an untrusted dir still works without mutating ~/.claude.json.
func (s *Server) claudeUsageCache() *usage.Cache {
	s.claudeUsageOnce.Do(func() {
		root := s.ProjectRoot
		s.claudeUsage = usage.NewCache(claudeUsageTTL, func(ctx context.Context) (usage.Snapshot, error) {
			return usage.Probe(ctx, "claude", root, usage.HostEnv())
		})
	})
	return s.claudeUsage
}

// SetSandboxError records the most recent sandbox-availability error (or clears
// it when err is nil). Surfaced via GetStatus as sandbox_error.
func (s *Server) SetSandboxError(err error) {
	if err == nil {
		s.lastSandboxError.Store("")
	} else {
		s.lastSandboxError.Store(err.Error())
	}
}

func (s *Server) GetSandboxError() string {
	v := s.lastSandboxError.Load()
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
			errType := api.ErrorResponseErrorInternalError
			details := err.Error()
			var apiErr *apiError
			if errors.As(err, &apiErr) {
				code = apiErr.Code
				errType = apiErr.Type
				details = apiErr.Err.Error()
			}
			api.WriteErrorDetails(w, code, string(errType), details)
		},
	}
	strict := api.NewStrictHandlerWithOptions(s, nil, opts)
	return api.HandlerFromMux(strict, http.NewServeMux())
}

func (s *Server) GetDevToolsConfig(_ context.Context, _ api.GetDevToolsConfigRequestObject) (api.GetDevToolsConfigResponseObject, error) {
	if !s.Development {
		return api.GetDevToolsConfig403JSONResponse{
			Code:    403,
			Error:   api.ErrorResponseErrorUnauthorized,
			Details: "not in dev mode",
		}, nil
	}

	root := s.ProjectRoot
	uid, err := projects.GetOrCreateInstanceUUID()
	if err != nil {
		return nil, errtrace.Wrap(err)
	}

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
		return "", &apiError{Code: 404, Type: api.ErrorResponseErrorNotFound, Err: fmt.Errorf("project not found: %s", projectID)} //errtrace:skip
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
	// One DB query gives unread counts for every project; missing keys mean zero.
	unread, err := s.DB.CountUnreadByProject()
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	resp := make(api.ListProjects200JSONResponse, len(ps))
	for i, p := range ps {
		count := unread[p.Path]
		resp[i] = api.ProjectInfo{
			Id:          p.ID,
			Path:        p.Path,
			Name:        p.Name,
			UnreadCount: &count,
		}
	}
	return resp, nil
}

func (s *Server) AddProject(_ context.Context, request api.AddProjectRequestObject) (api.AddProjectResponseObject, error) {
	if request.Body == nil || strings.TrimSpace(request.Body.Path) == "" {
		return api.AddProject400JSONResponse{
			Code:    400,
			Error:   api.ErrorResponseErrorBadRequest,
			Details: "path is required",
		}, nil
	}

	projectPath := strings.TrimSpace(request.Body.Path)

	// Handle create_if_missing
	if request.Body.CreateIfMissing != nil && *request.Body.CreateIfMissing {
		if _, err := os.Stat(projectPath); os.IsNotExist(err) {
			if err := os.MkdirAll(projectPath, 0755); err != nil {
				return api.AddProject500JSONResponse{
					Code:    500,
					Error:   api.ErrorResponseErrorInternalError,
					Details: "failed to create directory: " + err.Error(),
				}, nil
			}
		}
	} else {
		// If create_if_missing is not set, check if the directory exists.
		if _, err := os.Stat(projectPath); os.IsNotExist(err) {
			return api.AddProject400JSONResponse{
				Code:    400,
				Error:   api.ErrorResponseErrorPathNotFound,
				Details: "directory does not exist: " + projectPath,
			}, nil
		}
	}

	// Handle init_git
	if request.Body.InitGit != nil && *request.Body.InitGit {
		// Only init if it's not already a git repo.
		if _, err := paths.GetProjectRoot(projectPath); err != nil {
			// Not a git repo or directory doesn't exist (but we might have just created it)
			err := exec.Command("git", "init", projectPath).Run()
			if err != nil {
				return api.AddProject500JSONResponse{
					Code:    500,
					Error:   api.ErrorResponseErrorInternalError,
					Details: "git init failed: " + err.Error(),
				}, nil
			}
		}
	}

	// Validate it's a git repository.
	if _, err := paths.GetProjectRoot(projectPath); err != nil {
		return api.AddProject400JSONResponse{
			Code:    400,
			Error:   api.ErrorResponseErrorNotAGitRepo,
			Details: "path is not a git repository: " + err.Error(),
		}, nil
	}

	p, err := s.ProjectsManager.AddProject(projectPath)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	// Start the newly-added project's [[services]] (no-op if it declares none).
	if s.Services != nil {
		s.Services.StartProject(p.Path)
	}
	return api.AddProject201JSONResponse(api.ProjectInfo{
		Id:   p.ID,
		Path: p.Path,
		Name: p.Name,
	}), nil
}

func (s *Server) GetProjectConfigToml(_ context.Context, request api.GetProjectConfigTomlRequestObject) (api.GetProjectConfigTomlResponseObject, error) {
	p := s.ProjectsManager.GetByID(request.ProjectId)
	if p == nil {
		return api.GetProjectConfigToml404JSONResponse{
			Code:    404,
			Error:   api.ErrorResponseErrorNotFound,
			Details: "project not found",
		}, nil
	}
	content, exists, err := config.ReadProjectConfigTOML(p.Path)
	if err != nil {
		return api.GetProjectConfigToml500JSONResponse{
			Code:    500,
			Error:   api.ErrorResponseErrorInternalError,
			Details: err.Error(),
		}, nil
	}
	return api.GetProjectConfigToml200JSONResponse(api.ConfigTomlResponse{
		Content: string(content),
		Exists:  exists,
	}), nil
}

func (s *Server) RemoveProject(_ context.Context, request api.RemoveProjectRequestObject) (api.RemoveProjectResponseObject, error) {
	// Resolve the path before removal so we can stop its services afterwards.
	var removedPath string
	if p := s.ProjectsManager.GetByID(request.ProjectId); p != nil {
		removedPath = p.Path
	}
	found, err := s.ProjectsManager.RemoveProject(request.ProjectId)
	if err != nil {
		return api.RemoveProject500JSONResponse{
			Code:    500,
			Error:   api.ErrorResponseErrorInternalError,
			Details: err.Error(),
		}, nil
	}
	if !found {
		return api.RemoveProject404JSONResponse{
			Code:    404,
			Error:   api.ErrorResponseErrorNotFound,
			Details: "project not found",
		}, nil
	}
	// Tear down the removed project's [[services]].
	if s.Services != nil && removedPath != "" {
		s.Services.StopProject(removedPath)
	}
	return api.RemoveProject204Response{}, nil
}

// agentResponse converts a heads.Head into its API representation. Centralised
// so every endpoint returns an identically-shaped agent (id, title, status, …).
func agentResponse(h heads.Head) api.AgentResponse {
	var createdAt *int64
	if h.CreatedAt != 0 {
		createdAt = &h.CreatedAt
	}
	title := h.Title
	archived := h.Archived
	var endState *string
	if h.EndState != "" {
		es := h.EndState
		endState = &es
	}
	return api.AgentResponse{
		Id:               h.ID,
		Title:            &title,
		BranchName:       h.Branch,
		WorktreePath:     h.Worktree,
		ProjectPath:      h.ProjectPath,
		SessionPid:       h.SessionPID,
		SessionStatus:    h.SessionStatus,
		AgentType:        string(h.AgentType),
		PrePrompt:        h.PrePrompt,
		Prompt:           h.Prompt,
		BaseBranch:       h.BaseBranch,
		Ephemeral:        &h.Ephemeral,
		CreatedAt:        createdAt,
		AgentStatus:      h.AgentStatus,
		HasUnreadChanges: &h.HasUnreadChanges,
		Archived:         &archived,
		EndState:         endState,
	}
}

func (s *Server) ListAgents(ctx context.Context, request api.ListAgentsRequestObject) (api.ListAgentsResponseObject, error) {
	projectRoot, err := s.resolveProjectRoot(request.ProjectId)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	headList, err := heads.ListHeads(ctx, s.Sessions, s.DB, projectRoot)
	if err != nil {
		return nil, &apiError{ //errtrace:skip
			Code: 500,
			Type: api.ErrorResponseErrorInternalError,
			Err:  err,
		}
	}
	resp := make(api.ListAgents200JSONResponse, len(headList))
	for i, h := range headList {
		resp[i] = agentResponse(h)
	}
	return resp, nil
}

func (s *Server) ListArchivedAgents(_ context.Context, request api.ListArchivedAgentsRequestObject) (api.ListArchivedAgentsResponseObject, error) {
	projectRoot, err := s.resolveProjectRoot(request.ProjectId)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	limit, offset := 0, 0
	if request.Params.Limit != nil {
		limit = *request.Params.Limit
	}
	if request.Params.Offset != nil && *request.Params.Offset > 0 {
		offset = *request.Params.Offset
	}
	headList, err := heads.ListArchivedHeads(s.DB, projectRoot, limit, offset)
	if err != nil {
		return nil, &apiError{ //errtrace:skip
			Code: 500,
			Type: api.ErrorResponseErrorInternalError,
			Err:  err,
		}
	}
	resp := make(api.ListArchivedAgents200JSONResponse, len(headList))
	for i, h := range headList {
		resp[i] = agentResponse(h)
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

	var sandboxErr *string
	if lastErr := s.GetSandboxError(); lastErr != "" {
		errStr := lastErr
		sandboxErr = &errStr
	}

	return api.GetStatus200JSONResponse(api.StatusResponse{
		Status:           &status,
		SandboxError:     sandboxErr,
		Version:          &v,
		UptimeSeconds:    &uptime,
		ProjectRoot:      &projectRoot,
		DefaultProjectId: &defaultProjectID,
		Development:      &development,
	}), nil
}

func (s *Server) GetClaudeUsage(ctx context.Context, request api.GetClaudeUsageRequestObject) (api.GetClaudeUsageResponseObject, error) {
	if !claudeUsageEnabled {
		// Probe disabled: respond without spawning `claude /usage`. Reported as
		// unavailable so the frontend indicator quietly hides.
		msg := "Claude usage probe is disabled"
		return api.GetClaudeUsage200JSONResponse(api.ClaudeUsageResponse{
			Available: false,
			Error:     &msg,
		}), nil
	}

	force := request.Params.Refresh != nil && *request.Params.Refresh
	snap, err := s.claudeUsageCache().Get(ctx, force)
	if err != nil {
		// No snapshot at all (CLI never produced one): report unavailable rather
		// than 500, so the indicator can quietly hide.
		msg := err.Error()
		return api.GetClaudeUsage200JSONResponse(api.ClaudeUsageResponse{
			Available: false,
			Error:     &msg,
		}), nil
	}

	resp := api.ClaudeUsageResponse{Available: snap.Available}
	if snap.Error != "" {
		e := snap.Error
		resp.Error = &e
	}
	if !snap.CapturedAt.IsZero() {
		t := snap.CapturedAt
		resp.CapturedAt = &t
	}
	if snap.AccountTier != "" {
		tier := snap.AccountTier
		resp.AccountTier = &tier
	}
	resp.SessionPercentUsed = f64ToF32(snap.SessionPercentUsed)
	resp.SessionResetsAt = snap.SessionResetsAt
	if snap.SessionResetText != "" {
		txt := snap.SessionResetText
		resp.SessionResetText = &txt
	}
	resp.WeeklyPercentUsed = f64ToF32(snap.WeeklyPercentUsed)
	if snap.WeeklyResetText != "" {
		txt := snap.WeeklyResetText
		resp.WeeklyResetText = &txt
	}
	return api.GetClaudeUsage200JSONResponse(resp), nil
}

// f64ToF32 converts an optional float64 to an optional float32 for the API.
func f64ToF32(v *float64) *float32 {
	if v == nil {
		return nil
	}
	f := float32(*v)
	return &f
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

	defaultPrePrompt := config.DefaultPrePrompt
	resp := api.ConfigResponse{
		Defaults:         toAPIAgentConfig(cfg.Defaults),
		Agents:           make(map[string]api.AgentConfig),
		DefaultPrePrompt: &defaultPrePrompt,
	}

	for name, agent := range cfg.Agents {
		resp.Agents[name] = toAPIAgentConfig(agent)
	}

	if len(cfg.Artifacts) > 0 {
		arts := make([]api.ArtifactScript, len(cfg.Artifacts))
		for i, a := range cfg.Artifacts {
			arts[i] = toAPIArtifactScript(a)
		}
		resp.Artifacts = &arts
	}

	if len(cfg.Services) > 0 {
		svcs := make([]api.ServiceScript, len(cfg.Services))
		for i, svc := range cfg.Services {
			svcs[i] = toAPIServiceScript(svc)
		}
		resp.Services = &svcs
	}

	return api.GetConfig200JSONResponse(resp), nil
}

// toAPIArtifactScript converts an internal ArtifactScript to the API representation.
func toAPIArtifactScript(a config.ArtifactScript) api.ArtifactScript {
	out := api.ArtifactScript{Name: a.Name, Command: a.Command}
	if a.TimeoutSec != 0 {
		out.TimeoutSec = &a.TimeoutSec
	}
	if a.UnsafeHost {
		out.UnsafeHost = &a.UnsafeHost
	}
	out.Enabled = a.Enabled
	return out
}

// fromAPIArtifactScript converts an API ArtifactScript to the internal representation.
func fromAPIArtifactScript(a api.ArtifactScript) config.ArtifactScript {
	out := config.ArtifactScript{Name: a.Name, Command: a.Command}
	if a.TimeoutSec != nil {
		out.TimeoutSec = *a.TimeoutSec
	}
	if a.UnsafeHost != nil {
		out.UnsafeHost = *a.UnsafeHost
	}
	out.Enabled = a.Enabled
	return out
}

// toAPIServiceScript converts an internal ServiceScript to the API representation.
func toAPIServiceScript(svc config.ServiceScript) api.ServiceScript {
	out := api.ServiceScript{Name: svc.Name, Command: svc.Command}
	if svc.Host {
		out.Host = &svc.Host
	}
	out.MaxRestarts = svc.MaxRestarts
	out.Enabled = svc.Enabled
	return out
}

// fromAPIServiceScript converts an API ServiceScript to the internal representation.
func fromAPIServiceScript(svc api.ServiceScript) config.ServiceScript {
	out := config.ServiceScript{Name: svc.Name, Command: svc.Command}
	if svc.Host != nil {
		out.Host = *svc.Host
	}
	out.MaxRestarts = svc.MaxRestarts
	out.Enabled = svc.Enabled
	return out
}

// toAPIAgentConfig converts an internal AgentConfig to the API representation.
func toAPIAgentConfig(c config.AgentConfig) api.AgentConfig {
	out := api.AgentConfig{
		PrePrompt: c.PrePrompt,
	}
	if c.Sandbox != nil {
		out.Sandbox = &api.SandboxConfig{
			WritablePaths:  &c.Sandbox.WritablePaths,
			MaskedPaths:    &c.Sandbox.MaskedPaths,
			RestoreRo:      &c.Sandbox.RestoreRO,
			CowPaths:       &c.Sandbox.CowPaths,
			PreSpawnScript: c.Sandbox.PreSpawnScript,
			PreExitScript:  c.Sandbox.PreExitScript,
		}
		if c.Sandbox.Network != nil {
			out.Sandbox.Network = &api.NetworkConfig{
				Enabled:      c.Sandbox.Network.Enabled,
				AllowedHosts: &c.Sandbox.Network.AllowedHosts,
			}
		}
	}
	return out
}

// fromAPIAgentConfig converts an API AgentConfig to the internal representation.
func fromAPIAgentConfig(a api.AgentConfig) config.AgentConfig {
	out := config.AgentConfig{PrePrompt: a.PrePrompt}
	if a.Sandbox != nil {
		sb := &config.SandboxConfig{}
		if a.Sandbox.WritablePaths != nil {
			sb.WritablePaths = *a.Sandbox.WritablePaths
		}
		if a.Sandbox.MaskedPaths != nil {
			sb.MaskedPaths = *a.Sandbox.MaskedPaths
		}
		if a.Sandbox.RestoreRo != nil {
			sb.RestoreRO = *a.Sandbox.RestoreRo
		}
		if a.Sandbox.CowPaths != nil {
			sb.CowPaths = *a.Sandbox.CowPaths
		}
		if a.Sandbox.PreSpawnScript != nil && *a.Sandbox.PreSpawnScript != "" {
			sb.PreSpawnScript = a.Sandbox.PreSpawnScript
		}
		if a.Sandbox.PreExitScript != nil && *a.Sandbox.PreExitScript != "" {
			sb.PreExitScript = a.Sandbox.PreExitScript
		}
		if a.Sandbox.Network != nil {
			sb.Network = &config.NetworkConfig{Enabled: a.Sandbox.Network.Enabled}
			if a.Sandbox.Network.AllowedHosts != nil {
				sb.Network.AllowedHosts = *a.Sandbox.Network.AllowedHosts
			}
		}
		out.Sandbox = sb
	}
	return out
}

func (s *Server) SaveConfig(_ context.Context, request api.SaveConfigRequestObject) (api.SaveConfigResponseObject, error) {
	projectRoot, err := s.resolveProjectRoot(request.ProjectId)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}

	newCfg := config.Config{
		Defaults: fromAPIAgentConfig(request.Body.Defaults),
		Agents:   make(map[string]config.AgentConfig),
	}
	for name, agent := range request.Body.Agents {
		newCfg.Agents[name] = fromAPIAgentConfig(agent)
	}
	// A non-nil artifacts list (even empty) is authoritative, so the editor can
	// add, edit, and delete artifacts. A nil list (older clients) leaves the
	// existing [[artifacts]] blocks untouched.
	if request.Body.Artifacts != nil {
		newCfg.Artifacts = make([]config.ArtifactScript, 0, len(*request.Body.Artifacts))
		for _, a := range *request.Body.Artifacts {
			newCfg.Artifacts = append(newCfg.Artifacts, fromAPIArtifactScript(a))
		}
	}
	// A non-nil services list (even empty) is authoritative; a nil list (older
	// clients / defaults-only saves) leaves the existing [[services]] untouched.
	if request.Body.Services != nil {
		newCfg.Services = make([]config.ServiceScript, 0, len(*request.Body.Services))
		for _, svc := range *request.Body.Services {
			newCfg.Services = append(newCfg.Services, fromAPIServiceScript(svc))
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

	// Restart the project's services so config changes (added/removed/edited
	// [[services]]) take effect immediately. Only for project-scope saves: a
	// user-scope save would have to restart every registered project, and the
	// merged result is reloaded from disk by RestartProject anyway.
	if s.Services != nil && scope == api.SaveConfigParamsScopeProject {
		s.Services.RestartProject(projectRoot)
	}

	return api.SaveConfig200Response{}, nil
}

func (s *Server) DevRestart(_ context.Context, _ api.DevRestartRequestObject) (api.DevRestartResponseObject, error) {
	if !s.Development {
		return api.DevRestart403JSONResponse{
			Code:    403,
			Error:   api.ErrorResponseErrorUnauthorized,
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
			Error:   api.ErrorResponseErrorBadRequest,
			Details: "request body is required",
		}, nil
	}

	projectRoot, err := s.resolveProjectRoot(request.ProjectId)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	log.Printf("api: spawn agent request: id=%q, type=%v, project=%q", request.Body.Id, request.Body.AgentType, projectRoot)
	var agentType sandbox.AgentType
	if request.Body.AgentType != nil && *request.Body.AgentType != "" {
		agentType = sandbox.AgentType(*request.Body.AgentType)
	}
	if agentType != sandbox.AgentTypeClaude && agentType != sandbox.AgentTypeGemini && agentType != sandbox.AgentTypeBash && agentType != sandbox.AgentTypeCopilot {
		return api.SpawnAgent400JSONResponse{
			Code:    400,
			Error:   api.ErrorResponseErrorBadRequest,
			Details: "unknown agent_type; supported: claude, gemini, copilot, bash",
		}, nil
	}

	cfg, err := config.Load(projectRoot)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}

	prePrompt := config.BuildFinalPrePrompt(cfg, string(agentType))
	prompt := ""
	if request.Body.Prompt != nil {
		prompt = strings.TrimSpace(*request.Body.Prompt)
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

	head, err := heads.SpawnHead(ctx, s.Sessions, s.DB, projectRoot, heads.SpawnHeadOptions{
		ID:            id,
		PrePrompt:     prePrompt,
		Prompt:        prompt,
		AgentType:     agentType,
		BaseBranch:    baseBranch,
		Ephemeral:     ephemeral,
		BackgroundCtx: s.BackgroundCtx,
	})
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	return api.SpawnAgent201JSONResponse(agentResponse(*head)), nil
}

func (s *Server) GetAgent(ctx context.Context, request api.GetAgentRequestObject) (api.GetAgentResponseObject, error) {
	projectRoot, err := s.resolveProjectRoot(request.ProjectId)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	head, err := heads.GetHeadByID(ctx, s.Sessions, s.DB, projectRoot, request.Id)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	if head == nil {
		// Fall back to the archived (killed/merged) record, so an archived
		// agent's read-only page still loads on a cold open / hard refresh.
		head, err = heads.GetArchivedHeadByID(s.DB, request.Id)
		if err != nil {
			return nil, errtrace.Wrap(err)
		}
	}
	if head == nil {
		return api.GetAgent404JSONResponse{
			Code:    404,
			Error:   api.ErrorResponseErrorNotFound,
			Details: "agent not found",
		}, nil
	}
	return api.GetAgent200JSONResponse(agentResponse(*head)), nil
}

// UpdateAgent renames an agent's user-facing title. This is a display-only
// change: the agent's stable ID, branch, worktree and live session are
// untouched, so it is cheap and safe even while the agent is running.
func (s *Server) UpdateAgent(ctx context.Context, request api.UpdateAgentRequestObject) (api.UpdateAgentResponseObject, error) {
	if request.Body == nil {
		return api.UpdateAgent400JSONResponse{
			Code:    400,
			Error:   api.ErrorResponseErrorBadRequest,
			Details: "request body is required",
		}, nil
	}
	title := strings.TrimSpace(request.Body.Title)
	if title == "" {
		return api.UpdateAgent400JSONResponse{
			Code:    400,
			Error:   api.ErrorResponseErrorBadRequest,
			Details: "title must not be empty",
		}, nil
	}

	projectRoot, err := s.resolveProjectRoot(request.ProjectId)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	head, err := heads.GetHeadByID(ctx, s.Sessions, s.DB, projectRoot, request.Id)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	if head == nil {
		return api.UpdateAgent404JSONResponse{
			Code:    404,
			Error:   api.ErrorResponseErrorNotFound,
			Details: "agent not found",
		}, nil
	}

	if err := s.DB.UpdateAgentTitle(request.Id, title); err != nil {
		return nil, errtrace.Wrap(err)
	}
	head.Title = title
	return api.UpdateAgent200JSONResponse(agentResponse(*head)), nil
}

func (s *Server) MarkAgentRead(ctx context.Context, request api.MarkAgentReadRequestObject) (api.MarkAgentReadResponseObject, error) {
	projectRoot, err := s.resolveProjectRoot(request.ProjectId)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	head, err := heads.GetHeadByID(ctx, s.Sessions, s.DB, projectRoot, request.Id)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	if head == nil {
		return api.MarkAgentRead404JSONResponse{
			Code:    404,
			Error:   api.ErrorResponseErrorNotFound,
			Details: "agent not found",
		}, nil
	}
	if err := s.DB.MarkAgentRead(request.Id); err != nil {
		return nil, errtrace.Wrap(err)
	}
	return api.MarkAgentRead204Response{}, nil
}

func (s *Server) MergeAgent(ctx context.Context, request api.MergeAgentRequestObject) (api.MergeAgentResponseObject, error) {
	projectRoot, err := s.resolveProjectRoot(request.ProjectId)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	head, err := heads.GetHeadByID(ctx, s.Sessions, s.DB, projectRoot, request.Id)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	if head == nil {
		return api.MergeAgent404JSONResponse{
			Error:   api.ErrorResponseErrorNotFound,
			Code:    404,
			Details: "agent not found",
		}, nil
	}

	if head.Branch == nil {
		return api.MergeAgent400JSONResponse{
			Error:   api.ErrorResponseErrorBadRequest,
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
				Error:   api.MergeConflictErrorErrorConflict,
				Code:    409,
				Details: "operation already in progress",
			}, nil
		}
	}

	if err := git.ValidateRef(branchName); err != nil {
		return nil, &apiError{Code: 400, Type: api.ErrorResponseErrorBadRequest, Err: err} //errtrace:skip
	}

	// Get author info from git config
	authorName, authorEmail := gitConfigVal(projectRoot, "user.name"), gitConfigVal(projectRoot, "user.email")

	if err := git.Merge(projectRoot, branchName, authorName, authorEmail); err != nil {
		errMsg := fmt.Sprintf("merge failed: %v", err)
		if s.DB != nil {
			_ = s.DB.ClearHeadStatus(head.ID, &errMsg)
		}
		return api.MergeAgent409JSONResponse(api.MergeConflictError{
			Error:   api.MergeConflictErrorErrorMergeConflict,
			Code:    409,
			Details: errMsg,
		}), nil
	}

	// Kill cleanup without re-doing the CAS (already in "merging" state).
	if err := heads.KillHeadNoLock(ctx, s.Sessions, s.DB, *head, "merged"); err != nil {
		return nil, errtrace.Wrap(err)
	}

	return api.MergeAgent204Response{}, nil
}

func (s *Server) UpdateAgentFromBase(ctx context.Context, request api.UpdateAgentFromBaseRequestObject) (api.UpdateAgentFromBaseResponseObject, error) {
	projectRoot, err := s.resolveProjectRoot(request.ProjectId)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	head, err := heads.GetHeadByID(ctx, s.Sessions, s.DB, projectRoot, request.Id)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	if head == nil {
		return api.UpdateAgentFromBase404JSONResponse{
			Error:   api.ErrorResponseErrorNotFound,
			Code:    404,
			Details: "agent not found",
		}, nil
	}

	if head.Branch == nil {
		return nil, &apiError{ //errtrace:skip
			Code: 500,
			Type: api.ErrorResponseErrorBadRequest,
			Err:  errors.New("agent has no git branch to update"),
		}
	}

	mergeDir := projectRoot
	if head.Worktree != nil {
		mergeDir = *head.Worktree
	}

	if err := git.ValidateRef(head.BaseBranch); err != nil {
		return nil, &apiError{Code: 400, Type: api.ErrorResponseErrorBadRequest, Err: err} //errtrace:skip
	}

	// Attempt merge (base branch into current branch)
	authorName, authorEmail := gitConfigVal(mergeDir, "user.name"), gitConfigVal(mergeDir, "user.email")

	if err := git.Merge(mergeDir, head.BaseBranch, authorName, authorEmail); err != nil {
		errMsg := fmt.Sprintf("merge failed: %v", err)
		return api.UpdateAgentFromBase409JSONResponse(api.MergeConflictError{
			Error:   api.MergeConflictErrorErrorMergeConflict,
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
	head, err := heads.GetHeadByID(ctx, s.Sessions, s.DB, projectRoot, request.Id)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	if head == nil {
		return api.RestartAgent404JSONResponse{
			Code:    404,
			Error:   api.ErrorResponseErrorNotFound,
			Details: "agent not found",
		}, nil
	}

	// Save the fields we need to respawn.
	id := head.ID
	prompt := head.Prompt
	prePrompt := head.PrePrompt
	agentType := head.AgentType
	baseBranch := head.BaseBranch

	// Kill the existing head (container, worktree, branch). The respawn below
	// reuses the same ID and un-archives the record, so the end state here is
	// transient; record "killed" anyway in case the respawn fails.
	if err := heads.KillHead(ctx, s.Sessions, s.DB, *head, "killed"); err != nil {
		if errors.Is(err, db.ErrOperationInProgress) {
			return api.RestartAgent409JSONResponse{
				Code:    409,
				Error:   api.ErrorResponseErrorConflict,
				Details: "operation already in progress",
			}, nil
		}
		return nil, errtrace.Wrap(err)
	}

	// Override pre_prompt from config if we didn't already have one stored.
	if prePrompt == "" {
		if cfg, cfgErr := config.Load(projectRoot); cfgErr == nil {
			resolved := cfg.GetResolvedConfig(string(agentType))
			if resolved.PrePrompt != nil {
				prePrompt = *resolved.PrePrompt
			}
		}
	}

	newHead, err := heads.SpawnHead(ctx, s.Sessions, s.DB, projectRoot, heads.SpawnHeadOptions{
		ID:            id,
		PrePrompt:     prePrompt,
		Prompt:        prompt,
		AgentType:     agentType,
		BaseBranch:    baseBranch,
		BackgroundCtx: s.BackgroundCtx,
	})
	if err != nil {
		return nil, errtrace.Wrap(err)
	}

	return api.RestartAgent200JSONResponse(agentResponse(*newHead)), nil
}

func (s *Server) KillAgent(ctx context.Context, request api.KillAgentRequestObject) (api.KillAgentResponseObject, error) {
	projectRoot, err := s.resolveProjectRoot(request.ProjectId)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	log.Printf("api: kill agent request: id=%q, project=%q", request.Id, projectRoot)
	head, err := heads.GetHeadByID(ctx, s.Sessions, s.DB, projectRoot, request.Id)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	if head == nil {
		return api.KillAgent404JSONResponse{
			Code:    404,
			Error:   api.ErrorResponseErrorNotFound,
			Details: "agent not found",
		}, nil
	}

	if err := heads.KillHead(ctx, s.Sessions, s.DB, *head, "killed"); err != nil {
		if errors.Is(err, db.ErrOperationInProgress) {
			return api.KillAgent409JSONResponse{
				Code:    409,
				Error:   api.ErrorResponseErrorConflict,
				Details: "operation already in progress",
			}, nil
		}
		return nil, errtrace.Wrap(err)
	}

	return api.KillAgent204Response{}, nil
}

// PurgeAgent permanently deletes an agent (live or archived): it kills any live
// session, removes the worktree/branch and on-disk files, deletes the Claude
// session-history directory, and hard-deletes the DB record. Unlike KillAgent,
// nothing is retained in the archived-history list. See heads.PurgeHead.
func (s *Server) PurgeAgent(ctx context.Context, request api.PurgeAgentRequestObject) (api.PurgeAgentResponseObject, error) {
	projectRoot, err := s.resolveProjectRoot(request.ProjectId)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	log.Printf("api: purge agent request: id=%q, project=%q", request.Id, projectRoot)

	// Resolve a live head first; fall back to the archived record (the common
	// case — purging from the read-only archived-history view).
	head, err := heads.GetHeadByID(ctx, s.Sessions, s.DB, projectRoot, request.Id)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	if head == nil {
		head, err = heads.GetArchivedHeadByID(s.DB, request.Id)
		if err != nil {
			return nil, errtrace.Wrap(err)
		}
	}
	if head == nil {
		return api.PurgeAgent404JSONResponse{
			Code:    404,
			Error:   api.ErrorResponseErrorNotFound,
			Details: "agent not found",
		}, nil
	}

	if err := heads.PurgeHead(ctx, s.Sessions, s.DB, *head); err != nil {
		if errors.Is(err, db.ErrOperationInProgress) {
			return api.PurgeAgent409JSONResponse{
				Code:    409,
				Error:   api.ErrorResponseErrorConflict,
				Details: "operation already in progress",
			}, nil
		}
		return nil, errtrace.Wrap(err)
	}

	return api.PurgeAgent204Response{}, nil
}

// listCommitsCached returns the commits between baseBranch and headBranch, served
// from cache when both refs resolve to commit SHAs — commits are immutable, so the
// result is stable for a given (baseSHA, headSHA) pair. If either ref fails to
// resolve it falls back to a direct, uncached read. The key is namespaced by
// project root so the single shared daemon never crosses repos.
func (s *Server) listCommitsCached(projectRoot, baseBranch, headBranch string) ([]git.CommitInfo, error) {
	baseSHA, errBase := git.ResolveRef(projectRoot, baseBranch)
	headSHA, errHead := git.ResolveRef(projectRoot, headBranch)
	if errBase != nil || errHead != nil {
		return git.ListCommits(projectRoot, baseBranch, headBranch)
	}
	key := strings.Join([]string{projectRoot, baseSHA, headSHA}, "\x00")
	if v, ok := s.commitsCache.get(key); ok {
		return v, nil
	}
	commits, err := git.ListCommits(projectRoot, baseBranch, headBranch)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	s.commitsCache.put(key, commits)
	return commits, nil
}

// getDiffCached returns the parsed diff. A committed-only diff (both refs resolve
// to commit SHAs) is immutable and served from cache; an uncommitted diff reflects
// the mutable working tree, so it is always recomputed live and never cached.
// diffRoot is where git runs (the agent worktree for uncommitted diffs, otherwise
// the project root); refs are resolved against projectRoot. The key folds in every
// option that changes the output (refs, whitespace, dot-mode, path, context).
func (s *Server) getDiffCached(projectRoot, diffRoot, baseRef, headRef string, ignoreWhitespace, useTripleDot bool, path string, contextLines int, includeUncommitted bool) ([]git.DiffFile, error) {
	live := func() ([]git.DiffFile, error) {
		return git.GetDiff(diffRoot, baseRef, headRef, ignoreWhitespace, useTripleDot, path, contextLines)
	}
	if includeUncommitted {
		return live()
	}
	baseSHA, errBase := git.ResolveRef(projectRoot, baseRef)
	headSHA, errHead := git.ResolveRef(projectRoot, headRef)
	if errBase != nil || errHead != nil {
		return live()
	}
	dot := "2dot"
	if useTripleDot {
		dot = "3dot"
	}
	ws := "ws0"
	if ignoreWhitespace {
		ws = "ws1"
	}
	key := strings.Join([]string{projectRoot, baseSHA, headSHA, dot, ws, "ctx" + strconv.Itoa(contextLines), path}, "\x00")
	if v, ok := s.diffCache.get(key); ok {
		return v, nil
	}
	diff, err := live()
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	s.diffCache.put(key, diff)
	return diff, nil
}

func (s *Server) GetAgentCommits(ctx context.Context, request api.GetAgentCommitsRequestObject) (api.GetAgentCommitsResponseObject, error) {
	projectRoot, err := s.resolveProjectRoot(request.ProjectId)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	head, err := heads.GetHeadByID(ctx, s.Sessions, s.DB, projectRoot, request.Id)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	if head == nil {
		return api.GetAgentCommits404JSONResponse{
			Code:    404,
			Error:   api.ErrorResponseErrorNotFound,
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

	commits, err := s.listCommitsCached(projectRoot, baseBranch, headBranch)
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
	head, err := heads.GetHeadByID(ctx, s.Sessions, s.DB, projectRoot, request.Id)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	if head == nil {
		return api.GetAgentDiff404JSONResponse{
			Code:    404,
			Error:   api.ErrorResponseErrorNotFound,
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

	diffFiles, err := s.getDiffCached(projectRoot, diffRoot, baseRef, headRef, ignoreWhitespace, useTripleDot, path, contextLines, includeUncommitted)
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

	// How far the branch trails its base: commits on the base branch not yet in
	// the branch. Surfaced so the UI can warn the branch is out of date.
	behindCount := 0
	if head.Branch != nil {
		if commits, err := git.ListCommits(projectRoot, *head.Branch, head.BaseBranch); err == nil {
			behindCount = len(commits)
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
		BehindCount:        &behindCount,
	}
	return api.GetAgentDiff200JSONResponse(resp), nil
}

func (s *Server) GetAgentDiffFiles(ctx context.Context, request api.GetAgentDiffFilesRequestObject) (api.GetAgentDiffFilesResponseObject, error) {
	projectRoot, err := s.resolveProjectRoot(request.ProjectId)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	head, err := heads.GetHeadByID(ctx, s.Sessions, s.DB, projectRoot, request.Id)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	if head == nil {
		return api.GetAgentDiffFiles404JSONResponse{
			Code:    404,
			Error:   api.ErrorResponseErrorNotFound,
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

func (s *Server) SendAgentInput(ctx context.Context, request api.SendAgentInputRequestObject) (api.SendAgentInputResponseObject, error) {
	projectRoot, err := s.resolveProjectRoot(request.ProjectId)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	head, err := heads.GetHeadByID(ctx, s.Sessions, s.DB, projectRoot, request.Id)
	if err != nil {
		return api.SendAgentInput500JSONResponse{
			Code:    500,
			Error:   api.ErrorResponseErrorInternalError,
			Details: err.Error(),
		}, nil
	}
	if head == nil || head.SessionPID == 0 {
		return api.SendAgentInput404JSONResponse{
			Code:    404,
			Error:   api.ErrorResponseErrorNotFound,
			Details: "agent not found or not running",
		}, nil
	}

	text := request.Body.Text
	if head.AgentType == sandbox.AgentTypeGemini {
		// Use bracketed paste mode to prevent gemini-cli from interpreting ! as a shell command
		text = "\x1b[200~" + text + "\x1b[201~"
	}
	text += "\r"

	if err := s.Sessions.Write(head.ID, []byte(text)); err != nil {
		return api.SendAgentInput500JSONResponse{
			Code:    500,
			Error:   api.ErrorResponseErrorInternalError,
			Details: "failed to write to agent stdin: " + err.Error(),
		}, nil
	}

	return api.SendAgentInput200Response{}, nil
}
