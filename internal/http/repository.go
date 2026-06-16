package http

import (
	"bytes"
	"context"
	"net/http"
	"path"
	"sort"
	"strings"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/git"
)

// maxRepositoryFileBytes caps how much of a file the repository browser will
// return inline; larger files are truncated so a giant blob can't bloat a
// response (or the browser).
const maxRepositoryFileBytes = 512 * 1024

// repoRef returns the git ref to read from, defaulting to HEAD when the caller
// did not pin one.
func repoRef(ref *string) string {
	if ref != nil && *ref != "" {
		return *ref
	}
	return "HEAD"
}

// looksBinary reports whether data appears to be a binary blob (contains a NUL
// byte in the sniffed prefix), matching git's own heuristic closely enough for
// deciding whether content is safe to render as text.
func looksBinary(data []byte) bool {
	const sniff = 8000
	if len(data) > sniff {
		data = data[:sniff]
	}
	return bytes.IndexByte(data, 0) != -1
}

// pickDefaultFile returns a root-level README to open first (case-insensitive,
// preferring README.md), or "" when the repo has none.
func pickDefaultFile(files []string) string {
	var fallback string
	for _, f := range files {
		if strings.Contains(f, "/") {
			continue // only consider files at the repo root
		}
		lower := strings.ToLower(f)
		if lower == "readme.md" {
			return f
		}
		if fallback == "" && strings.HasPrefix(lower, "readme") {
			fallback = f
		}
	}
	return fallback
}

// GetRepositoryTree lists every file tracked in the project's repository at the
// requested ref (HEAD by default), plus a suggested file to open first.
func (s *Server) GetRepositoryTree(_ context.Context, request api.GetRepositoryTreeRequestObject) (api.GetRepositoryTreeResponseObject, error) {
	projectRoot, err := s.resolveProjectRoot(request.ProjectId)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	ref := repoRef(request.Params.Ref)

	files, err := git.ListTreeFiles(projectRoot, ref)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}

	resp := api.GetRepositoryTree200JSONResponse{
		Ref:   ref,
		Files: files,
	}
	if def := pickDefaultFile(files); def != "" {
		resp.DefaultPath = &def
	}
	return resp, nil
}

// GetRepositoryBranches lists the local branches of the project's repository,
// ordering Hydra agent branches (hydra/*) first so the repository browser's
// branch selector surfaces active agents' work at the top.
func (s *Server) GetRepositoryBranches(_ context.Context, request api.GetRepositoryBranchesRequestObject) (api.GetRepositoryBranchesResponseObject, error) {
	projectRoot, err := s.resolveProjectRoot(request.ProjectId)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}

	names, err := git.ListBranches(projectRoot)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	current, err := git.GetCurrentBranch(projectRoot)
	if err != nil {
		// A detached HEAD reports an error/"HEAD"; treat it as "no current branch"
		// rather than failing the whole listing.
		current = ""
	}
	if current == "HEAD" {
		current = ""
	}

	branches := make([]api.RepositoryBranch, 0, len(names))
	for _, name := range names {
		branches = append(branches, api.RepositoryBranch{
			Name:      name,
			IsAgent:   strings.HasPrefix(name, "hydra/"),
			IsCurrent: name == current,
		})
	}
	// Stable order: agent branches first, then the rest; preserve git's
	// committerdate ordering within each group.
	sort.SliceStable(branches, func(i, j int) bool {
		return branches[i].IsAgent && !branches[j].IsAgent
	})

	return api.GetRepositoryBranches200JSONResponse{
		Current:  current,
		Branches: branches,
	}, nil
}

// GetRepositoryFile returns the contents of a single repo-relative file at the
// requested ref. Binary files report binary=true with no content; oversized
// files are truncated with truncated=true.
func (s *Server) GetRepositoryFile(_ context.Context, request api.GetRepositoryFileRequestObject) (api.GetRepositoryFileResponseObject, error) {
	projectRoot, err := s.resolveProjectRoot(request.ProjectId)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	ref := repoRef(request.Params.Ref)
	// Normalise the path so leading "./" or stray slashes don't defeat the
	// "missing → 404" check below.
	filePath := strings.TrimPrefix(path.Clean(request.Params.Path), "/")
	if filePath == "" || filePath == "." {
		return api.GetRepositoryFile404JSONResponse{
			Code:    404,
			Error:   api.ErrorResponseErrorPathNotFound,
			Details: "no file path given",
		}, nil
	}

	data, err := git.ShowFile(projectRoot, ref, filePath)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	if data == nil {
		return api.GetRepositoryFile404JSONResponse{
			Code:    404,
			Error:   api.ErrorResponseErrorPathNotFound,
			Details: "file not found: " + filePath,
		}, nil
	}

	resp := api.GetRepositoryFile200JSONResponse{
		Path: filePath,
		Ref:  ref,
		Size: len(data),
	}
	if looksBinary(data) {
		resp.Binary = true
		return resp, nil
	}
	if len(data) > maxRepositoryFileBytes {
		resp.Truncated = true
		data = data[:maxRepositoryFileBytes]
	}
	content := string(data)
	resp.Content = &content
	return resp, nil
}

// HandleRepositoryBlob serves the raw bytes of a repo-relative file at a ref. It
// is registered outside the OpenAPI mux because it returns raw bytes (so the
// repository browser can render binary images via an <img> tag) rather than the
// JSON envelope of GetRepositoryFile. Query: path (required), ref (optional).
func (s *Server) HandleRepositoryBlob(w http.ResponseWriter, r *http.Request) {
	projectRoot, err := s.resolveProjectRoot(r.PathValue("project_id"))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	q := r.URL.Query()
	ref := repoRef(ptrOrNil(q.Get("ref")))
	filePath := strings.TrimPrefix(path.Clean(q.Get("path")), "/")
	if filePath == "" || filePath == "." {
		http.Error(w, "no file path given", http.StatusBadRequest)
		return
	}

	data, err := git.ShowFile(projectRoot, ref, filePath)
	if err != nil {
		http.Error(w, "invalid blob request", http.StatusBadRequest)
		return
	}
	if data == nil {
		http.NotFound(w, r)
		return
	}

	ct := http.DetectContentType(data)
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Cache-Control", "public, max-age=300")
	_, _ = w.Write(data)
}

// ptrOrNil returns nil for an empty string, else a pointer to s. It adapts query
// values to the *string ref helpers.
func ptrOrNil(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
