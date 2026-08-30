package http

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/trolleyman/hydra/internal/heads"
	"github.com/trolleyman/hydra/internal/paths"
)

// Agent-authored image and video files.
//
// An agent that takes a screenshot writes it to a path only IT can see - its
// worktree, or /tmp, which for a sandboxed head is a private host-backed dir
// (heads.HeadTmpDir). When it then writes `![shot](/tmp/x.png)` in a chat
// message, the browser resolves that against the Hydra origin and 404s, so the
// user sees a broken image for a file that is sitting right there on the host.
//
// HandleAgentFileBlob closes that gap: it translates the path AS THE AGENT SAW IT
// into its host location and serves the bytes, so the chat markdown renderer can
// show the picture inline. No copying - the file is served where it already is,
// which also means it disappears from the transcript when the head's scratch dir
// is reclaimed (an image only lives as long as the file does).
//
// Video rides the same route. A screen recording is the natural way to show a
// transition or a flow that a still cannot, and the markdown for it is the same
// `![alt](path)` - the renderer picks a <video> over an <img> by extension (see
// MarkdownRenderer.MarkdownMedia). http.ServeContent answers Range requests, so
// the player can seek without the endpoint doing anything special.

// agentImageExts is the still-image half of the extension allowlist.
var agentImageExts = map[string]bool{
	".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".webp": true,
	".avif": true, ".bmp": true, ".ico": true, ".svg": true, ".tif": true, ".tiff": true,
}

// agentVideoExts is the video half - the formats a browser plays in a <video>,
// matching web/src/lib/fileKind's VIDEO_RE so the frontend and this endpoint
// agree on what a markdown image target is allowed to be.
var agentVideoExts = map[string]bool{
	".webm": true, ".mp4": true, ".m4v": true, ".mov": true, ".ogv": true,
}

// agentServableExt reports whether a path an agent embedded names a media file
// this endpoint will serve. The endpoint exists to make chat markdown render, so
// it serves what the renderer can show and nothing else - a much narrower surface
// than "any file the agent can name".
func agentServableExt(name string) bool {
	ext := strings.ToLower(filepath.Ext(name))
	return agentImageExts[ext] || agentVideoExts[ext]
}

// rootedPath is a candidate host path together with the root it must stay
// inside. Containment is re-checked after symlink resolution, so a symlink
// planted in the worktree can't point the endpoint at an arbitrary host file.
type rootedPath struct{ root, full string }

// agentFilePaths lists the host paths to try for a path an agent emitted, in
// order. The path arrives as the SANDBOXED agent saw it, so /tmp is translated
// to the head's private dir first (mirroring sendChatTaskOutput); after that the
// same absolute path is tried against each root it could legitimately name, and
// a relative path resolves against the worktree.
//
// An unsandboxed head has no private dir and really does write to the host /tmp,
// so /tmp is allowed as a root only in that case.
func agentFilePaths(projectRoot, worktree, tmpDir, raw string) []rootedPath {
	clean := filepath.Clean(raw)
	if !filepath.IsAbs(clean) {
		if worktree == "" {
			return nil
		}
		return []rootedPath{{worktree, filepath.Join(worktree, clean)}}
	}
	var out []rootedPath
	if tmpDir != "" && (clean == "/tmp" || strings.HasPrefix(clean, "/tmp"+string(filepath.Separator))) {
		out = append(out, rootedPath{tmpDir, filepath.Join(tmpDir, strings.TrimPrefix(clean, "/tmp"))})
	}
	roots := []string{worktree, paths.GetUploadsDirFromProjectRoot(projectRoot), tmpDir}
	if tmpDir == "" {
		roots = append(roots, os.TempDir())
	}
	for _, root := range roots {
		if root != "" {
			out = append(out, rootedPath{root, clean})
		}
	}
	return out
}

// resolveAgentFile returns the host path to serve for an agent-emitted path, or
// "" when it names nothing servable.
func resolveAgentFile(projectRoot, worktree, tmpDir, raw string) string {
	for _, c := range agentFilePaths(projectRoot, worktree, tmpDir, raw) {
		info, err := os.Stat(c.full)
		if err != nil || info.IsDir() {
			continue
		}
		if containedIn(c.root, c.full) {
			return c.full
		}
	}
	return ""
}

// HandleAgentFileBlob serves an image or video file an agent referenced by path
// in a chat message. Hand-served (like HandleAgentBlob; tag `manual`)
// because it returns raw bytes. Query: path (required) - absolute as the agent
// saw it, or relative to its worktree.
func (s *Server) HandleAgentFileBlob(w http.ResponseWriter, r *http.Request) {
	projectRoot, err := s.resolveProjectRoot(r.PathValue("project_id"))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	raw := r.URL.Query().Get("path")
	if raw == "" {
		http.Error(w, "no file path given", http.StatusBadRequest)
		return
	}
	if !agentServableExt(raw) {
		http.NotFound(w, r)
		return
	}
	headID := r.PathValue("agent_id")
	head, err := heads.GetHeadByID(r.Context(), s.Sessions, s.DB, projectRoot, headID)
	if err != nil || head == nil {
		http.NotFound(w, r)
		return
	}
	worktree := ""
	if head.Worktree != nil {
		worktree = *head.Worktree
	}
	full := resolveAgentFile(projectRoot, worktree, heads.HeadTmpDir(projectRoot, headID), raw)
	// Codex imageView returns a path rather than an image block. A completed View
	// Image event is a durable, exact-path capability proving the sandboxed tool
	// successfully read it; this lets the UI show user-supplied images outside
	// the worktree without turning this route into an arbitrary host-file reader.
	if full == "" && filepath.IsAbs(raw) && s.ChatEvents != nil && s.ChatEvents.HasCompletedViewImage(headID, raw) {
		full = filepath.Clean(raw)
	}
	if full == "" {
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
	setBlobFileHeaders(w, f, full)
	// Agent scratch files get rewritten in place (a re-run of the same script),
	// so revalidate rather than cache - ServeContent's ETag/If-Modified-Since
	// handling keeps that cheap.
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeContent(w, r, filepath.Base(full), info.ModTime(), f)
}
