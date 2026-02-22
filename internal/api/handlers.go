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

	agentpkg "github.com/trolleyman/hydra/internal/agent"
	"github.com/trolleyman/hydra/internal/db"
)

const version = "0.1.0"

// Server implements StrictServerInterface.
type Server struct {
	DB           *sql.DB
	Manager      *agentpkg.Manager
	WorktreesDir string
}

// newServer creates a handler with the strict wrapper and SSE override.
func NewHandler(s *Server) http.Handler {
	strict := NewStrictHandler(s, nil)
	wrapper := &sseOverride{ServerInterface: strict, server: s}
	return HandlerFromMux(wrapper, http.NewServeMux())
}

// sseOverride wraps the generated strict handler, overriding handlers that need direct HTTP access.
type sseOverride struct {
	ServerInterface
	server *Server
}

func (o *sseOverride) StreamAgentLogs(w http.ResponseWriter, r *http.Request, projectId, agentId string) {
	o.server.streamLogsSSE(w, r, projectId, agentId)
}

func (o *sseOverride) PickFolder(w http.ResponseWriter, r *http.Request) {
	if !isLocalhostRequest(r) {
		WriteError(w, http.StatusForbidden, "pick-folder is only available on localhost")
		return
	}
	path, err := openFolderPicker()
	if err != nil {
		WriteError(w, http.StatusInternalServerError, err.Error())
		return
	}
	WriteJSON(w, http.StatusOK, PickFolderResponse{Path: path})
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

func (s *Server) ListAgentTypes(_ context.Context, _ ListAgentTypesRequestObject) (ListAgentTypesResponseObject, error) {
	types := builtinAgentTypes()
	return ListAgentTypes200JSONResponse(types), nil
}

func (s *Server) PickFolder(_ context.Context, request PickFolderRequestObject) (PickFolderResponseObject, error) {
	// Only allow on localhost - checked in handler wrapper
	path, err := openFolderPicker()
	if err != nil {
		return PickFolder500JSONResponse(ErrorResponse{Code: 500, Error: err.Error()}), nil
	}
	return PickFolder200JSONResponse(PickFolderResponse{Path: path}), nil
}

func (s *Server) ListProjects(_ context.Context, _ ListProjectsRequestObject) (ListProjectsResponseObject, error) {
	projects, err := db.ListProjects(s.DB)
	if err != nil {
		return ListProjects500JSONResponse(ErrorResponse{Code: 500, Error: err.Error()}), nil
	}
	result := make([]Project, len(projects))
	for i, p := range projects {
		result[i] = dbProjectToAPI(p)
	}
	return ListProjects200JSONResponse(result), nil
}

func (s *Server) CreateProject(_ context.Context, request CreateProjectRequestObject) (CreateProjectResponseObject, error) {
	if request.Body == nil || request.Body.Path == "" {
		return CreateProject400JSONResponse(ErrorResponse{Code: 400, Error: "path is required"}), nil
	}
	p, err := db.CreateProject(s.DB, request.Body.Path)
	if err != nil {
		return CreateProject500JSONResponse(ErrorResponse{Code: 500, Error: err.Error()}), nil
	}
	return CreateProject201JSONResponse(dbProjectToAPI(p)), nil
}

func (s *Server) GetProject(_ context.Context, request GetProjectRequestObject) (GetProjectResponseObject, error) {
	p, err := db.GetProject(s.DB, request.ProjectId)
	if errors.Is(err, db.ErrNotFound) {
		return GetProject404JSONResponse(ErrorResponse{Code: 404, Error: "project not found"}), nil
	}
	if err != nil {
		return GetProject500JSONResponse(ErrorResponse{Code: 500, Error: err.Error()}), nil
	}
	_ = db.TouchProject(s.DB, p.ID)
	return GetProject200JSONResponse(dbProjectToAPI(p)), nil
}

func (s *Server) DeleteProject(_ context.Context, request DeleteProjectRequestObject) (DeleteProjectResponseObject, error) {
	err := db.DeleteProject(s.DB, request.ProjectId)
	if errors.Is(err, db.ErrNotFound) {
		return DeleteProject404JSONResponse(ErrorResponse{Code: 404, Error: "project not found"}), nil
	}
	if err != nil {
		return DeleteProject500JSONResponse(ErrorResponse{Code: 500, Error: err.Error()}), nil
	}
	return DeleteProject204Response{}, nil
}

func (s *Server) ListAgents(_ context.Context, request ListAgentsRequestObject) (ListAgentsResponseObject, error) {
	if _, err := db.GetProject(s.DB, request.ProjectId); errors.Is(err, db.ErrNotFound) {
		return ListAgents404JSONResponse(ErrorResponse{Code: 404, Error: "project not found"}), nil
	}
	agents, err := db.ListAgents(s.DB, request.ProjectId)
	if err != nil {
		return ListAgents500JSONResponse(ErrorResponse{Code: 500, Error: err.Error()}), nil
	}
	result := make([]Agent, len(agents))
	for i, a := range agents {
		result[i] = dbAgentToAPI(a)
	}
	return ListAgents200JSONResponse(result), nil
}

func (s *Server) CreateAgent(_ context.Context, request CreateAgentRequestObject) (CreateAgentResponseObject, error) {
	project, err := db.GetProject(s.DB, request.ProjectId)
	if errors.Is(err, db.ErrNotFound) {
		return CreateAgent404JSONResponse(ErrorResponse{Code: 404, Error: "project not found"}), nil
	}
	if err != nil {
		return CreateAgent500JSONResponse(ErrorResponse{Code: 500, Error: err.Error()}), nil
	}

	if request.Body == nil {
		return CreateAgent400JSONResponse(ErrorResponse{Code: 400, Error: "request body required"}), nil
	}

	params := db.CreateAgentParams{
		ProjectID:       request.ProjectId,
		Prompt:          request.Body.Prompt,
		AIProvider:      string(request.Body.AiProvider),
		SandboxTemplate: request.Body.SandboxTemplate,
		WorktreesDir:    s.WorktreesDir,
	}
	agent, err := db.CreateAgent(s.DB, params)
	if err != nil {
		return CreateAgent500JSONResponse(ErrorResponse{Code: 500, Error: err.Error()}), nil
	}

	// Start agent asynchronously
	s.Manager.Start(context.Background(), agent, project.Path)

	return CreateAgent201JSONResponse(dbAgentToAPI(agent)), nil
}

func (s *Server) GetAgent(_ context.Context, request GetAgentRequestObject) (GetAgentResponseObject, error) {
	agent, err := db.GetAgent(s.DB, request.ProjectId, request.AgentId)
	if errors.Is(err, db.ErrNotFound) {
		return GetAgent404JSONResponse(ErrorResponse{Code: 404, Error: "agent not found"}), nil
	}
	if err != nil {
		return GetAgent500JSONResponse(ErrorResponse{Code: 500, Error: err.Error()}), nil
	}
	return GetAgent200JSONResponse(dbAgentToAPI(agent)), nil
}

func (s *Server) DeleteAgent(_ context.Context, request DeleteAgentRequestObject) (DeleteAgentResponseObject, error) {
	agent, err := db.GetAgent(s.DB, request.ProjectId, request.AgentId)
	if errors.Is(err, db.ErrNotFound) {
		return DeleteAgent404JSONResponse(ErrorResponse{Code: 404, Error: "agent not found"}), nil
	}
	if err != nil {
		return DeleteAgent500JSONResponse(ErrorResponse{Code: 500, Error: err.Error()}), nil
	}

	// Stop sandbox if running
	if agent.SandboxID != nil {
		_ = agentpkg.Stop(context.Background(), *agent.SandboxID)
	}

	// Remove worktree
	project, _ := db.GetProject(s.DB, agent.ProjectID)
	if project.Path != "" {
		_ = agentpkg.RemoveWorktree(context.Background(), project.Path, agent.WorktreePath, agent.Branch)
	}

	if err := db.DeleteAgent(s.DB, request.ProjectId, request.AgentId); err != nil {
		return DeleteAgent500JSONResponse(ErrorResponse{Code: 500, Error: err.Error()}), nil
	}
	return DeleteAgent204Response{}, nil
}

func (s *Server) MergeAgent(_ context.Context, request MergeAgentRequestObject) (MergeAgentResponseObject, error) {
	agent, err := db.GetAgent(s.DB, request.ProjectId, request.AgentId)
	if errors.Is(err, db.ErrNotFound) {
		return MergeAgent404JSONResponse(ErrorResponse{Code: 404, Error: "agent not found"}), nil
	}
	if err != nil {
		return MergeAgent500JSONResponse(ErrorResponse{Code: 500, Error: err.Error()}), nil
	}

	project, err := db.GetProject(s.DB, agent.ProjectID)
	if err != nil {
		return MergeAgent500JSONResponse(ErrorResponse{Code: 500, Error: err.Error()}), nil
	}

	// Stop sandbox if running
	if agent.SandboxID != nil {
		_ = agentpkg.Stop(context.Background(), *agent.SandboxID)
	}

	// Merge branch
	if err := agentpkg.MergeWorktree(context.Background(), project.Path, agent.Branch); err != nil {
		errMsg := err.Error()
		return MergeAgent409JSONResponse(ErrorResponse{Code: 409, Error: "merge conflict", Details: &errMsg}), nil
	}

	// Remove worktree and branch
	_ = agentpkg.RemoveWorktree(context.Background(), project.Path, agent.WorktreePath, agent.Branch)

	// Update status
	_ = db.UpdateAgentStatus(s.DB, agent.ID, "deleted")

	agent.Status = "deleted"
	return MergeAgent200JSONResponse(dbAgentToAPI(agent)), nil
}

// StreamAgentLogs is handled directly via sseOverride.streamLogsSSE.
func (s *Server) StreamAgentLogs(_ context.Context, _ StreamAgentLogsRequestObject) (StreamAgentLogsResponseObject, error) {
	return nil, fmt.Errorf("StreamAgentLogs should be handled by sseOverride")
}

func (s *Server) streamLogsSSE(w http.ResponseWriter, r *http.Request, projectId, agentId string) {
	agent, err := db.GetAgent(s.DB, projectId, agentId)
	if errors.Is(err, db.ErrNotFound) {
		WriteError(w, 404, "agent not found")
		return
	}
	if err != nil {
		WriteError(w, 500, err.Error())
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	flusher, canFlush := w.(http.Flusher)

	// Send existing log tail first
	if agent.LogTail != nil && *agent.LogTail != "" {
		fmt.Fprintf(w, "data: %s\n\n", strings.ReplaceAll(*agent.LogTail, "\n", "\ndata: "))
		if canFlush {
			flusher.Flush()
		}
	}

	// If agent is still running, stream live logs
	if agent.Status == "running" || agent.Status == "starting" || agent.Status == "committing" {
		sandboxID := agentId
		if agent.SandboxID != nil {
			sandboxID = *agent.SandboxID
		}

		ch := agentpkg.LogStream(r.Context(), sandboxID)
		for chunk := range ch {
			lines := strings.Split(chunk, "\n")
			for _, line := range lines {
				fmt.Fprintf(w, "data: %s\n", line)
			}
			fmt.Fprintf(w, "\n")
			if canFlush {
				flusher.Flush()
			}
		}
	}

	// Send done event
	fmt.Fprintf(w, "event: done\ndata: {}\n\n")
	if canFlush {
		flusher.Flush()
	}
}

func (s *Server) GetRootRepositoryDirectory(_ context.Context, request GetRootRepositoryDirectoryRequestObject) (GetRootRepositoryDirectoryResponseObject, error) {
	project, err := db.GetProject(s.DB, request.ProjectId)
	if errors.Is(err, db.ErrNotFound) {
		return GetRootRepositoryDirectory404JSONResponse(ErrorResponse{Code: 404, Error: "project not found"}), nil
	}
	if err != nil {
		return GetRootRepositoryDirectory500JSONResponse(ErrorResponse{Code: 500, Error: err.Error()}), nil
	}

	branch := ""
	if request.Params.Branch != nil {
		branch = *request.Params.Branch
	}

	absPath, err := resolveRepoPath(project.Path, "", branch)
	if err != nil {
		return GetRootRepositoryDirectory404JSONResponse(ErrorResponse{Code: 404, Error: "path not found"}), nil
	}

	info, err := readDirectory(absPath, "", branch)
	if err != nil {
		return GetRootRepositoryDirectory500JSONResponse(ErrorResponse{Code: 500, Error: err.Error()}), nil
	}

	return GetRootRepositoryDirectory200JSONResponse(info), nil
}

func (s *Server) GetRepositoryDirectory(_ context.Context, request GetRepositoryDirectoryRequestObject) (GetRepositoryDirectoryResponseObject, error) {
	project, err := db.GetProject(s.DB, request.ProjectId)
	if errors.Is(err, db.ErrNotFound) {
		return GetRepositoryDirectory404JSONResponse(ErrorResponse{Code: 404, Error: "project not found"}), nil
	}
	if err != nil {
		return GetRepositoryDirectory500JSONResponse(ErrorResponse{Code: 500, Error: err.Error()}), nil
	}

	relPath := request.Path
	if err := validatePath(relPath); err != nil {
		return GetRepositoryDirectory400JSONResponse(ErrorResponse{Code: 400, Error: err.Error()}), nil
	}

	branch := ""
	if request.Params.Branch != nil {
		branch = *request.Params.Branch
	}

	absPath, err := resolveRepoPath(project.Path, relPath, branch)
	if err != nil {
		return GetRepositoryDirectory404JSONResponse(ErrorResponse{Code: 404, Error: "path not found"}), nil
	}

	info, err := readDirectory(absPath, relPath, branch)
	if err != nil {
		return GetRepositoryDirectory500JSONResponse(ErrorResponse{Code: 500, Error: err.Error()}), nil
	}

	return GetRepositoryDirectory200JSONResponse(info), nil
}

func (s *Server) GetRepositoryFileMeta(_ context.Context, request GetRepositoryFileMetaRequestObject) (GetRepositoryFileMetaResponseObject, error) {
	project, err := db.GetProject(s.DB, request.ProjectId)
	if errors.Is(err, db.ErrNotFound) {
		return GetRepositoryFileMeta404JSONResponse(ErrorResponse{Code: 404, Error: "project not found"}), nil
	}
	if err != nil {
		return GetRepositoryFileMeta500JSONResponse(ErrorResponse{Code: 500, Error: err.Error()}), nil
	}

	relPath := request.Path
	if err := validatePath(relPath); err != nil {
		return GetRepositoryFileMeta400JSONResponse(ErrorResponse{Code: 400, Error: err.Error()}), nil
	}

	branch := ""
	if request.Params.Branch != nil {
		branch = *request.Params.Branch
	}

	absPath, err := resolveRepoPath(project.Path, relPath, branch)
	if err != nil {
		return GetRepositoryFileMeta404JSONResponse(ErrorResponse{Code: 404, Error: "path not found"}), nil
	}

	stat, err := os.Stat(absPath)
	if err != nil {
		return GetRepositoryFileMeta404JSONResponse(ErrorResponse{Code: 404, Error: "file not found"}), nil
	}

	name := filepath.Base(absPath)
	mime := guessMimeType(name)
	isBinary := isBinaryFile(absPath)
	meta := FileMeta{
		Path:     relPath,
		Name:     name,
		Size:     stat.Size(),
		MimeType: mime,
		IsBinary: &isBinary,
	}
	if branch != "" {
		meta.Branch = &branch
	}

	return GetRepositoryFileMeta200JSONResponse(meta), nil
}

func (s *Server) GetRepositoryFile(_ context.Context, request GetRepositoryFileRequestObject) (GetRepositoryFileResponseObject, error) {
	project, err := db.GetProject(s.DB, request.ProjectId)
	if errors.Is(err, db.ErrNotFound) {
		return GetRepositoryFile404JSONResponse(ErrorResponse{Code: 404, Error: "project not found"}), nil
	}
	if err != nil {
		return GetRepositoryFile500JSONResponse(ErrorResponse{Code: 500, Error: err.Error()}), nil
	}

	relPath := request.Path
	if err := validatePath(relPath); err != nil {
		return GetRepositoryFile400JSONResponse(ErrorResponse{Code: 400, Error: err.Error()}), nil
	}

	branch := ""
	if request.Params.Branch != nil {
		branch = *request.Params.Branch
	}

	absPath, err := resolveRepoPath(project.Path, relPath, branch)
	if err != nil {
		return GetRepositoryFile404JSONResponse(ErrorResponse{Code: 404, Error: "path not found"}), nil
	}

	f, err := os.Open(absPath)
	if err != nil {
		return GetRepositoryFile404JSONResponse(ErrorResponse{Code: 404, Error: "file not found"}), nil
	}

	stat, err := os.Stat(absPath)
	if err != nil {
		f.Close()
		return GetRepositoryFile500JSONResponse(ErrorResponse{Code: 500, Error: err.Error()}), nil
	}

	return GetRepositoryFile200ApplicationoctetStreamResponse{
		Body:          f,
		ContentLength: stat.Size(),
	}, nil
}

// --- helpers ---

func dbProjectToAPI(p db.Project) Project {
	return Project{
		Id:         p.ID,
		Name:       p.Name,
		Path:       p.Path,
		CreatedAt:  p.CreatedAt,
		LastOpened: p.LastOpened,
	}
}

func dbAgentToAPI(a db.Agent) Agent {
	return Agent{
		Id:              a.ID,
		ProjectId:       a.ProjectID,
		Name:            a.Name,
		Prompt:          a.Prompt,
		Status:          AgentStatus(a.Status),
		Branch:          a.Branch,
		WorktreePath:    a.WorktreePath,
		SandboxId:       a.SandboxID,
		SandboxTemplate: a.SandboxTemplate,
		AiProvider:      AgentAiProvider(a.AIProvider),
		CreatedAt:       a.CreatedAt,
		UpdatedAt:       a.UpdatedAt,
		FinishedAt:      a.FinishedAt,
		LogTail:         a.LogTail,
	}
}

func builtinAgentTypes() []AgentType {
	claude := "docker/sandbox-templates:claude-code"
	gemini := "docker/sandbox-templates:gemini"
	return []AgentType{
		{Id: "claude", Name: "Claude Code", Description: "Anthropic's Claude Code AI coding agent", SandboxTemplate: &claude},
		{Id: "gemini", Name: "Gemini CLI", Description: "Google's Gemini CLI AI coding agent", SandboxTemplate: &gemini},
		{Id: "codex", Name: "OpenAI Codex", Description: "OpenAI Codex CLI AI coding agent"},
		{Id: "copilot", Name: "GitHub Copilot", Description: "GitHub Copilot AI coding agent"},
		{Id: "cagent", Name: "C Agent", Description: "C coding agent"},
		{Id: "kiro", Name: "Kiro", Description: "Kiro AI coding agent"},
		{Id: "opencode", Name: "OpenCode", Description: "Open source coding agent"},
		{Id: "other", Name: "Other / Shell", Description: "Custom shell-based agent"},
	}
}

func validatePath(p string) error {
	if strings.Contains(p, "..") {
		return fmt.Errorf("path traversal not allowed")
	}
	return nil
}

// resolveRepoPath returns the absolute file system path for a relative repo path,
// optionally checking out to a specific branch worktree.
func resolveRepoPath(projectPath, relPath, branch string) (string, error) {
	base := projectPath
	// If a branch is specified and it's not the working tree branch,
	// we could use git to read the file. For simplicity, use the project path.
	// A future enhancement would be to use git cat-file for arbitrary branches.
	_ = branch
	abs := filepath.Join(base, filepath.FromSlash(relPath))
	// Verify it's within the project root (no symlink escaping)
	abs, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return "", err
	}
	projectAbs, err := filepath.EvalSymlinks(projectPath)
	if err != nil {
		return "", err
	}
	if !strings.HasPrefix(abs, projectAbs) {
		return "", fmt.Errorf("path outside project root")
	}
	return abs, nil
}

func readDirectory(absPath, relPath, branch string) (DirectoryInfo, error) {
	entries, err := os.ReadDir(absPath)
	if err != nil {
		return DirectoryInfo{}, err
	}

	var dirEntries []DirectoryEntry
	for _, e := range entries {
		// Skip .git directory
		if e.Name() == ".git" {
			continue
		}
		t := DirectoryEntryType("file")
		if e.IsDir() {
			t = "directory"
		} else if e.Type()&os.ModeSymlink != 0 {
			t = "symlink"
		}
		entry := DirectoryEntry{Name: e.Name(), Type: t}
		if !e.IsDir() {
			info, err := e.Info()
			if err == nil {
				sz := info.Size()
				entry.Size = &sz
			}
		}
		dirEntries = append(dirEntries, entry)
	}

	// Sort directories before files, alphabetically within each group
	sort.SliceStable(dirEntries, func(i, j int) bool {
		iIsDir := dirEntries[i].Type == "directory"
		jIsDir := dirEntries[j].Type == "directory"
		if iIsDir != jIsDir {
			return iIsDir
		}
		return strings.ToLower(dirEntries[i].Name) < strings.ToLower(dirEntries[j].Name)
	})

	info := DirectoryInfo{
		Path:    relPath,
		Entries: dirEntries,
	}
	if branch != "" {
		info.Branch = &branch
	}

	// Try to read README
	for _, name := range []string{"README.md", "README.txt", "README"} {
		readmePath := filepath.Join(absPath, name)
		content, err := os.ReadFile(readmePath)
		if err == nil {
			s := string(content)
			info.Readme = &s
			break
		}
	}

	return info, nil
}

func guessMimeType(name string) *string {
	ext := strings.ToLower(filepath.Ext(name))
	mimes := map[string]string{
		".html": "text/html",
		".css":  "text/css",
		".js":   "text/javascript",
		".ts":   "text/typescript",
		".tsx":  "text/typescript",
		".jsx":  "text/javascript",
		".json": "application/json",
		".yaml": "text/yaml",
		".yml":  "text/yaml",
		".md":   "text/markdown",
		".txt":  "text/plain",
		".go":   "text/x-go",
		".py":   "text/x-python",
		".rs":   "text/x-rust",
		".sh":   "text/x-sh",
		".png":  "image/png",
		".jpg":  "image/jpeg",
		".jpeg": "image/jpeg",
		".gif":  "image/gif",
		".svg":  "image/svg+xml",
		".pdf":  "application/pdf",
	}
	if m, ok := mimes[ext]; ok {
		return &m
	}
	return nil
}

func isBinaryFile(path string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	buf := make([]byte, 512)
	n, err := f.Read(buf)
	if err != nil {
		return false
	}
	for _, b := range buf[:n] {
		if b == 0 {
			return true
		}
	}
	return false
}

// openFolderPicker opens a native OS folder picker dialog and returns the selected path.
func openFolderPicker() (string, error) {
	switch runtime.GOOS {
	case "windows":
		cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command",
			`Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.ShowDialog() | Out-Null; Write-Output $f.SelectedPath`)
		out, err := cmd.Output()
		if err != nil {
			return "", fmt.Errorf("folder picker: %w", err)
		}
		return strings.TrimSpace(string(out)), nil
	case "darwin":
		cmd := exec.Command("osascript", "-e", `POSIX path of (choose folder)`)
		out, err := cmd.Output()
		if err != nil {
			return "", fmt.Errorf("folder picker: %w", err)
		}
		return strings.TrimRight(strings.TrimSpace(string(out)), "/"), nil
	default:
		// Linux: try zenity, then kdialog
		for _, tool := range [][]string{
			{"zenity", "--file-selection", "--directory"},
			{"kdialog", "--getexistingdirectory"},
		} {
			cmd := exec.Command(tool[0], tool[1:]...)
			out, err := cmd.Output()
			if err == nil {
				return strings.TrimSpace(string(out)), nil
			}
		}
		return "", fmt.Errorf("no folder picker available (install zenity or kdialog)")
	}
}

// isLocalhostRequest returns true if the request came from localhost.
func isLocalhostRequest(r *http.Request) bool {
	host := r.RemoteAddr
	for _, prefix := range []string{"127.0.0.1:", "[::1]:", "localhost:"} {
		if strings.HasPrefix(host, prefix) {
			return true
		}
	}
	return false
}
