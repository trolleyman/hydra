package http

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/artifacts"
	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/heads"
)

// maxRepositoryFileBytes caps how much of a file the repository browser will
// return inline; larger files are truncated so a giant blob can't bloat a
// response (or the browser).
const maxRepositoryFileBytes = 512 * 1024

// git tree modes we care about: a symlink stores its target path as the blob
// content (mode 120000); a directory entry is mode 040000.
const (
	gitSymlinkMode = "120000"
	gitDirMode     = "040000"
)

// maxSymlinkHops bounds how many links resolveSymlink will follow before giving
// up, so a symlink cycle can't loop forever.
const maxSymlinkHops = 40

// resolveSymlink follows a chain of symlinks at ref, starting from linkPath
// (which the caller has already confirmed is a symlink). It returns the
// repo-relative path of the first non-symlink entry reached and that entry's git
// mode, plus the raw target of the *first* link (what it literally points at).
// ok is false when the chain is broken, escapes the repository, or loops;
// firstTarget is still reported so callers can show what the link pointed at.
func resolveSymlink(projectRoot, ref, linkPath string) (finalPath, finalMode, firstTarget string, ok bool) {
	cur := linkPath
	seen := map[string]bool{}
	for hop := 0; hop < maxSymlinkHops; hop++ {
		if seen[cur] {
			return "", "", firstTarget, false // cycle
		}
		seen[cur] = true

		data, err := git.ShowFile(projectRoot, ref, cur)
		if err != nil || data == nil {
			return "", "", firstTarget, false
		}
		// git stores a symlink's target verbatim (no trailing newline).
		target := string(data)
		if firstTarget == "" {
			firstTarget = target
		}
		// Absolute targets point outside the tracked tree; we can't show them.
		if strings.HasPrefix(target, "/") {
			return "", "", firstTarget, false
		}
		resolved := path.Clean(path.Join(path.Dir(cur), target))
		if resolved == "." || resolved == ".." || strings.HasPrefix(resolved, "../") {
			return "", "", firstTarget, false // escapes the repo root
		}
		mode, err := git.LsTreeEntryMode(projectRoot, ref, resolved)
		if err != nil || mode == "" {
			return "", "", firstTarget, false // dangling
		}
		if mode != gitSymlinkMode {
			return resolved, mode, firstTarget, true // reached a real entry
		}
		cur = resolved
	}
	return "", "", firstTarget, false // too many hops
}

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

// GetRepositoryDiff returns the diff between two arbitrary refs in the project's
// repository, so the repository browser can compare the branch being viewed
// against another branch. It uses a two-dot diff (base..head) - the literal
// difference between the two trees - and reuses the same DiffFile shape and
// expansion machinery as the agent diff.
func (s *Server) GetRepositoryDiff(_ context.Context, request api.GetRepositoryDiffRequestObject) (api.GetRepositoryDiffResponseObject, error) {
	projectRoot, err := s.resolveProjectRoot(request.ProjectId)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	baseRef := request.Params.BaseRef
	headRef := request.Params.HeadRef

	ignoreWhitespace := request.Params.IgnoreWhitespace != nil && *request.Params.IgnoreWhitespace

	filePath := ""
	if request.Params.Path != nil {
		filePath = *request.Params.Path
	}

	contextLines := 3
	if request.Params.Context != nil {
		contextLines = *request.Params.Context
	}

	maxFullChanges := 1000
	if request.Params.MaxFullChanges != nil {
		maxFullChanges = *request.Params.MaxFullChanges
	}
	maxFullLines := 6000
	if request.Params.MaxFullLines != nil {
		maxFullLines = *request.Params.MaxFullLines
	}
	fullContext := request.Params.FullContext != nil && *request.Params.FullContext

	// No worktree and no uncommitted changes for a branch-to-branch compare, so
	// diffRoot is the project root and includeUncommitted is false throughout.
	// useTripleDot is false: a plain base..head diff is the most predictable
	// answer to "what differs between these two branches".
	var diffFiles []git.DiffFile
	if fullContext && filePath == "" {
		diffFiles, err = s.getFullContextDiff(projectRoot, projectRoot, baseRef, headRef, ignoreWhitespace, false, contextLines, maxFullChanges, maxFullLines, false)
	} else {
		diffFiles, err = s.getDiffCached(projectRoot, projectRoot, baseRef, headRef, ignoreWhitespace, false, filePath, contextLines, false)
	}
	if err != nil {
		return nil, errtrace.Wrap(err)
	}

	// A pure rename produces no hunks; ship the renamed file's full content as
	// all-context lines so the viewer shows the file normally rather than a bare
	// "No changes".
	for i := range diffFiles {
		if diffFiles[i].ChangeType == "renamed" && len(diffFiles[i].Hunks) == 0 {
			fillRenameContext(projectRoot, headRef, &diffFiles[i])
		}
	}

	return api.GetRepositoryDiff200JSONResponse(api.DiffResponse{
		Files:   apiDiffFiles(diffFiles),
		BaseRef: baseRef,
		HeadRef: headRef,
	}), nil
}

// maxRenameContextLines caps how big a pure-renamed file we expand inline (it
// matches the client's whole-file render guard); larger files stay "No changes".
const maxRenameContextLines = 6000

// fillRenameContext loads a pure-renamed file's content at ref and rewrites its
// (empty) hunks into a single whole-file hunk of context lines, marking it
// expanded so the viewer renders every line. Binary or oversized files are left
// untouched.
func fillRenameContext(projectRoot, ref string, f *git.DiffFile) {
	data, err := git.ShowFile(projectRoot, ref, f.Path)
	if err != nil || data == nil {
		return
	}
	if looksBinary(data) {
		f.Binary = true
		return
	}
	lines := strings.Split(strings.TrimSuffix(string(data), "\n"), "\n")
	if len(lines) > maxRenameContextLines {
		return
	}
	dlines := make([]git.DiffLine, len(lines))
	for i, l := range lines {
		n := i + 1
		old, nw := n, n
		dlines[i] = git.DiffLine{Type: git.DiffLineContext, Content: l, OldLineNum: &old, NewLineNum: &nw}
	}
	f.Hunks = []git.DiffHunk{{
		Header:   fmt.Sprintf("@@ -1,%d +1,%d @@", len(lines), len(lines)),
		OldStart: 1,
		NewStart: 1,
		Lines:    dlines,
	}}
	f.Expanded = true
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

// maxUncommittedFiles caps the file list in the push-status response; Total
// still reports the real count so the UI can say "+N more".
const maxUncommittedFiles = 20

// uncommittedChanges lists projectRoot's dirty working-tree paths in the API
// shape, truncated to maxUncommittedFiles entries.
func uncommittedChanges(projectRoot string) (api.RepositoryUncommittedChanges, error) {
	files, err := git.ListUncommittedFiles(projectRoot)
	if err != nil {
		return api.RepositoryUncommittedChanges{}, errtrace.Wrap(err)
	}
	out := api.RepositoryUncommittedChanges{
		Total: len(files),
		Files: make([]api.RepositoryUncommittedFile, 0, min(len(files), maxUncommittedFiles)),
	}
	for _, f := range files {
		if len(out.Files) == maxUncommittedFiles {
			break
		}
		out.Files = append(out.Files, api.RepositoryUncommittedFile{Path: f.Path, Status: f.Status})
	}
	return out, nil
}

// fullPushStatus reads the remote status plus the working tree's uncommitted
// changes for projectRoot and assembles the API response. The raw RemoteStatus
// is returned too for callers that branch on it.
func fullPushStatus(projectRoot string) (api.RepositoryPushStatus, git.RemoteStatus, error) {
	st, err := git.GetRemoteStatus(projectRoot)
	if err != nil {
		return api.RepositoryPushStatus{}, st, errtrace.Wrap(err)
	}
	resp := pushStatusResponse(st)
	resp.Uncommitted, err = uncommittedChanges(projectRoot)
	if err != nil {
		return api.RepositoryPushStatus{}, st, errtrace.Wrap(err)
	}
	return resp, st, nil
}

// pushStatusResponse adapts a git.RemoteStatus into the API shape.
func pushStatusResponse(st git.RemoteStatus) api.RepositoryPushStatus {
	resp := api.RepositoryPushStatus{
		Ahead:     st.Ahead,
		Behind:    st.Behind,
		HasRemote: st.HasRemote,
		CanPush:   st.CanPush(),
	}
	if st.Branch != "" {
		resp.Branch = &st.Branch
	}
	if st.Remote != "" {
		resp.Remote = &st.Remote
	}
	return resp
}

// GetRepositoryPushStatus reports whether the project root's current branch has
// commits to push (and how far behind the remote it is), so the sidebar can
// enable or grey out the Push button and show a behind indicator. It returns the
// cached state immediately and kicks off a throttled background fetch so the
// behind count is kept fresh without blocking the response.
func (s *Server) GetRepositoryPushStatus(_ context.Context, request api.GetRepositoryPushStatusRequestObject) (api.GetRepositoryPushStatusResponseObject, error) {
	projectRoot, err := s.resolveProjectRoot(request.ProjectId)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	resp, st, err := fullPushStatus(projectRoot)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	if st.HasRemote {
		go s.maybeFetchRemote(projectRoot, st.Remote)
	}
	return api.GetRepositoryPushStatus200JSONResponse(resp), nil
}

// maybeFetchRemote runs `git fetch <remote>` for projectRoot in the background,
// at most once per remoteFetchInterval and never concurrently, so the behind
// count stays current without a fetch on every poll. If the fetch reveals a
// changed ahead/behind it publishes a push_status_changed event, prompting
// clients to refetch; otherwise it stays silent so an unchanged remote doesn't
// turn this into a poll. Best-effort: a failed/slow fetch just leaves the cached
// (possibly stale) counts in place.
func (s *Server) maybeFetchRemote(projectRoot, remote string) {
	s.fetchMu.Lock()
	if s.fetchActive == nil {
		s.fetchActive = map[string]bool{}
		s.fetchLast = map[string]time.Time{}
	}
	if s.fetchActive[projectRoot] || time.Since(s.fetchLast[projectRoot]) < remoteFetchInterval {
		s.fetchMu.Unlock()
		return
	}
	s.fetchActive[projectRoot] = true
	s.fetchLast[projectRoot] = time.Now()
	s.fetchMu.Unlock()

	defer func() {
		s.fetchMu.Lock()
		s.fetchActive[projectRoot] = false
		s.fetchMu.Unlock()
	}()

	before, _ := git.GetRemoteStatus(projectRoot)

	ctx := s.BackgroundCtx
	if ctx == nil {
		ctx = context.Background()
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if err := git.Fetch(ctx, projectRoot, remote); err != nil {
		return // best-effort; keep the cached counts
	}

	after, err := git.GetRemoteStatus(projectRoot)
	if err != nil {
		return
	}
	if after.Ahead != before.Ahead || after.Behind != before.Behind {
		s.Events.PushStatusChanged(projectRoot)
	}
}

// PushRepository pushes the project root's current branch to its remote and
// returns the refreshed push status.
func (s *Server) PushRepository(_ context.Context, request api.PushRepositoryRequestObject) (api.PushRepositoryResponseObject, error) {
	projectRoot, err := s.resolveProjectRoot(request.ProjectId)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}

	st, err := git.GetRemoteStatus(projectRoot)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	if !st.CanPush() {
		detail := "nothing to push"
		switch {
		case st.Branch == "":
			detail = "cannot push: HEAD is detached"
		case !st.HasRemote:
			detail = "cannot push: repository has no remote configured"
		}
		return nil, &apiError{Code: 400, Type: api.ErrorResponseErrorBadRequest, Err: errors.New(detail)} //errtrace:skip
	}

	if _, err := git.Push(projectRoot); err != nil {
		return nil, errtrace.Wrap(err)
	}

	// Re-read so the client sees the post-push state (ahead normally back to 0).
	after, _, err := fullPushStatus(projectRoot)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	return api.PushRepository200JSONResponse(after), nil
}

// SyncRepository fetches, integrates the remote's commits into the local branch
// (a pull), then pushes any local commits - the one-click sync the sidebar
// button performs. A pull that can't merge cleanly returns 409 without touching
// the working tree.
func (s *Server) SyncRepository(_ context.Context, request api.SyncRepositoryRequestObject) (api.SyncRepositoryResponseObject, error) {
	projectRoot, err := s.resolveProjectRoot(request.ProjectId)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}

	st, err := git.GetRemoteStatus(projectRoot)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	if st.Branch == "" || !st.HasRemote {
		detail := "cannot sync: repository has no remote configured"
		if st.Branch == "" {
			detail = "cannot sync: HEAD is detached"
		}
		return nil, &apiError{Code: 400, Type: api.ErrorResponseErrorBadRequest, Err: errors.New(detail)} //errtrace:skip
	}

	authorName, authorEmail := gitConfigVal(projectRoot, "user.name"), gitConfigVal(projectRoot, "user.email")

	ctx := s.BackgroundCtx
	if ctx == nil {
		ctx = context.Background()
	}
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()

	// Pull first so a push can't be rejected for being behind.
	if err := git.Pull(ctx, projectRoot, authorName, authorEmail); err != nil {
		var conflict *git.ConflictError
		if errors.As(err, &conflict) {
			return api.SyncRepository409JSONResponse(api.MergeConflictError{
				Error:   api.MergeConflictErrorErrorMergeConflict,
				Code:    409,
				Details: fmt.Sprintf("pull failed: %v", conflict),
			}), nil
		}
		return nil, errtrace.Wrap(err)
	}

	// Push anything local that the pull left ahead.
	if after, err := git.GetRemoteStatus(projectRoot); err == nil && after.CanPush() {
		if _, err := git.Push(projectRoot); err != nil {
			return nil, errtrace.Wrap(err)
		}
	}

	final, _, err := fullPushStatus(projectRoot)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	s.Events.PushStatusChanged(projectRoot)
	return api.SyncRepository200JSONResponse(final), nil
}

// CommitRepository commits the requested uncommitted paths in the project root
// - the sidebar warning's one-click way to commit config edits the web UI
// itself wrote to .hydra/config.toml (or any other local changes). Only paths
// the client names (i.e. the ones its popover showed) are committed; anything
// else dirty is left alone.
func (s *Server) CommitRepository(_ context.Context, request api.CommitRepositoryRequestObject) (api.CommitRepositoryResponseObject, error) {
	projectRoot, err := s.resolveProjectRoot(request.ProjectId)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}

	var message string
	requested := map[string]bool{}
	if request.Body != nil {
		message = strings.TrimSpace(request.Body.Message)
		for _, p := range request.Body.Paths {
			requested[p] = true
		}
	}
	if message == "" {
		return nil, &apiError{Code: 400, Type: api.ErrorResponseErrorBadRequest, Err: errors.New("commit message must not be empty")} //errtrace:skip
	}
	if len(requested) == 0 {
		return nil, &apiError{Code: 400, Type: api.ErrorResponseErrorBadRequest, Err: errors.New("no files selected to commit")} //errtrace:skip
	}

	// Re-list and intersect rather than trusting the client's paths verbatim:
	// this validates them against the actual dirty set (a path that was
	// committed or reverted in the meantime is just skipped) and recovers each
	// rename's original path, which the commit pathspec needs.
	files, err := git.ListUncommittedFiles(projectRoot)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	commit := files[:0]
	for _, f := range files {
		if requested[f.Path] {
			commit = append(commit, f)
		}
	}
	if len(commit) == 0 {
		return nil, &apiError{Code: 400, Type: api.ErrorResponseErrorBadRequest, Err: errors.New("nothing to commit: the selected files are no longer modified")} //errtrace:skip
	}

	authorName, authorEmail := gitConfigVal(projectRoot, "user.name"), gitConfigVal(projectRoot, "user.email")
	if err := git.CommitFiles(projectRoot, message, commit, authorName, authorEmail); err != nil {
		return nil, errtrace.Wrap(err)
	}

	s.Events.PushStatusChanged(projectRoot)
	resp, _, err := fullPushStatus(projectRoot)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	return api.CommitRepository200JSONResponse(resp), nil
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

	// Inspect the tree entry first so we can tell a missing path from a symlink
	// (whose raw blob is its target text, not the pointed-to file's content).
	mode, err := git.LsTreeEntryMode(projectRoot, ref, filePath)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	if mode == "" {
		return api.GetRepositoryFile404JSONResponse{
			Code:    404,
			Error:   api.ErrorResponseErrorPathNotFound,
			Details: "file not found: " + filePath,
		}, nil
	}

	resp := api.GetRepositoryFile200JSONResponse{
		Path: filePath,
		Ref:  ref,
	}
	// contentPath is the path whose blob we actually render - the file itself,
	// or, for a symlink, the entry it ultimately resolves to.
	contentPath := filePath
	if mode == gitSymlinkMode {
		resp.Symlink = true
		final, finalMode, firstTarget, ok := resolveSymlink(projectRoot, ref, filePath)
		resp.SymlinkTarget = &firstTarget
		if !ok || finalMode == gitDirMode {
			// Broken, looping, out-of-repo, or a directory: report the link and its
			// target, but there is no file content to preview.
			return resp, nil
		}
		contentPath = final
		resp.TargetPath = &final
	}

	data, err := git.ShowFile(projectRoot, ref, contentPath)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	if data == nil {
		return api.GetRepositoryFile404JSONResponse{
			Code:    404,
			Error:   api.ErrorResponseErrorPathNotFound,
			Details: "file not found: " + contentPath,
		}, nil
	}

	resp.Size = len(data)
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

	// Resolve symlinks so an <img> pointing at a symlinked image serves the real
	// bytes rather than the link's target text (git's raw blob for a symlink).
	if mode, err := git.LsTreeEntryMode(projectRoot, ref, filePath); err == nil && mode == gitSymlinkMode {
		final, finalMode, _, ok := resolveSymlink(projectRoot, ref, filePath)
		if !ok || finalMode == gitDirMode {
			http.NotFound(w, r)
			return
		}
		filePath = final
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

// HandleAgentBlob serves the raw bytes of a repo-relative file as seen in an
// agent's diff, so the diff viewer can render an image differ for in-tree images
// the same way the artifacts panel does. It is registered outside the OpenAPI
// mux (like HandleRepositoryBlob) because it returns raw bytes.
//
// With a `ref` it reads the committed blob from the project root - the agent's
// branch commits live there, so base_ref/head_ref SHAs resolve. With
// `worktree=true` it instead reads the file straight from the agent's worktree
// directory, which is how the diff's uncommitted (head_ref == "") and untracked
// images are served (they exist only on disk, not at any ref). Query: path
// (required), and either ref or worktree=true.
func (s *Server) HandleAgentBlob(w http.ResponseWriter, r *http.Request) {
	projectRoot, err := s.resolveProjectRoot(r.PathValue("project_id"))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	q := r.URL.Query()
	filePath := strings.TrimPrefix(path.Clean(q.Get("path")), "/")
	if filePath == "" || filePath == "." {
		http.Error(w, "no file path given", http.StatusBadRequest)
		return
	}

	if q.Get("worktree") == "true" {
		head, err := heads.GetHeadByID(r.Context(), s.Sessions, s.DB, projectRoot, r.PathValue("id"))
		if err != nil || head == nil || head.Worktree == nil {
			http.NotFound(w, r)
			return
		}
		s.serveWorktreeBlob(w, r, *head.Worktree, filePath)
		return
	}

	ref := repoRef(ptrOrNil(q.Get("ref")))
	// Resolve symlinks so an <img> pointing at a symlinked image serves the real
	// bytes rather than the link's target text (matches HandleRepositoryBlob).
	if mode, err := git.LsTreeEntryMode(projectRoot, ref, filePath); err == nil && mode == gitSymlinkMode {
		final, finalMode, _, ok := resolveSymlink(projectRoot, ref, filePath)
		if !ok || finalMode == gitDirMode {
			http.NotFound(w, r)
			return
		}
		filePath = final
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
	w.Header().Set("Content-Type", http.DetectContentType(data))
	w.Header().Set("Cache-Control", "public, max-age=300")
	_, _ = w.Write(data)
}

// serveWorktreeBlob serves a repo-relative file straight from an agent's worktree
// directory. relPath has already been path.Clean'd and stripped of a leading
// slash; the filepath.Rel guard rejects any path that still escapes the worktree
// (e.g. "../secret"), so a crafted request can't read outside it.
func (s *Server) serveWorktreeBlob(w http.ResponseWriter, r *http.Request, worktree, relPath string) {
	full := filepath.Join(worktree, filepath.FromSlash(relPath))
	if rel, err := filepath.Rel(worktree, full); err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		http.NotFound(w, r)
		return
	}
	f, err := os.Open(full)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || info.IsDir() {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "no-store") // worktree contents change as the agent works
	http.ServeContent(w, r, filepath.Base(full), info.ModTime(), f)
}

// repositoryArtifactNames lists the enabled [[artifacts]] script names defined at
// a ref, sorted. It reads the ref's own .hydra/config.toml (via artifactSpecsByName,
// shared with the diff viewer) and drops scripts the live config disables. Returns
// an empty list - never an error - when there is no artifacts manager or no
// readable config, so the repository browser simply shows no artifacts folder.
func (s *Server) repositoryArtifactNames(projectRoot, ref string) ([]string, error) {
	if s.Artifacts == nil {
		return nil, nil
	}
	liveCfg, err := config.Load(projectRoot)
	if err != nil {
		return nil, nil //nolint:nilerr // a missing/unreadable config means "no artifacts"
	}
	byName, err := artifactSpecsByName(projectRoot, artifacts.Version{Ref: ref}, liveCfg)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	disabled := disabledArtifacts(liveCfg)
	names := make([]string, 0, len(byName))
	for n := range byName {
		if !disabled[n] {
			names = append(names, n)
		}
	}
	sort.Strings(names)
	return names, nil
}

// GetRepositoryArtifacts lists the artifact scripts configured at a ref so the
// repository browser can show its dynamic ".hydra/artifacts" folder. It only reads
// config - nothing is generated here (generation is lazy, on GetRepositoryArtifact).
func (s *Server) GetRepositoryArtifacts(_ context.Context, request api.GetRepositoryArtifactsRequestObject) (api.GetRepositoryArtifactsResponseObject, error) {
	projectRoot, err := s.resolveProjectRoot(request.ProjectId)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	ref := repoRef(request.Params.Ref)
	names, err := s.repositoryArtifactNames(projectRoot, ref)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	scripts := make([]api.RepositoryArtifactScript, 0, len(names))
	for _, n := range names {
		scripts = append(scripts, api.RepositoryArtifactScript{Name: n})
	}
	return api.GetRepositoryArtifacts200JSONResponse{Ref: ref, Scripts: scripts}, nil
}

// GetRepositoryArtifact runs (or returns the cached result of) one artifact script
// for a single ref and reports its outputs single-sided - the repository browser
// shows one ref at a time, so there is no before/after comparison. Generation is
// lazy: this is only called when the user opens the script in the browser.
func (s *Server) GetRepositoryArtifact(_ context.Context, request api.GetRepositoryArtifactRequestObject) (api.GetRepositoryArtifactResponseObject, error) {
	projectRoot, err := s.resolveProjectRoot(request.ProjectId)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	ref := repoRef(request.Params.Ref)
	notFound := api.GetRepositoryArtifact404JSONResponse{
		Code:    404,
		Error:   api.ErrorResponseErrorNotFound,
		Details: "artifact script not found: " + request.Name,
	}
	if s.Artifacts == nil {
		return notFound, nil
	}
	liveCfg, err := config.Load(projectRoot)
	if err != nil {
		return notFound, nil //nolint:nilerr // no config → no such script
	}
	v := artifacts.Version{Ref: ref}
	byName, err := artifactSpecsByName(projectRoot, v, liveCfg)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	spec, ok := byName[request.Name]
	if !ok || disabledArtifacts(liveCfg)[request.Name] {
		return notFound, nil
	}

	mgr := s.Artifacts.Manager(projectRoot)
	// A refresh request discards the cached result before generating, chiefly to
	// retry a cached failure (which otherwise sticks until the ref changes).
	if request.Params.Refresh != nil && *request.Params.Refresh {
		_ = mgr.Invalidate(request.Name, v)
	}
	meta, err := mgr.Get(spec, v)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	return api.GetRepositoryArtifact200JSONResponse(s.buildRepositoryArtifact(request.ProjectId, request.Name, mgr, meta)), nil
}

// buildRepositoryArtifact folds one generated (or in-flight) script's metadata into
// the single-sided API shape: every output file with a blob URL, plus the live
// progress/log while generating and a persisted-log URL once settled.
func (s *Server) buildRepositoryArtifact(projectID, name string, mgr *artifacts.Manager, meta artifacts.Meta) api.RepositoryArtifactResponse {
	resp := api.RepositoryArtifactResponse{Name: name, Files: []api.RepositoryArtifactFile{}}

	switch meta.Status {
	case artifacts.StatusGenerating:
		resp.Status = api.RepositoryArtifactResponseStatusGenerating
		// Surface the live progress + log only while generating; once settled the
		// log is fetched from log_url instead (it is not kept in memory).
		resp.Progress = nonEmptyPtr(meta.Progress)
		resp.Log = ptr(toAPILog(meta.Log))
		if meta.StartedAt > 0 {
			resp.StartedAt = &meta.StartedAt
		}
		return resp
	case artifacts.StatusError:
		resp.Status = api.RepositoryArtifactResponseStatusError
		resp.Error = nonEmptyPtr(meta.Error)
	default:
		resp.Status = api.RepositoryArtifactResponseStatusReady
	}

	if mgr.HasLog(name, meta.Key) {
		resp.LogUrl = ptr(logURL(projectID, name, meta.Key))
	}
	for _, f := range meta.Files {
		af := api.RepositoryArtifactFile{Name: f.Name, Url: ptr(blobURL(projectID, name, meta.Key, f.Name))}
		if len(f.Tags) > 0 {
			tags := append([]string(nil), f.Tags...)
			af.Tags = &tags
		}
		if f.Fps > 0 {
			fps := f.Fps
			af.Fps = &fps
		}
		if f.Width > 0 && f.Height > 0 {
			af.Width = ptr(f.Width)
			af.Height = ptr(f.Height)
		}
		if f.Dpi > 0 {
			af.Dpi = ptr(f.Dpi)
		}
		resp.Files = append(resp.Files, af)
	}
	return resp
}

// ptrOrNil returns nil for an empty string, else a pointer to s. It adapts query
// values to the *string ref helpers.
func ptrOrNil(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
