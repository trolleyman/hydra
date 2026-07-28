package http

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/artifacts"
	"github.com/trolleyman/hydra/internal/chat"
	"github.com/trolleyman/hydra/internal/claudestream"
	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/db"
	"github.com/trolleyman/hydra/internal/events"
	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/heads"
	"github.com/trolleyman/hydra/internal/paths"
	"github.com/trolleyman/hydra/internal/preview"
	"github.com/trolleyman/hydra/internal/projects"
	"github.com/trolleyman/hydra/internal/sandbox"
	"github.com/trolleyman/hydra/internal/services"
	"github.com/trolleyman/hydra/internal/session"
	hydratests "github.com/trolleyman/hydra/internal/tests"
	"github.com/trolleyman/hydra/internal/usage"
)

const version = "0.1.0"

// agentInputSeq numbers REST-injected chat messages (diff comments, "Fix with
// agent") so each queued message carries a unique id across the daemon's life.
var agentInputSeq atomic.Uint64

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
	// ChatQueues holds chat-mode heads' queued (not-yet-sent) user messages,
	// daemon-side and disk-persisted (see heads.ChatQueueManager). nil disables
	// queueing (messages always send straight through).
	ChatQueues *heads.ChatQueueManager
	// ChatEvents owns provider-neutral durable history and current-state
	// projections. nil keeps legacy tests/simulation paths working.
	ChatEvents  *chat.Manager
	StartTime   time.Time
	Development bool // set when running under mage dev / mage DevAutoReload
	// BackgroundCtx is the server-lifetime context (cancelled on shutdown). It's
	// handed to detached best-effort work started by a request - e.g. async title
	// refinement - so that work outlives the request but still dies on shutdown.
	BackgroundCtx context.Context
	// Artifacts generates/caches diff artifacts (screenshots etc.), one Manager
	// per registered project (resolved per request). nil disables the feature.
	Artifacts *artifacts.Registry

	// artifactPrefetch is the cross-goroutine bookkeeping shared by the periodic
	// prefetch sweep (RunArtifactPrefetcher) and the on-transition immediate
	// prefetch (PrefetchHeadNow). Lazily initialised via prefetchState so either
	// entry point can be the first to run.
	artifactPrefetch     *artifactPrefetchState
	artifactPrefetchOnce sync.Once

	// Tests runs/caches the per-project [[tests]] commands whose verdict gates a
	// head's merge button (PLAN #68), one Manager per project. nil disables it.
	Tests *hydratests.Registry

	// Services supervises each project's [[services]] (long-running host/sandbox
	// commands, e.g. an emulator pool). nil disables the feature (e.g. in tests).
	Services *services.Manager

	// Previews runs live server previews ([[artifacts]] type = "server") behind
	// per-instance proxy ports. nil disables the feature (e.g. in tests).
	Previews *preview.Manager

	// Events fans "something changed, refetch it" signals to web clients over the
	// events WebSocket, replacing per-tab polling (PLAN #50). nil disables push
	// (clients fall back to their slow safety-net poll); the Hub methods are
	// nil-safe so producers need not guard.
	Events *events.Hub

	lastSandboxError atomic.Value // holds string

	// claudeUsage caches the account-global Claude Code usage snapshot, lazily
	// initialised on first request (the probe is host-account-wide, so it's not
	// scoped per project).
	claudeUsageOnce sync.Once
	claudeUsage     *usage.Cache

	// Memoise git history reads keyed by resolved commit SHAs. Commits are
	// immutable, so the commit list and committed diff between a fixed pair of SHAs
	// never change - repeated reads (e.g. a terminal-WS reconnect re-loading the
	// diff/commits panels) can be served without re-invoking git. Only committed
	// state is cached; the uncommitted/working-tree diff is always recomputed live.
	commitsCache immutableCache[[]git.CommitInfo]
	diffCache    immutableCache[[]git.DiffFile]

	// fetchMu guards the per-project background-fetch throttle used by the push
	// status endpoint (see maybeFetchRemote): fetchActive marks a fetch in flight,
	// fetchLast records when one last started, so concurrent or too-frequent polls
	// don't hammer the remote.
	fetchMu     sync.Mutex
	fetchActive map[string]bool
	fetchLast   map[string]time.Time

	// shellCancels maps a running chat "!command"'s client id to its cancel func,
	// so a shell_stop frame can kill it mid-run (see runChatShellCommand). A
	// sync.Map needs no init and tolerates the concurrent register/stop/cleanup.
	shellCancels sync.Map
}

// remoteFetchInterval throttles background `git fetch`es kicked off by the push
// status endpoint: at most one per project per interval, regardless of how many
// clients are polling.
const remoteFetchInterval = 20 * time.Second

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
			return errtrace.Wrap2(usage.Probe(ctx, "claude", root, usage.HostEnv()))
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
			// A failed response *write* (the client hung up mid-body) surfaces here
			// like any handler error, but the status line is already on the wire:
			// writing an error body now only earns a "superfluous WriteHeader"
			// warning and logs a phantom 500 for a request that was served fine.
			// LoggingMiddleware notes the disconnect from the recorder instead.
			if isClientDisconnect(err) {
				return
			}
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
	// Every strict handler gets the originating *http.Request in its context
	// (requestFromContext) for the few endpoints that need request metadata the
	// generated signatures don't carry (e.g. the Host header for preview URLs).
	injectRequest := func(f api.StrictHandlerFunc, _ string) api.StrictHandlerFunc {
		return func(ctx context.Context, w http.ResponseWriter, r *http.Request, request any) (any, error) {
			return errtrace.Wrap2(f(context.WithValue(ctx, requestCtxKey{}, r), w, r, request))
		}
	}
	strict := api.NewStrictHandlerWithOptions(s, []api.StrictMiddlewareFunc{injectRequest}, opts)
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

// notifyAgentsChanged pushes an agents_changed event for projectRoot (and, when
// crossProject is true, a broadcast projects_changed for the cross-project unread
// totals) so web clients refetch immediately instead of waiting for their poll.
// s.Events is nil-safe. Spawn/kill/merge change the per-project list and the
// unread totals, so they pass crossProject=true.
func (s *Server) notifyAgentsChanged(projectRoot string, crossProject bool) {
	s.Events.AgentsChanged(projectRoot)
	if crossProject {
		s.Events.ProjectsChanged()
	}
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
	// A second query gives the red "needs your input" counts the same way.
	needsInput, err := s.DB.CountNeedsInputByProject()
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	// A third groups every project's active agents by status, for the switcher's
	// per-project tally (total + running/waiting/finished breakdown).
	statusCounts, err := s.DB.CountByStatusAndProject()
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	resp := make(api.ListProjects200JSONResponse, len(ps))
	for i, p := range ps {
		count := unread[p.Path]
		needs := needsInput[p.Path]
		// Sum the per-status counts into a total and pull out the named states.
		var total, running, waiting, finished int
		for status, n := range statusCounts[p.Path] {
			total += n
			switch status {
			case "running":
				running = n
			case "waiting":
				waiting = n
			case "finished":
				finished = n
			}
		}
		builtin := p.Builtin
		resp[i] = api.ProjectInfo{
			Id:              p.ID,
			Path:            p.Path,
			DisplayPath:     displayPathPtr(p.Path),
			Name:            p.Name,
			Builtin:         &builtin,
			UnreadCount:     &count,
			NeedsInputCount: &needs,
			AgentCount:      &total,
			RunningCount:    &running,
			WaitingCount:    &waiting,
			FinishedCount:   &finished,
		}
		// The custom icon lives in the project's .hydra/config.toml (committed with
		// the repo). LoadFile is mtime-cached, so this stays cheap across polls; a
		// missing/unreadable config just means no custom icon.
		if icon := projectIconValue(p.Path); icon != "" {
			resp[i].Icon = &icon
		}
	}
	return resp, nil
}

// displayPathPtr returns the project path for display, with the server's home
// directory abbreviated to "~". Computed server-side because only the server
// knows its HOME (the web client must not guess home-directory patterns).
func displayPathPtr(path string) *string {
	dp := path
	if home, err := os.UserHomeDir(); err == nil {
		dp = abbreviateHome(path, home)
	}
	return &dp
}

// abbreviateHome replaces a leading `home` prefix of path with "~", matching
// only on a whole path component (so /home/user2 is not abbreviated for
// HOME=/home/user). Pure - split out of displayPathPtr for testing.
func abbreviateHome(path, home string) string {
	home = strings.TrimSuffix(home, "/")
	if home == "" {
		return path
	}
	if path == home {
		return "~"
	}
	if strings.HasPrefix(path, home+"/") {
		return "~" + path[len(home):]
	}
	return path
}

// projectIconValue returns the trimmed custom icon configured in a project's
// .hydra/config.toml, or "" when there is none (or the config can't be read).
func projectIconValue(projectRoot string) string {
	cfg, err := config.LoadFile(config.GetProjectConfigPath(projectRoot))
	if err != nil || cfg == nil || cfg.Icon == nil {
		return ""
	}
	return strings.TrimSpace(*cfg.Icon)
}

// ReorderProjects rewrites the stored order of the project list, which is the
// order the project selector renders. Clients send the full list of IDs in
// their new order; see Manager.ReorderProjects for how a stale client list
// (one that misses a just-added project) is reconciled.
func (s *Server) ReorderProjects(_ context.Context, request api.ReorderProjectsRequestObject) (api.ReorderProjectsResponseObject, error) {
	if request.Body == nil {
		return api.ReorderProjects400JSONResponse{
			Code:    400,
			Error:   api.ErrorResponseErrorBadRequest,
			Details: "project_ids is required",
		}, nil
	}
	if err := s.ProjectsManager.ReorderProjects(request.Body.ProjectIds); err != nil {
		return nil, errtrace.Wrap(err)
	}
	// Other connected clients refetch the list and pick up the new order.
	s.Events.ProjectsChanged()
	return api.ReorderProjects204Response{}, nil
}

// SetProjectIcon sets (or clears) a project's custom icon in its
// .hydra/config.toml and returns the updated ProjectInfo. An empty icon restores
// the default folder glyph.
func (s *Server) SetProjectIcon(_ context.Context, request api.SetProjectIconRequestObject) (api.SetProjectIconResponseObject, error) {
	if request.Body == nil {
		return api.SetProjectIcon400JSONResponse{
			Code:    400,
			Error:   api.ErrorResponseErrorBadRequest,
			Details: "icon is required",
		}, nil
	}
	p := s.ProjectsManager.GetByID(request.ProjectId)
	if p == nil {
		return api.SetProjectIcon404JSONResponse{
			Code:    404,
			Error:   api.ErrorResponseErrorNotFound,
			Details: "project not found",
		}, nil
	}
	// Load the current project config, set just the icon, and write it back. The
	// save renders on top of the existing file, so comments and every other
	// setting survive (see config.SaveToFile).
	cfg, err := config.LoadFile(config.GetProjectConfigPath(p.Path))
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	if cfg == nil {
		cfg = &config.Config{}
	}
	icon := strings.TrimSpace(request.Body.Icon)
	cfg.Icon = &icon // authoritative; "" writes an empty value (the default icon)
	if err := config.Save(p.Path, *cfg); err != nil {
		return nil, errtrace.Wrap(err)
	}
	resp := api.ProjectInfo{Id: p.ID, Path: p.Path, DisplayPath: displayPathPtr(p.Path), Name: p.Name}
	if icon != "" {
		resp.Icon = &icon
	}
	// Nudge every connected client to refresh so the new icon shows up in their
	// project dropdown / switcher without a manual reload.
	s.Events.ProjectsChanged()
	return api.SetProjectIcon200JSONResponse(resp), nil
}

func (s *Server) AddProject(_ context.Context, request api.AddProjectRequestObject) (api.AddProjectResponseObject, error) {
	if request.Body == nil || strings.TrimSpace(request.Body.Path) == "" {
		return api.AddProject400JSONResponse{
			Code:    400,
			Error:   api.ErrorResponseErrorBadRequest,
			Details: "path is required",
		}, nil
	}

	// Expand what the user typed ("~/code/foo", or "code/foo" relative to home)
	// before anything stats it - os.Stat has no shell to do this for it, so an
	// unexpanded "~" used to fail as "directory does not exist".
	projectPath := paths.ResolveUserPath(request.Body.Path)

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
		Id:          p.ID,
		Path:        p.Path,
		DisplayPath: displayPathPtr(p.Path),
		Name:        p.Name,
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

// EnsureTrackRemote configures the local "hydra-agents" remote in the project's
// repo so the user can `git checkout -t hydra-agents/<id>` and `git pull` to
// follow a head's branch (see docs/git-isolation.md). Idempotent; backs the
// agent page's "check out locally" affordance.
func (s *Server) EnsureTrackRemote(ctx context.Context, request api.EnsureTrackRemoteRequestObject) (api.EnsureTrackRemoteResponseObject, error) {
	p := s.ProjectsManager.GetByID(request.ProjectId)
	if p == nil {
		return api.EnsureTrackRemote404JSONResponse{
			Code:    404,
			Error:   api.ErrorResponseErrorNotFound,
			Details: "project not found",
		}, nil
	}
	remote, err := git.EnsureTrackRemote(ctx, p.Path)
	if err != nil {
		return api.EnsureTrackRemote500JSONResponse{
			Code:    500,
			Error:   api.ErrorResponseErrorInternalError,
			Details: err.Error(),
		}, nil
	}
	return api.EnsureTrackRemote200JSONResponse{Remote: remote}, nil
}

// PreviewConfigToml reads a project's .hydra/config.toml straight off disk at an
// arbitrary path, without registering the project. It backs the add-project trust
// prompt: the UI shows the repo-controlled config for review *before* the project
// is added (registering starts its [[services]], which can run code), so nothing
// runs until the user has trusted it. Read-only - it never executes anything.
func (s *Server) PreviewConfigToml(_ context.Context, request api.PreviewConfigTomlRequestObject) (api.PreviewConfigTomlResponseObject, error) {
	// Same expansion as AddProject: the trust prompt must preview the config of
	// the directory that will actually be registered.
	path := paths.ResolveUserPath(request.Params.Path)
	if path == "" {
		return api.PreviewConfigToml400JSONResponse{
			Code:    400,
			Error:   api.ErrorResponseErrorBadRequest,
			Details: "path is required",
		}, nil
	}
	content, exists, err := config.ReadProjectConfigTOML(path)
	if err != nil {
		return api.PreviewConfigToml500JSONResponse{
			Code:    500,
			Error:   api.ErrorResponseErrorInternalError,
			Details: err.Error(),
		}, nil
	}
	return api.PreviewConfigToml200JSONResponse(api.ConfigTomlResponse{
		Content: string(content),
		Exists:  exists,
	}), nil
}

// resolveProjectPath expands a hand-typed project path the way AddProject will:
// paths.ResolveUserPath ("~" and relative paths against home) followed by the
// same absolute/symlink normalization projects.AddProject applies, so the path
// reported to the UI is the one the project would actually be registered under.
func resolveProjectPath(typed string) string {
	resolved := paths.ResolveUserPath(typed)
	if resolved == "" {
		return ""
	}
	if norm, err := paths.NormalizePath(resolved); err == nil {
		return norm
	}
	return resolved
}

// ResolvePath tells the web UI what a hand-typed folder path actually means on
// this machine: the absolute path it expands to, and whether a git repository
// is there. The browser cannot work any of this out itself - it doesn't know
// the server's home directory (see displayPathPtr) or its filesystem - so the
// add-project flow resolves through here before it shows the path back to the
// user or posts it to AddProject.
func (s *Server) ResolvePath(_ context.Context, request api.ResolvePathRequestObject) (api.ResolvePathResponseObject, error) {
	resolved := resolveProjectPath(request.Params.Path)
	if resolved == "" {
		return api.ResolvePath400JSONResponse{
			Code:    400,
			Error:   api.ErrorResponseErrorBadRequest,
			Details: "path is required",
		}, nil
	}
	resp := api.ResolvedPathResponse{
		Path:        resolved,
		DisplayPath: *displayPathPtr(resolved),
	}
	if st, err := os.Stat(resolved); err == nil {
		resp.Exists = true
		resp.IsDir = st.IsDir()
	}
	if root, err := paths.GetProjectRoot(resolved); err == nil {
		resp.IsGitRepo = true
		resp.RepoRoot = &root
	}
	return api.ResolvePath200JSONResponse(resp), nil
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
// so every endpoint returns an identically-shaped agent (id, title, status, ...).
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
	var netEnf *string
	if m := string(heads.EgressModeFor(h.ID)); m != "" {
		netEnf = &m
	}
	gitIso := string(heads.EffectiveGitIsolation(h))
	resp := api.AgentResponse{
		Id:                 h.ID,
		Title:              &title,
		BranchName:         h.Branch,
		WorktreePath:       h.Worktree,
		ProjectPath:        h.ProjectPath,
		SessionPid:         h.SessionPID,
		SessionStatus:      h.SessionStatus,
		AgentType:          string(h.AgentType),
		PrePrompt:          h.PrePrompt,
		Prompt:             h.Prompt,
		BaseBranch:         h.BaseBranch,
		Ephemeral:          &h.Ephemeral,
		ChatMode:           &h.ChatMode,
		CreatedAt:          createdAt,
		AgentStatus:        h.AgentStatus,
		NetworkEnforcement: netEnf,
		GitIsolation:       &gitIso,
		HasUnreadChanges:   &h.HasUnreadChanges,
		Archived:           &archived,
		EndState:           endState,
		MergeWhenGreen:     &h.MergeWhenGreen,
		PublishWhenGreen:   &h.PublishWhenGreen,
	}
	if h.Plan != "" {
		resp.Plan = &h.Plan
	}
	if h.Model != "" {
		resp.Model = &h.Model
	}
	return resp
}

// agentResponseWithReview is agentResponse plus the per-head MR link (downstream
// branch + review link with cached state). Split out so the hot list path can skip
// the extra work when a head is unlinked. ahead/behind vs the remote downstream
// branch are read from the cached remote-tracking refs (no fetch).
func (s *Server) agentResponseWithReview(h heads.Head) api.AgentResponse {
	resp := agentResponse(h)
	if h.DownstreamBranch != "" {
		resp.DownstreamBranch = &h.DownstreamBranch
	}
	if !h.IsLinked() {
		return resp
	}
	link := api.ReviewLink{
		Url:      h.ReviewURL,
		Id:       h.ReviewID,
		Provider: h.ReviewProvider,
	}
	if h.ReviewTargetBranch != "" {
		link.TargetBranch = &h.ReviewTargetBranch
	}
	if h.ReviewAdopted {
		adopted := true
		link.Adopted = &adopted
		link.CanPush = &h.ReviewCanPush
	}
	if h.Branch != nil {
		if h.ReviewAdopted {
			// An adopted head tracks the PR's read-only head pseudo-ref, cached in a
			// private local ref (refreshed by the watcher / Pull from MR).
			if ahead, behind, ok := git.AheadBehind(h.ProjectPath, *h.Branch, git.PRLocalRef(h.ReviewProvider, h.ReviewID)); ok {
				link.Ahead, link.Behind = &ahead, &behind
			}
		} else if h.DownstreamBranch != "" {
			remote := reviewRemote(h.ProjectPath)
			if ahead, behind, ok := downstreamAheadBehind(h.ProjectPath, *h.Branch, remote, h.DownstreamBranch); ok {
				link.Ahead, link.Behind = &ahead, &behind
			}
		}
	}
	if h.ReviewState != "" {
		var st api.ReviewState
		if json.Unmarshal([]byte(h.ReviewState), &st) == nil && st.State != "" {
			link.State = &st
		}
	}
	resp.Review = &link
	return resp
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
		resp[i] = s.agentResponseWithReview(h)
		resp[i].Tests = s.testSummaryFor(projectRoot, h)
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
		switch *request.Params.Scope {
		case api.GetConfigParamsScopeUser:
			path, err = config.GetUserConfigPath()
			if err != nil {
				return nil, errtrace.Wrap(err)
			}
		case api.GetConfigParamsScopeLocal:
			path = paths.GetProjectConfigLocalPath(projectRoot)
		default:
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

	// Candidate MCP servers for the allow-list picker (read-only, best-effort).
	if servers := listCandidateMCPServers(projectRoot); len(servers) > 0 {
		resp.McpServers = &servers
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

	if len(cfg.Tests) > 0 {
		tests := make([]api.TestScript, len(cfg.Tests))
		for i, t := range cfg.Tests {
			tests[i] = toAPITestScript(t)
		}
		resp.Tests = &tests
	}

	// Surface the configured value when set (nil = unset → the client shows the
	// default; 0 = unlimited). Copy so the response doesn't alias cfg's pointer.
	if cfg.ArtifactConcurrency != nil {
		n := *cfg.ArtifactConcurrency
		resp.ArtifactConcurrency = &n
	}
	// Surface the prefetch toggle when set (nil = unset → the client shows the
	// default, enabled). Copy so the response doesn't alias cfg's pointer.
	if cfg.ArtifactPrefetch != nil {
		b := *cfg.ArtifactPrefetch
		resp.ArtifactPrefetch = &b
	}
	// Test concurrency + prefetch mirror their artifact counterparts above.
	if cfg.TestConcurrency != nil {
		n := *cfg.TestConcurrency
		resp.TestConcurrency = &n
	}
	if cfg.TestPrefetch != nil {
		b := *cfg.TestPrefetch
		resp.TestPrefetch = &b
	}

	// The raw [review] table for this layer (nil = unset here → the editor shows
	// the field empty and inherits the layer below).
	resp.Review = toAPIReviewConfig(cfg.Review)

	// The raw [resources] table for this layer (nil = unset → the editor shows the
	// fields empty and inherits the layer below / the built-in defaults).
	resp.Resources = toAPIResourceLimits(cfg.Resources)

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
	if a.CleanIgnored {
		out.CleanIgnored = &a.CleanIgnored
	}
	if a.Type != "" {
		out.Type = &a.Type
	}
	if a.IdleTimeoutSec != 0 {
		out.IdleTimeoutSec = &a.IdleTimeoutSec
	}
	if a.ReadyTimeoutSec != 0 {
		out.ReadyTimeoutSec = &a.ReadyTimeoutSec
	}
	out.Strict = a.Strict
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
	if a.CleanIgnored != nil {
		out.CleanIgnored = *a.CleanIgnored
	}
	if a.Type != nil {
		out.Type = *a.Type
	}
	if a.IdleTimeoutSec != nil {
		out.IdleTimeoutSec = *a.IdleTimeoutSec
	}
	if a.ReadyTimeoutSec != nil {
		out.ReadyTimeoutSec = *a.ReadyTimeoutSec
	}
	out.Strict = a.Strict
	out.Enabled = a.Enabled
	return out
}

// toAPITestScript converts an internal TestScript to the API representation. The
// fields mirror ArtifactScript, so this mirrors toAPIArtifactScript.
func toAPITestScript(t config.TestScript) api.TestScript {
	out := api.TestScript{Name: t.Name, Command: t.Command}
	if t.TimeoutSec != 0 {
		out.TimeoutSec = &t.TimeoutSec
	}
	if t.UnsafeHost {
		out.UnsafeHost = &t.UnsafeHost
	}
	if t.CleanIgnored {
		out.CleanIgnored = &t.CleanIgnored
	}
	if t.Type != "" {
		out.Type = &t.Type
	}
	out.Strict = t.Strict
	out.Enabled = t.Enabled
	return out
}

// fromAPITestScript converts an API TestScript to the internal representation.
func fromAPITestScript(t api.TestScript) config.TestScript {
	out := config.TestScript{Name: t.Name, Command: t.Command}
	if t.TimeoutSec != nil {
		out.TimeoutSec = *t.TimeoutSec
	}
	if t.UnsafeHost != nil {
		out.UnsafeHost = *t.UnsafeHost
	}
	if t.CleanIgnored != nil {
		out.CleanIgnored = *t.CleanIgnored
	}
	if t.Type != nil {
		out.Type = *t.Type
	}
	out.Strict = t.Strict
	out.Enabled = t.Enabled
	return out
}

// toAPIServiceScript converts an internal ServiceScript to the API representation.
func toAPIServiceScript(svc config.ServiceScript) api.ServiceScript {
	out := api.ServiceScript{Name: svc.Name, Command: svc.Command}
	if svc.Host {
		out.Host = &svc.Host
	}
	out.MaxRestarts = svc.MaxRestarts
	out.Strict = svc.Strict
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
	out.Strict = svc.Strict
	out.Enabled = svc.Enabled
	return out
}

// listCandidateMCPServers enumerates MCP servers configured on the host
// (~/.claude.json) and in the project (.mcp.json), for the settings allow-list
// picker. Best-effort: unreadable/missing files just yield fewer candidates.
func listCandidateMCPServers(projectRoot string) []api.McpServer {
	var claudeJSON []byte
	if home, err := os.UserHomeDir(); err == nil {
		claudeJSON, _ = os.ReadFile(filepath.Join(home, ".claude.json"))
	}
	mcpJSON, _ := os.ReadFile(filepath.Join(projectRoot, ".mcp.json"))
	servers := sandbox.ListMCPServers(claudeJSON, mcpJSON)
	out := make([]api.McpServer, len(servers))
	for i, srv := range servers {
		out[i] = api.McpServer{Name: srv.Name, Source: srv.Source}
	}
	return out
}

// toAPIReviewConfig converts the raw internal [review] table to its API shape
// (both are all-optional pointer fields). nil in → nil out (the layer sets none).
func toAPIReviewConfig(r *config.ReviewConfig) *api.ReviewConfig {
	if r == nil {
		return nil
	}
	out := api.ReviewConfig{
		Provider:           r.Provider,
		Remote:             r.Remote,
		Auth:               r.Auth,
		DefaultAction:      r.DefaultAction,
		PushBranchTemplate: r.PushBranchTemplate,
		Draft:              r.Draft,
		Squash:             r.Squash,
		DeleteRemoteBranch: r.DeleteRemoteBranch,
		RequireLocalTests:  r.RequireLocalTests,
		PublishWhenGreen:   r.PublishWhenGreen,
	}
	if r.ProtectedBranches != nil {
		pb := append([]string(nil), r.ProtectedBranches...)
		out.ProtectedBranches = &pb
	}
	return &out
}

// fromAPIReviewConfig is the inverse of toAPIReviewConfig, for a SaveConfig body.
func fromAPIReviewConfig(r *api.ReviewConfig) *config.ReviewConfig {
	if r == nil {
		return nil
	}
	out := config.ReviewConfig{
		Provider:           r.Provider,
		Remote:             r.Remote,
		Auth:               r.Auth,
		DefaultAction:      r.DefaultAction,
		PushBranchTemplate: r.PushBranchTemplate,
		Draft:              r.Draft,
		Squash:             r.Squash,
		DeleteRemoteBranch: r.DeleteRemoteBranch,
		RequireLocalTests:  r.RequireLocalTests,
		PublishWhenGreen:   r.PublishWhenGreen,
	}
	if r.ProtectedBranches != nil {
		out.ProtectedBranches = append([]string(nil), *r.ProtectedBranches...)
	}
	return &out
}

// toAPIResourceLimits converts the raw internal [resources] table to its API
// shape (both are all-optional pointer fields). nil in → nil out (the layer sets
// none). Pointers are copied so the response never aliases cfg's pointers.
func toAPIResourceLimits(r *config.ResourceLimits) *api.ResourceLimits {
	if r == nil {
		return nil
	}
	return &api.ResourceLimits{
		CpuWeight: copyIntPtr(r.CPUWeight),
		IoWeight:  copyIntPtr(r.IOWeight),
		CpuQuota:  copyIntPtr(r.CPUQuota),
		MemoryMax: copyIntPtr(r.MemoryMax),
		TasksMax:  copyIntPtr(r.TasksMax),
	}
}

// fromAPIResourceLimits is the inverse of toAPIResourceLimits, for a SaveConfig
// body. Hard caps below zero are clamped to 0 (unset/no cap); weights below zero
// are clamped to 0 too (which resolves back to the default).
func fromAPIResourceLimits(r *api.ResourceLimits) *config.ResourceLimits {
	if r == nil {
		return nil
	}
	clamp := func(v *int) *int {
		if v == nil {
			return nil
		}
		n := *v
		if n < 0 {
			n = 0
		}
		return &n
	}
	return &config.ResourceLimits{
		CPUWeight: clamp(r.CpuWeight),
		IOWeight:  clamp(r.IoWeight),
		CPUQuota:  clamp(r.CpuQuota),
		MemoryMax: clamp(r.MemoryMax),
		TasksMax:  clamp(r.TasksMax),
	}
}

// copyIntPtr returns a fresh copy of an int pointer (nil-safe), so an API
// response never aliases the internal config's pointers.
func copyIntPtr(v *int) *int {
	if v == nil {
		return nil
	}
	n := *v
	return &n
}

// toAPIAgentConfig converts an internal AgentConfig to the API representation.
func toAPIAgentConfig(c config.AgentConfig) api.AgentConfig {
	out := api.AgentConfig{
		PrePrompt:  c.PrePrompt,
		Fullscreen: c.Fullscreen,
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
			n := c.Sandbox.Network
			out.Sandbox.Network = &api.NetworkConfig{
				Enabled:              n.Enabled,
				FilterEnabled:        n.FilterEnabled,
				AllowedHosts:         &n.AllowedHosts,
				BlockedHosts:         &n.BlockedHosts,
				AllowedLoopbackPorts: &n.AllowedLoopbackPorts,
			}
			if n.Mode != nil {
				m := api.NetworkConfigMode(*n.Mode)
				out.Sandbox.Network.Mode = &m
			}
		}
	}
	if c.Policy != nil {
		p := c.Policy
		out.Policy = &api.PolicyConfig{
			GateEnabled:      p.GateEnabled,
			GitIsolation:     p.GitIsolation,
			McpAllowed:       &p.MCPAllowed,
			McpToolsAllowed:  &p.MCPToolsAllowed,
			McpBlocked:       &p.MCPBlocked,
			McpToolsBlocked:  &p.MCPToolsBlocked,
			McpAutoAllowRead: p.MCPAutoAllowRead,
			// known_tools is not edited by the Settings UI, but must ride along in
			// the response so a round-tripped save preserves a hand-edited value.
			KnownTools: &p.KnownTools,
		}
	}
	return out
}

// fromAPIAgentConfig converts an API AgentConfig to the internal representation.
func fromAPIAgentConfig(a api.AgentConfig) config.AgentConfig {
	out := config.AgentConfig{PrePrompt: a.PrePrompt, Fullscreen: a.Fullscreen}
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
			n := a.Sandbox.Network
			sb.Network = &config.NetworkConfig{
				Enabled:       n.Enabled,
				FilterEnabled: n.FilterEnabled,
			}
			if n.Mode != nil {
				m := string(*n.Mode)
				sb.Network.Mode = &m
			}
			if n.AllowedHosts != nil {
				sb.Network.AllowedHosts = *n.AllowedHosts
			}
			if n.BlockedHosts != nil {
				sb.Network.BlockedHosts = *n.BlockedHosts
			}
			if n.AllowedLoopbackPorts != nil {
				sb.Network.AllowedLoopbackPorts = *n.AllowedLoopbackPorts
			}
		}
		out.Sandbox = sb
	}
	if a.Policy != nil {
		p := &config.PolicyConfig{GateEnabled: a.Policy.GateEnabled, GitIsolation: a.Policy.GitIsolation, MCPAutoAllowRead: a.Policy.McpAutoAllowRead}
		if a.Policy.McpAllowed != nil {
			p.MCPAllowed = *a.Policy.McpAllowed
		}
		if a.Policy.McpToolsAllowed != nil {
			p.MCPToolsAllowed = *a.Policy.McpToolsAllowed
		}
		if a.Policy.McpBlocked != nil {
			p.MCPBlocked = *a.Policy.McpBlocked
		}
		if a.Policy.McpToolsBlocked != nil {
			p.MCPToolsBlocked = *a.Policy.McpToolsBlocked
		}
		if a.Policy.KnownTools != nil {
			p.KnownTools = *a.Policy.KnownTools
		}
		out.Policy = p
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
	// A non-nil tests list (even empty) is authoritative, mirroring artifacts; a nil
	// list (older clients / defaults-only saves) leaves the existing [[tests]] blocks
	// untouched.
	if request.Body.Tests != nil {
		newCfg.Tests = make([]config.TestScript, 0, len(*request.Body.Tests))
		for _, t := range *request.Body.Tests {
			newCfg.Tests = append(newCfg.Tests, fromAPITestScript(t))
		}
	}
	// The raw [review] table for this layer. renderConfig regenerates [review]
	// from it (or preserves the existing block when nil).
	newCfg.Review = fromAPIReviewConfig(request.Body.Review)
	newCfg.Resources = fromAPIResourceLimits(request.Body.Resources)
	// Artifact concurrency: a set value (0 = unlimited, N>0 = at most N) is
	// applied authoritatively; nil/absent clears it so it resets to the built-in
	// default. Negatives are coerced to 0 (unlimited), matching the API minimum.
	if request.Body.ArtifactConcurrency != nil {
		n := *request.Body.ArtifactConcurrency
		if n < 0 {
			n = 0
		}
		newCfg.ArtifactConcurrency = &n
	}
	// Artifact prefetch toggle: a set value is applied authoritatively; nil/absent
	// leaves it to renderConfig, which preserves the file's existing value.
	if request.Body.ArtifactPrefetch != nil {
		b := *request.Body.ArtifactPrefetch
		newCfg.ArtifactPrefetch = &b
	}
	// Test concurrency + prefetch mirror their artifact counterparts above.
	if request.Body.TestConcurrency != nil {
		n := *request.Body.TestConcurrency
		if n < 0 {
			n = 0
		}
		newCfg.TestConcurrency = &n
	}
	if request.Body.TestPrefetch != nil {
		b := *request.Body.TestPrefetch
		newCfg.TestPrefetch = &b
	}

	scope := api.SaveConfigParamsScopeProject
	if request.Params.Scope != nil {
		scope = *request.Params.Scope
	}

	var savePath string
	switch scope {
	case api.SaveConfigParamsScopeUser:
		var err error
		savePath, err = config.GetUserConfigPath()
		if err != nil {
			return nil, errtrace.Wrap(err)
		}
	case api.SaveConfigParamsScopeLocal:
		savePath = paths.GetProjectConfigLocalPath(projectRoot)
	default:
		savePath = config.GetProjectConfigPath(projectRoot)
	}

	if err := config.SaveToFile(savePath, newCfg); err != nil {
		return nil, errtrace.Wrap(err)
	}

	// Restart the project's services so config changes (added/removed/edited
	// [[services]]) take effect immediately. Project and local scopes both feed
	// this project's merged config; a user-scope save would have to restart
	// every registered project, so it is left to the next natural restart.
	if s.Services != nil && scope != api.SaveConfigParamsScopeUser {
		s.Services.RestartProject(projectRoot)
	}

	// A project-scope save just dirtied .hydra/config.toml in the project root;
	// nudge clients so the sidebar's uncommitted-changes warning appears
	// immediately rather than on the next fallback poll.
	if scope == api.SaveConfigParamsScopeProject {
		s.Events.PushStatusChanged(projectRoot)
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

// spawnTermSize sanitises the optional rows/cols a spawn request carries into
// uint16 PTY dimensions. A nil, non-positive, or absurdly large value becomes 0,
// signalling "unset" so the caller can apply its own fallback (or leave it to the
// PTY's built-in 24x80 default). The 2000 ceiling mirrors parseTermSize on the
// terminal WebSocket so a bogus client can't request a giant PTY.
func spawnTermSize(rows, cols *int) (uint16, uint16) {
	clamp := func(v *int) uint16 {
		if v == nil || *v <= 0 || *v > 2000 {
			return 0
		}
		return uint16(*v)
	}
	return clamp(rows), clamp(cols)
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
	reqID := ""
	if request.Body.Id != nil {
		reqID = *request.Body.Id
	}
	log.Printf("api: spawn agent request: id=%q, type=%v, project=%q", reqID, request.Body.AgentType, projectRoot)
	var agentType sandbox.AgentType
	if request.Body.AgentType != nil && *request.Body.AgentType != "" {
		agentType = sandbox.AgentType(*request.Body.AgentType)
	}
	if agentType != sandbox.AgentTypeClaude && agentType != sandbox.AgentTypeGemini && agentType != sandbox.AgentTypeBash && agentType != sandbox.AgentTypeCopilot && agentType != sandbox.AgentTypeCodex {
		return api.SpawnAgent400JSONResponse{
			Code:    400,
			Error:   api.ErrorResponseErrorBadRequest,
			Details: "unknown agent_type; supported: claude, gemini, copilot, codex, bash",
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

	// The ID is optional: when omitted (the web UI's normal path) SpawnHead
	// derives a unique slug from the prompt, so spawns can never collide with
	// an existing head - same project, archived, or another project sharing
	// the DB.
	var id string
	if request.Body.Id != nil {
		id = strings.TrimSpace(*request.Body.Id)
	}
	force := request.Body.Force != nil && *request.Body.Force
	var baseBranch string
	if request.Body.BaseBranch != nil {
		baseBranch = strings.TrimSpace(*request.Body.BaseBranch)
	}

	ephemeral := false
	if request.Body.Ephemeral != nil {
		ephemeral = *request.Body.Ephemeral
	}

	var model string
	if request.Body.Model != nil {
		model = strings.TrimSpace(*request.Body.Model)
	}

	// Chat mode defaults on for the agent types that support it (claude, codex);
	// an explicit chat_mode in the request always wins. Callers that omit it for
	// other agent types stay in terminal mode.
	chatMode := agentType == sandbox.AgentTypeClaude || agentType == sandbox.AgentTypeCodex
	if request.Body.ChatMode != nil {
		chatMode = *request.Body.ChatMode
	}
	if chatMode && agentType != sandbox.AgentTypeClaude && agentType != sandbox.AgentTypeCodex {
		return api.SpawnAgent400JSONResponse{
			Code:    400,
			Error:   api.ErrorResponseErrorBadRequest,
			Details: "chat_mode is only supported for claude and codex agents",
		}, nil
	}

	var gitIsolation string
	if request.Body.GitIsolation != nil {
		gitIsolation = string(*request.Body.GitIsolation)
	}
	// Adopting an existing PR/MR: resolve it on the forge and fetch its head
	// commit host-side before the spawn, so the worktree can be based on it and
	// the head pre-linked to the MR (docs/pr-adoption.md).
	var adopt *heads.AdoptSpec
	if request.Body.AdoptMr != nil {
		spec, detail := s.resolveAdoptSpec(ctx, projectRoot, *request.Body.AdoptMr)
		if detail != "" {
			return api.SpawnAgent400JSONResponse{
				Code:    400,
				Error:   api.ErrorResponseErrorBadRequest,
				Details: detail,
			}, nil
		}
		adopt = spec
		// An adopted head's base is the PR's target branch; ignore any base_branch.
		baseBranch = ""
	}

	// Seed the new head's PTY at the spawning browser's geometry so the agent
	// renders at the right width from its first paint instead of the classic
	// 80x24 - those narrow-wrapped bytes can't be re-flowed once a wider client
	// replays the scrollback. The browser sends the last width it measured and
	// either its last height or the user's configured default height. For any
	// value the client omits (a fresh browser, or a non-web spawn), fall back to
	// the project's most recently reported width; a missing height is left to the
	// PTY's own 24-row default.
	rows, cols := spawnTermSize(request.Body.Rows, request.Body.Cols)
	if cols == 0 {
		if _, c, err := s.DB.LatestTermSizeForProject(projectRoot); err == nil && c > 0 {
			cols = c
		}
	}

	head, err := heads.SpawnHead(ctx, s.Sessions, s.DB, projectRoot, heads.SpawnHeadOptions{
		ID:            id,
		PrePrompt:     prePrompt,
		Prompt:        prompt,
		AgentType:     agentType,
		Model:         model,
		BaseBranch:    baseBranch,
		Adopt:         adopt,
		Ephemeral:     ephemeral,
		ChatMode:      chatMode,
		GitIsolation:  gitIsolation,
		Replace:       force,
		Rows:          rows,
		Cols:          cols,
		BackgroundCtx: s.BackgroundCtx,
		OnTitleChange: func() { s.notifyAgentsChanged(projectRoot, false) },
	})
	if err != nil {
		var exists *heads.HeadExistsError
		if errors.As(err, &exists) {
			return api.SpawnAgent409JSONResponse{
				Code:    409,
				Error:   api.ErrorResponseErrorConflict,
				Details: exists.Error(),
			}, nil
		}
		if errors.Is(err, heads.ErrInvalidHeadID) {
			return api.SpawnAgent400JSONResponse{
				Code:    400,
				Error:   api.ErrorResponseErrorBadRequest,
				Details: err.Error(),
			}, nil
		}
		return nil, errtrace.Wrap(err)
	}
	s.notifyAgentsChanged(projectRoot, true)
	// Use the review-aware response so an adopted head arrives already carrying its
	// MR link (a normal head has none, so this is equivalent to agentResponse).
	return api.SpawnAgent201JSONResponse(s.agentResponseWithReview(*head)), nil
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
	return api.GetAgent200JSONResponse(s.agentResponseWithReview(*head)), nil
}

// UpdateAgent patches an agent's mutable fields (title and/or base branch).
// Both are cheap metadata-only changes: the agent's stable ID, branch, worktree
// and live session are untouched, so it is safe even while the agent is running.
//
// base_branch updates only which branch the agent is considered based on (used
// by update-from-base and the diff view); it does NOT move existing commits.
// Rebasing the agent's branch onto the new base, if wanted, is left to the user.
func (s *Server) UpdateAgent(ctx context.Context, request api.UpdateAgentRequestObject) (api.UpdateAgentResponseObject, error) {
	if request.Body == nil {
		return api.UpdateAgent400JSONResponse{
			Code:    400,
			Error:   api.ErrorResponseErrorBadRequest,
			Details: "request body is required",
		}, nil
	}
	if request.Body.Title == nil && request.Body.BaseBranch == nil && request.Body.ChatMode == nil {
		return api.UpdateAgent400JSONResponse{
			Code:    400,
			Error:   api.ErrorResponseErrorBadRequest,
			Details: "at least one field (title, base_branch or chat_mode) is required",
		}, nil
	}

	var title string
	if request.Body.Title != nil {
		title = strings.TrimSpace(*request.Body.Title)
		if title == "" {
			return api.UpdateAgent400JSONResponse{
				Code:    400,
				Error:   api.ErrorResponseErrorBadRequest,
				Details: "title must not be empty",
			}, nil
		}
	}

	var baseBranch string
	if request.Body.BaseBranch != nil {
		baseBranch = strings.TrimSpace(*request.Body.BaseBranch)
		if baseBranch == "" {
			return api.UpdateAgent400JSONResponse{
				Code:    400,
				Error:   api.ErrorResponseErrorBadRequest,
				Details: "base_branch must not be empty",
			}, nil
		}
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

	if baseBranch != "" {
		// A head can't be based on its own branch: diffs and update-from-base
		// would compare it against itself. The UI already filters this out; reject
		// it here too so the invalid state can't be reached via the API.
		if head.Branch != nil && baseBranch == *head.Branch {
			return api.UpdateAgent400JSONResponse{
				Code:    400,
				Error:   api.ErrorResponseErrorBadRequest,
				Details: "base branch must differ from the agent's own branch",
			}, nil
		}
		// Validate the new base resolves to a real commit before persisting, so
		// update-from-base and diffs don't later fail against a bogus ref.
		if _, err := git.ResolveRef(projectRoot, baseBranch); err != nil {
			return api.UpdateAgent400JSONResponse{
				Code:    400,
				Error:   api.ErrorResponseErrorBadRequest,
				Details: fmt.Sprintf("base branch %q does not exist: %v", baseBranch, err),
			}, nil
		}
		if err := s.DB.UpdateAgentBaseBranch(request.Id, baseBranch); err != nil {
			return nil, errtrace.Wrap(err)
		}
		head.BaseBranch = baseBranch
	}

	if title != "" {
		if err := s.DB.UpdateAgentTitle(request.Id, title); err != nil {
			return nil, errtrace.Wrap(err)
		}
		head.Title = title
	}

	if request.Body.ChatMode != nil {
		chatMode := *request.Body.ChatMode
		if head.AgentType != sandbox.AgentTypeClaude && head.AgentType != sandbox.AgentTypeCodex {
			return api.UpdateAgent400JSONResponse{
				Code:    400,
				Error:   api.ErrorResponseErrorBadRequest,
				Details: "chat_mode is only supported for claude and codex agents",
			}, nil
		}
		if chatMode != head.ChatMode {
			if err := s.DB.UpdateAgentChatMode(request.Id, chatMode); err != nil {
				return nil, errtrace.Wrap(err)
			}
			head.ChatMode = chatMode
			// The mode is baked into the running CLI's argv, so a live session
			// must be relaunched to pick it up. Stop just the process (worktree,
			// branch and DB row untouched) and wait for it to exit before
			// responding; the client swaps panes and reconnects on the response,
			// and the on-attach lazy resume then relaunches with --continue in
			// the new mode - the conversation carries over (terminal and chat
			// mode share one transcript). A head with no live session simply
			// resumes in the new mode whenever it is next attached.
			if s.Sessions.IsLive(head.ID) {
				log.Printf("api: chat_mode toggled to %v for %s; stopping session for mode switch", chatMode, head.ID)
				heads.StopSessionAndWait(s.Sessions, head.ID, 5*time.Second)
			}
		}
	}

	s.notifyAgentsChanged(projectRoot, false)
	return api.UpdateAgent200JSONResponse(agentResponse(*head)), nil
}

// GenerateAgentTitle re-runs the spawn flow's one-shot title call against the
// agent's original task prompt and returns the result WITHOUT persisting it:
// the rename box drops it in as a draft so the user can edit or discard it
// before committing. That also makes it a safe retry for the case this exists
// for - a head whose background title generation failed at spawn (offline, out
// of credits, or the daemon restarting mid-call) and kept its truncated
// prompt-derived title.
func (s *Server) GenerateAgentTitle(ctx context.Context, request api.GenerateAgentTitleRequestObject) (api.GenerateAgentTitleResponseObject, error) {
	projectRoot, err := s.resolveProjectRoot(request.ProjectId)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	head, err := heads.GetHeadByID(ctx, s.Sessions, s.DB, projectRoot, request.Id)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	if head == nil {
		return api.GenerateAgentTitle404JSONResponse{
			Code:    404,
			Error:   api.ErrorResponseErrorNotFound,
			Details: "agent not found",
		}, nil
	}

	title, err := heads.GenerateTitle(ctx, projectRoot, head.Prompt)
	switch {
	case errors.Is(err, heads.ErrNoPrompt):
		return api.GenerateAgentTitle400JSONResponse{
			Code:    400,
			Error:   api.ErrorResponseErrorBadRequest,
			Details: "this agent has no task prompt to summarise",
		}, nil
	case err != nil:
		log.Printf("api: generate title for %s: %v", request.Id, err)
		return api.GenerateAgentTitle502JSONResponse{
			Code:    502,
			Error:   api.ErrorResponseErrorInternalError,
			Details: fmt.Sprintf("title generation failed: %v", err),
		}, nil
	}
	return api.GenerateAgentTitle200JSONResponse{Title: title}, nil
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
	// Clearing the unread flag changes both this project's list and the
	// cross-project unread totals.
	s.notifyAgentsChanged(projectRoot, true)
	return api.MarkAgentRead204Response{}, nil
}

func (s *Server) MarkAgentUnread(ctx context.Context, request api.MarkAgentUnreadRequestObject) (api.MarkAgentUnreadResponseObject, error) {
	projectRoot, err := s.resolveProjectRoot(request.ProjectId)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	head, err := heads.GetHeadByID(ctx, s.Sessions, s.DB, projectRoot, request.Id)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	if head == nil {
		return api.MarkAgentUnread404JSONResponse{
			Code:    404,
			Error:   api.ErrorResponseErrorNotFound,
			Details: "agent not found",
		}, nil
	}
	if err := s.DB.RaiseUnread(request.Id); err != nil {
		return nil, errtrace.Wrap(err)
	}
	// Raising the unread flag changes both this project's list and the
	// cross-project unread totals.
	s.notifyAgentsChanged(projectRoot, true)
	return api.MarkAgentUnread204Response{}, nil
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

	// A merged head loses its worktree; stop its live previews up front (the
	// reaper would catch it, but this keeps the teardown prompt).
	s.stopHeadPreviews(projectRoot, head.ID)

	// Test gate (PLAN #68): soft-block the merge when the head's configured tests
	// are failing, errored, or still running - unless force=true (which covers both
	// "don't wait" and "override"). Checked after the CAS claim so a concurrent
	// merge still 409s first, and before any worktree work so a blocked merge is
	// cheap. force always bypasses it.
	force := request.Params.Force != nil && *request.Params.Force
	if !force {
		if code, failing, blocked := s.testGateVerdict(projectRoot, *head); blocked {
			errMsg := "merge blocked: the head's tests are not passing (pass force=true to override)"
			if s.DB != nil {
				_ = s.DB.ClearHeadStatus(head.ID, &errMsg)
			}
			resp := api.MergeConflictError{Error: code, Code: 409, Details: errMsg}
			if code == api.MergeConflictErrorErrorTestsFailing {
				resp.FailingTests = &failing
			}
			return api.MergeAgent409JSONResponse(resp), nil
		}
	}

	closeHead := request.Params.Close == nil || *request.Params.Close
	conflict, err := s.performClaimedMerge(ctx, projectRoot, *head, closeHead)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	if conflict != nil {
		return api.MergeAgent409JSONResponse(*conflict), nil
	}
	return api.MergeAgent204Response{}, nil
}

// performClaimedMerge runs the actual branch merge for a head whose head_status
// has ALREADY been CAS-claimed as "merging" (by the MergeAgent handler or the
// auto-merge watcher). It validates the base ref, merges the head's branch into
// it, and - when closeHead is true - reparents stacked children and tears the
// head down as "merged". With closeHead false the head survives intact
// (session, worktree, branch) and just returns to idle, so the agent can keep
// working; its diff naturally resets to only-unmerged work because the base
// branch now contains the merged commits. On a recoverable failure it resets
// head_status and returns a non-nil *MergeConflictError (the caller maps it to
// a 409 or logs it); a nil error + nil conflict means the merge succeeded. The
// gate (PLAN #68) is the caller's responsibility - this assumes the decision to
// merge is already made.
func (s *Server) performClaimedMerge(ctx context.Context, projectRoot string, head heads.Head, closeHead bool) (*api.MergeConflictError, error) {
	if head.Branch == nil {
		return &api.MergeConflictError{Error: api.MergeConflictErrorErrorMergeConflict, Code: 409, Details: "agent has no git branch to merge"}, nil
	}
	branchName := *head.Branch

	// Merge the agent's branch INTO its base branch (which may be another agent's
	// hydra/<id> branch for stacked agents), not into whatever the project root
	// happens to have checked out. ResolveMergeDir gives us a worktree where the
	// base branch is checked out so the merge can advance it.
	target := head.BaseBranch
	if err := git.ValidateRef(target); err != nil {
		errMsg := fmt.Sprintf("invalid base branch %q: %v", target, err)
		if s.DB != nil {
			_ = s.DB.ClearHeadStatus(head.ID, &errMsg)
		}
		return &api.MergeConflictError{Error: api.MergeConflictErrorErrorMergeConflict, Code: 409, Details: errMsg}, nil
	}

	mergeDir, cleanup, err := heads.ResolveMergeDir(projectRoot, target)
	if err != nil {
		errMsg := fmt.Sprintf("merge failed: could not check out base branch %q: %v", target, err)
		if s.DB != nil {
			_ = s.DB.ClearHeadStatus(head.ID, &errMsg)
		}
		return &api.MergeConflictError{Error: api.MergeConflictErrorErrorMergeConflict, Code: 409, Details: errMsg}, nil
	}
	defer cleanup()

	// Get author info from git config
	authorName, authorEmail := gitConfigVal(projectRoot, "user.name"), gitConfigVal(projectRoot, "user.email")

	if err := git.Merge(mergeDir, branchName, authorName, authorEmail); err != nil {
		errMsg := fmt.Sprintf("merge failed: %v", err)
		if s.DB != nil {
			_ = s.DB.ClearHeadStatus(head.ID, &errMsg)
		}
		// Distinguish a real content conflict between the two branches from the
		// destination merely having uncommitted local changes the merge would
		// overwrite - the latter is fixed by committing/stashing, not by resolving
		// conflicts, so it gets its own error code and the offending file list.
		var dirty *git.DirtyMergeError
		if errors.As(err, &dirty) {
			files := dirty.Files
			return &api.MergeConflictError{Error: api.MergeConflictErrorErrorUncommittedChanges, Code: 409, Details: errMsg, ConflictingFiles: &files}, nil
		}
		return &api.MergeConflictError{Error: api.MergeConflictErrorErrorMergeConflict, Code: 409, Details: errMsg}, nil
	}

	// Keep-alive merge: the branch and worktree survive, so stacked children
	// still have a valid parent (no reparenting) and there is nothing to tear
	// down. Consume any merge-when-green intent - otherwise the auto-merge
	// watcher would later re-merge and KILL the head the user chose to keep -
	// and release the "merging" claim back to idle.
	if !closeHead {
		if s.DB != nil {
			_ = s.DB.SetMergeWhenGreen(head.ID, false, "")
			if err := s.DB.ClearHeadStatus(head.ID, nil); err != nil {
				return nil, errtrace.Wrap(err)
			}
		}
		s.notifyAgentsChanged(projectRoot, false)
		return nil, nil
	}

	// Reparent stacked children: any agent based on this agent's branch is moved
	// onto the branch we just merged into, so it doesn't dangle when this branch
	// is deleted. Metadata only (matches the base-branch editor's semantics).
	if s.DB != nil {
		children, err := s.DB.AgentsByBaseBranch(projectRoot, branchName)
		if err != nil {
			return nil, errtrace.Wrap(err)
		}
		for _, child := range children {
			if err := s.DB.UpdateAgentBaseBranch(child.ID, target); err != nil {
				return nil, errtrace.Wrap(err)
			}
		}
	}

	// Kill cleanup without re-doing the CAS (already in "merging" state).
	if err := heads.KillHeadNoLock(ctx, s.Sessions, s.DB, head, "merged"); err != nil {
		return nil, errtrace.Wrap(err)
	}

	s.notifyAgentsChanged(projectRoot, true)
	return nil, nil
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

	// Attempt merge (base branch into current branch). The worktree shares the main
	// repo's .git, so the local base ref is already current - no fetch needed.
	mergeRef := head.BaseBranch

	authorName, authorEmail := gitConfigVal(mergeDir, "user.name"), gitConfigVal(mergeDir, "user.email")

	if err := git.Merge(mergeDir, mergeRef, authorName, authorEmail); err != nil {
		errMsg := fmt.Sprintf("merge failed: %v", err)
		// As in MergeAgent: a dirty worktree that the merge would overwrite is
		// reported as uncommitted_changes (with the files), not as a content
		// conflict the user would resolve by editing.
		var dirty *git.DirtyMergeError
		if errors.As(err, &dirty) {
			files := dirty.Files
			return api.UpdateAgentFromBase409JSONResponse(api.MergeConflictError{
				Error:            api.MergeConflictErrorErrorUncommittedChanges,
				Code:             409,
				Details:          errMsg,
				ConflictingFiles: &files,
			}), nil
		}
		return api.UpdateAgentFromBase409JSONResponse(api.MergeConflictError{
			Error:   api.MergeConflictErrorErrorMergeConflict,
			Code:    409,
			Details: errMsg,
		}), nil
	}

	// The merge advanced the branch tip, so the cached test verdict is now
	// stale. Broadcast so the sidebar/agent detail refetch and reflect the new
	// status immediately, the same way MergeAgent does above.
	s.notifyAgentsChanged(projectRoot, false)
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
	s.stopHeadPreviews(projectRoot, head.ID)
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
		ID:         id,
		PrePrompt:  prePrompt,
		Prompt:     prompt,
		AgentType:  agentType,
		BaseBranch: baseBranch,
		ChatMode:   head.ChatMode,
		// The kill above just archived this ID; Replace lets the respawn take
		// the archived record back over instead of failing the ID-collision
		// check.
		Replace:       true,
		BackgroundCtx: s.BackgroundCtx,
	})
	if err != nil {
		return nil, errtrace.Wrap(err)
	}

	return api.RestartAgent200JSONResponse(agentResponse(*newHead)), nil
}

// RestartAgentSession restarts only the agent's CLI process: it stops the live
// session, waits for it to exit, and resumes it (re-seeding from the current
// config) so it continues from its transcript via --continue. Nothing else is
// touched - no worktree, branch, DB row or transcript teardown - which is what
// separates it from RestartAgent (a full kill + fresh respawn). Same primitive
// the MCP-grant auto-relaunch uses; see heads.RestartHead.
func (s *Server) RestartAgentSession(ctx context.Context, request api.RestartAgentSessionRequestObject) (api.RestartAgentSessionResponseObject, error) {
	projectRoot, err := s.resolveProjectRoot(request.ProjectId)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	log.Printf("api: restart agent session request: id=%q, project=%q", request.Id, projectRoot)
	head, err := heads.GetHeadByID(ctx, s.Sessions, s.DB, projectRoot, request.Id)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	if head == nil {
		return api.RestartAgentSession404JSONResponse{
			Code:    404,
			Error:   api.ErrorResponseErrorNotFound,
			Details: "agent not found",
		}, nil
	}
	// An archived head has no worktree to relaunch into - reviving one is
	// ResumeAgent's job, not this button's.
	if head.Archived || head.Worktree == nil {
		return api.RestartAgentSession409JSONResponse{
			Code:    409,
			Error:   api.ErrorResponseErrorConflict,
			Details: "agent has no live worktree to restart into",
		}, nil
	}

	// Restart synchronously: the client reconnects its terminal/chat pane on the
	// response, so returning only once the new session is live means it attaches
	// to that one rather than racing the dying process.
	rows, cols := heads.LoadResumeSize(s.DB, projectRoot, head.ID)
	if err := heads.RestartHead(s.Sessions, s.DB, projectRoot, *head, rows, cols); err != nil {
		if errors.Is(err, db.ErrOperationInProgress) {
			return api.RestartAgentSession409JSONResponse{
				Code:    409,
				Error:   api.ErrorResponseErrorConflict,
				Details: "operation already in progress",
			}, nil
		}
		return nil, errtrace.Wrap(err)
	}

	s.notifyAgentsChanged(projectRoot, false)
	return api.RestartAgentSession204Response{}, nil
}

// ResumeAgent revives an archived (killed/merged) agent: it recreates the
// worktree+branch off the current base, un-archives the record, and relaunches
// the agent so it continues from its saved conversation transcript. Unlike
// RestartAgent (a fresh respawn), this preserves the prior conversation - see
// heads.ResumeArchivedHead / PLAN #49.
func (s *Server) ResumeAgent(ctx context.Context, request api.ResumeAgentRequestObject) (api.ResumeAgentResponseObject, error) {
	projectRoot, err := s.resolveProjectRoot(request.ProjectId)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	log.Printf("api: resume archived agent request: id=%q, project=%q", request.Id, projectRoot)

	newHead, err := heads.ResumeArchivedHead(ctx, s.Sessions, s.DB, projectRoot, request.Id, 0, 0)
	if err != nil {
		if errors.Is(err, db.ErrOperationInProgress) {
			return api.ResumeAgent409JSONResponse{
				Code:    409,
				Error:   api.ErrorResponseErrorConflict,
				Details: "operation already in progress",
			}, nil
		}
		return nil, errtrace.Wrap(err)
	}
	if newHead == nil {
		return api.ResumeAgent404JSONResponse{
			Code:    404,
			Error:   api.ErrorResponseErrorNotFound,
			Details: "archived agent not found",
		}, nil
	}

	s.notifyAgentsChanged(projectRoot, true)
	return api.ResumeAgent200JSONResponse(agentResponse(*newHead)), nil
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

	s.stopHeadPreviews(projectRoot, head.ID)
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

	s.notifyAgentsChanged(projectRoot, true)
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
	// case - purging from the read-only archived-history view).
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

	s.stopHeadPreviews(projectRoot, head.ID)
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

	s.notifyAgentsChanged(projectRoot, true)
	return api.PurgeAgent204Response{}, nil
}

// listCommitsCached returns the commits between baseBranch and headBranch, served
// from cache when both refs resolve to commit SHAs - commits are immutable, so the
// result is stable for a given (baseSHA, headSHA) pair. If either ref fails to
// resolve it falls back to a direct, uncached read. The key is namespaced by
// project root so the single shared daemon never crosses repos.
func (s *Server) listCommitsCached(projectRoot, baseBranch, headBranch string) ([]git.CommitInfo, error) {
	baseSHA, errBase := git.ResolveRef(projectRoot, baseBranch)
	headSHA, errHead := git.ResolveRef(projectRoot, headBranch)
	if errBase != nil || errHead != nil {
		return errtrace.Wrap2(git.ListFirstParentCommits(projectRoot, baseBranch, headBranch))
	}
	key := strings.Join([]string{projectRoot, baseSHA, headSHA}, "\x00")
	if v, ok := s.commitsCache.get(key); ok {
		return v, nil
	}
	commits, err := git.ListFirstParentCommits(projectRoot, baseBranch, headBranch)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	s.commitsCache.put(key, commits, commitsCost(commits))
	return commits, nil
}

// commitsCost estimates the in-memory byte size of a commit list, used to charge
// the entry against the cache's byte budget. It need only be roughly proportional
// to the real footprint; per-string overhead is a flat constant per commit.
func commitsCost(commits []git.CommitInfo) int64 {
	const perCommitOverhead = 128 // struct + string headers, approximate
	var n int64
	for _, c := range commits {
		n += perCommitOverhead +
			int64(len(c.SHA)+len(c.ShortSHA)+len(c.Message)+len(c.Subject)+len(c.AuthorName)+len(c.AuthorEmail)+len(c.Timestamp))
	}
	return n
}

// getDiffCached returns the parsed diff. A committed-only diff (both refs resolve
// to commit SHAs) is immutable and served from cache; an uncommitted diff reflects
// the mutable working tree, so it is always recomputed live and never cached.
// diffRoot is where git runs (the agent worktree for uncommitted diffs, otherwise
// the project root); refs are resolved against projectRoot. The key folds in every
// option that changes the output (refs, whitespace, dot-mode, path, context).
func (s *Server) getDiffCached(projectRoot, diffRoot, baseRef, headRef string, ignoreWhitespace, useTripleDot bool, path string, contextLines int, includeUncommitted bool) ([]git.DiffFile, error) {
	var paths []string
	if path != "" {
		paths = []string{path}
	}
	return errtrace.Wrap2(s.getDiffCachedPaths(projectRoot, diffRoot, baseRef, headRef, ignoreWhitespace, useTripleDot, paths, contextLines, includeUncommitted))
}

func (s *Server) getDiffCachedPaths(projectRoot, diffRoot, baseRef, headRef string, ignoreWhitespace, useTripleDot bool, paths []string, contextLines int, includeUncommitted bool) ([]git.DiffFile, error) {
	live := func() ([]git.DiffFile, error) {
		return errtrace.Wrap2(git.GetDiffPaths(diffRoot, baseRef, headRef, ignoreWhitespace, useTripleDot, paths, contextLines))
	}
	if includeUncommitted {
		return errtrace.Wrap2(live())
	}
	baseSHA, errBase := git.ResolveRef(projectRoot, baseRef)
	headSHA, errHead := git.ResolveRef(projectRoot, headRef)
	if errBase != nil || errHead != nil {
		return errtrace.Wrap2(live())
	}
	dot := "2dot"
	if useTripleDot {
		dot = "3dot"
	}
	ws := "ws0"
	if ignoreWhitespace {
		ws = "ws1"
	}
	// Join paths with a separator that can't appear in a path so distinct path
	// sets map to distinct keys. A single path or the empty (all-files) set
	// collapse to the same key shape they used before this became paths-based.
	key := strings.Join([]string{projectRoot, baseSHA, headSHA, dot, ws, "ctx" + strconv.Itoa(contextLines), strings.Join(paths, "\x01")}, "\x00")
	if v, ok := s.diffCache.get(key); ok {
		return v, nil
	}
	diff, err := live()
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	s.diffCache.put(key, diff, diffCost(diff))
	return diff, nil
}

// fullFileContext is a context width large enough to pull each file as a single
// whole-file hunk, so the client can reveal hidden lines without re-fetching.
// Mirrors the web client's FULL_FILE_CONTEXT.
const fullFileContext = 1_000_000

// getFullContextDiff returns the whole diff with every eligible file expanded to
// its full content in a single response, so the client need not fire one request
// per file. It runs the normal-context diff (for change counts and the
// large-file fallback) plus one scoped full-context diff over only the files
// small enough to expand, then merges. Files whose change count or expanded line
// count exceeds maxFullLines keep their normal-context hunks.
func (s *Server) getFullContextDiff(projectRoot, diffRoot, baseRef, headRef string, ignoreWhitespace, useTripleDot bool, normalContext, maxFullChanges, maxFullLines int, includeUncommitted bool) ([]git.DiffFile, error) {
	base, err := s.getDiffCachedPaths(projectRoot, diffRoot, baseRef, headRef, ignoreWhitespace, useTripleDot, nil, normalContext, includeUncommitted)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}

	// Only expand files small enough to be worth shipping in full: the
	// changed-line cap keeps the expensive full-context git call (and the extra
	// payload) off large files the client hides by default anyway.
	var candidates []string
	for _, f := range base {
		if f.Binary || len(f.Hunks) == 0 {
			continue
		}
		if f.Additions+f.Deletions > maxFullChanges {
			continue
		}
		candidates = append(candidates, f.Path)
	}
	if len(candidates) == 0 {
		return base, nil
	}
	sort.Strings(candidates)

	full, err := s.getDiffCachedPaths(projectRoot, diffRoot, baseRef, headRef, ignoreWhitespace, useTripleDot, candidates, fullFileContext, includeUncommitted)
	if err != nil {
		// Full expansion is best-effort: fall back to the normal-context diff.
		return base, nil
	}
	fullByPath := make(map[string]git.DiffFile, len(full))
	for _, f := range full {
		fullByPath[f.Path] = f
	}
	// base is the cached normal-context slice - copy it before swapping hunks in
	// so we don't mutate the cache entry shared with non-full-context callers.
	merged := append([]git.DiffFile(nil), base...)
	for i := range merged {
		ff, ok := fullByPath[merged[i].Path]
		if !ok {
			continue
		}
		// Drop the full version if expansion blew past the cap (e.g. a few changed
		// lines scattered through a very long file); keep the normal-context hunks.
		lines := 0
		for _, h := range ff.Hunks {
			lines += len(h.Lines)
		}
		if lines > maxFullLines {
			continue
		}
		merged[i].Hunks = ff.Hunks
		merged[i].Expanded = true
	}
	return merged, nil
}

// diffCost estimates the in-memory byte size of a parsed diff, used to charge the
// entry against the cache's byte budget. A diff's footprint is dominated by its
// lines (each carries a Content string plus two *int line numbers), so it sums the
// line content with a flat per-line overhead; this is what makes a huge
// generated-file diff register as expensive and either evict aggressively or skip
// caching, instead of silently retaining many gigabytes.
func diffCost(files []git.DiffFile) int64 {
	const (
		perFileOverhead = 96 // struct + Path/OldPath string headers, approximate
		perHunkOverhead = 48 // struct + Header string, approximate
		perLineOverhead = 64 // DiffLine struct + string header + two *int allocations
	)
	var n int64
	for _, f := range files {
		n += perFileOverhead + int64(len(f.Path))
		if f.OldPath != nil {
			n += int64(len(*f.OldPath))
		}
		for _, h := range f.Hunks {
			n += perHunkOverhead + int64(len(h.Header))
			for _, l := range h.Lines {
				n += perLineOverhead + int64(len(l.Content))
			}
		}
	}
	return n
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

// apiDiffFiles converts a slice of git.DiffFile into the API shape, shared by the
// agent diff and the repository diff so both serialise diffs identically.
func apiDiffFiles(diffFiles []git.DiffFile) []api.DiffFile {
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
		var expanded *bool
		if f.Expanded {
			t := true
			expanded = &t
		}
		var headBlobSHA *string
		if f.HeadBlobSHA != "" {
			s := f.HeadBlobSHA
			headBlobSHA = &s
		}
		apiFiles[i] = api.DiffFile{
			Path:        f.Path,
			OldPath:     f.OldPath,
			ChangeType:  api.DiffFileChangeType(f.ChangeType),
			Additions:   f.Additions,
			Deletions:   f.Deletions,
			Binary:      f.Binary,
			Expanded:    expanded,
			HeadBlobSha: headBlobSHA,
			Hunks:       apiHunks,
		}
	}
	return apiFiles
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
	// A head can be interrupted before its named branch ref is created (or the
	// ref may disappear while the retained worktree still has a valid detached
	// HEAD). The default agent comparison should use that worktree commit rather
	// than exposing git's ambiguous-revision error in the Files panel. Explicit
	// caller-supplied refs still fail normally so typos are not hidden.
	if request.Params.HeadRef == nil || *request.Params.HeadRef == "" {
		if resolved, ok := resolveDefaultAgentHead(projectRoot, head.Worktree, headRef); ok {
			headRef = resolved
		} else {
			empty := api.DiffResponse{Files: []api.DiffFile{}, BaseRef: baseRef, HeadRef: headRef}
			return api.GetAgentDiff200JSONResponse(empty), nil
		}
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

	fullContext := request.Params.FullContext != nil && *request.Params.FullContext
	maxFullChanges := 1000
	if request.Params.MaxFullChanges != nil {
		maxFullChanges = *request.Params.MaxFullChanges
	}
	maxFullLines := 6000
	if request.Params.MaxFullLines != nil {
		maxFullLines = *request.Params.MaxFullLines
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

	// full_context expands every eligible file in one response (no per-file
	// follow-up requests). It only applies to the whole-diff view; a specific
	// path request keeps the single-file path.
	var diffFiles []git.DiffFile
	if fullContext && path == "" {
		diffFiles, err = s.getFullContextDiff(projectRoot, diffRoot, baseRef, headRef, ignoreWhitespace, useTripleDot, contextLines, maxFullChanges, maxFullLines, includeUncommitted)
	} else {
		diffFiles, err = s.getDiffCached(projectRoot, diffRoot, baseRef, headRef, ignoreWhitespace, useTripleDot, path, contextLines, includeUncommitted)
	}
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
	apiFiles := apiDiffFiles(diffFiles)

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
			uncommittedSummary = apiUncommittedSummary(summary)
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

// uncommittedFilesLimit caps how many paths each side of an UncommittedSummary
// carries over the wire. The diff endpoint is polled, and a worktree with a
// thousand untracked files would otherwise ship a thousand paths every time; the
// counts stay exact, so the UI can still say how many it isn't showing.
const uncommittedFilesLimit = 50

func apiUncommittedSummary(s *git.UncommittedSummary) *api.UncommittedSummary {
	tracked := capPaths(s.TrackedFiles)
	untracked := capPaths(s.UntrackedFiles)
	return &api.UncommittedSummary{
		TrackedCount:   s.TrackedCount,
		UntrackedCount: s.UntrackedCount,
		TrackedFiles:   &tracked,
		UntrackedFiles: &untracked,
	}
}

func capPaths(paths []string) []string {
	if len(paths) > uncommittedFilesLimit {
		return paths[:uncommittedFilesLimit]
	}
	return paths
}

func resolveDefaultAgentHead(projectRoot string, worktree *string, headRef string) (string, bool) {
	if _, err := git.ResolveRef(projectRoot, headRef); err == nil {
		return headRef, true
	}
	if worktree != nil {
		if worktreeHead, err := git.ResolveRef(*worktree, "HEAD"); err == nil {
			return worktreeHead, true
		}
	}
	return headRef, false
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
			uncommittedSummary = apiUncommittedSummary(summary)
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

	// Chat-mode heads are driven over the Claude stream-json interface, not an
	// interactive TUI: their stdin expects JSON user_message lines, so the
	// bracketed-paste keystroke burst below never registers as a turn (the text
	// just vanishes). Deliver it as a chat user turn instead, so diff comments
	// and "Fix with agent" reach a chat agent the same way they reach a terminal
	// one. Submitted un-queued: the message goes to the CLI now (started as the
	// next turn when idle, steered in at the next step boundary when a turn is
	// running) rather than being held pending a status-driven drain.
	if head.ChatMode && s.ChatQueues != nil {
		id := fmt.Sprintf("hydra-input-%d", agentInputSeq.Add(1))
		s.ChatQueues.Submit(projectRoot, head.ID, heads.QueuedMessage{
			ID:      id,
			Content: claudestream.TextUserContent(text),
		}, false)
		return api.SendAgentInput200Response{}, nil
	}

	if head.AgentType != sandbox.AgentTypeBash {
		// Deliver the message as a bracketed paste so multi-line input lands in
		// the prompt verbatim. Without the explicit markers the agent TUIs detect
		// the multi-line burst as a paste and fold a trailing carriage return into
		// the message instead of submitting it, leaving the text typed-but-not-sent
		// (e.g. diff comments). It also stops gemini-cli treating a leading ! as a
		// shell command.
		text = "\x1b[200~" + text + "\x1b[201~"
	}

	if err := s.Sessions.Write(head.ID, []byte(text)); err != nil {
		return api.SendAgentInput500JSONResponse{
			Code:    500,
			Error:   api.ErrorResponseErrorInternalError,
			Details: "failed to write to agent stdin: " + err.Error(),
		}, nil
	}

	// Submit with a separate Enter keystroke once the paste has settled. Sent in
	// the same write as the message it gets absorbed as paste content rather than
	// registering as a submit, which is exactly the bug above - this mirrors a
	// real user pasting text and then pressing Enter.
	select {
	case <-time.After(100 * time.Millisecond):
	case <-ctx.Done():
		return nil, errtrace.Wrap(ctx.Err())
	}
	if err := s.Sessions.Write(head.ID, []byte("\r")); err != nil {
		return api.SendAgentInput500JSONResponse{
			Code:    500,
			Error:   api.ErrorResponseErrorInternalError,
			Details: "failed to submit agent input: " + err.Error(),
		}, nil
	}

	return api.SendAgentInput200Response{}, nil
}
