package http

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/trolleyman/hydra/internal/heads"
	"github.com/trolleyman/hydra/internal/mediasize"
	"github.com/trolleyman/hydra/internal/paths"
)

// Agent-authored image files.
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

// agentImageExts is the extension allowlist. This endpoint exists to make chat
// markdown images render, so it serves images and nothing else - a much narrower
// surface than "any file the agent can name".
var agentImageExts = map[string]bool{
	".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".webp": true,
	".avif": true, ".bmp": true, ".ico": true, ".svg": true, ".tif": true, ".tiff": true,
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

// agentFileSizes measures every path it can, keyed by the path AS GIVEN (which
// is what the client asked about, and what it will look the answer up by).
//
// It goes through resolveAgentFile, so it can only ever measure a file the blob
// endpoint would serve: inside the head's worktree, its private /tmp, or the
// project's uploads dir, and with an image extension. A path it can't measure -
// wrong extension, outside those roots, gone, or a format the decoders don't
// cover - is left out entirely rather than answered with a zero.
func agentFileSizes(projectRoot, worktree, tmpDir string, paths []string) map[string]agentFileSize {
	out := make(map[string]agentFileSize)
	for _, raw := range paths {
		if raw == "" || !agentImageExts[strings.ToLower(filepath.Ext(raw))] {
			continue
		}
		if _, seen := out[raw]; seen {
			continue
		}
		full := resolveAgentFile(projectRoot, worktree, tmpDir, raw)
		if full == "" {
			continue
		}
		if w, h := mediasize.ImagePixelSize(full); w > 0 && h > 0 {
			out[raw] = agentFileSize{Width: w, Height: h}
		}
	}
	return out
}

// The most paths one sizes request will answer. A message with more pictures
// than this is not a thing, and the cap is what stops a crafted request turning
// one round trip into an unbounded pile of stats. The client batches per render
// (see web/src/lib/serverMediaSize.ts) and splits at the same number.
const maxAgentFileSizes = 64

// agentFileSizesRequest is the body of a sizes request: the image paths, exactly
// as the agent wrote them in its message.
type agentFileSizesRequest struct {
	Paths []string `json:"paths"`
}

// agentFileSize is one answer - a file's natural pixel dimensions.
type agentFileSize struct {
	Width  int `json:"width"`
	Height int `json:"height"`
}

// agentFileSizesResponse maps each path we could measure to its size. A path
// that is missing, unreadable, or in a format we can't read is simply ABSENT
// rather than zero: "we don't know" and "it is 0 wide" have to stay tellable
// apart, because the client falls back to measuring the bytes itself for the
// former and would lay out an empty box for the latter.
type agentFileSizesResponse struct {
	Sizes map[string]agentFileSize `json:"sizes"`
}

// HandleAgentFileSizes measures the images an agent referenced in a chat message,
// so the renderer can reserve each picture's box BEFORE fetching it.
//
// Without this the browser has to download an image to find out how big it is,
// which is the one thing in a message whose height arrives later than the message
// does: a screenshot landing at the end of a streaming turn is suddenly several
// hundred pixels tall and shoves the transcript under the reader (see
// MarkdownImage, and lib/selfReflow, which exists to cope with the aftermath).
// The server has the file on disk and can read its header for nothing, so it
// answers in one small round trip that runs alongside the image loads instead of
// behind them.
//
// POST rather than GET: this is a read, but a batch of absolute paths does not
// fit comfortably in a query string, and batching is the point - one request per
// render, not one per picture queued behind the image downloads themselves.
// Registered outside the OpenAPI mux, next to the blob endpoint whose path
// resolution (and image-only allowlist) it shares exactly, so it can never
// measure something that endpoint would refuse to serve.
func (s *Server) HandleAgentFileSizes(w http.ResponseWriter, r *http.Request) {
	projectRoot, err := s.resolveProjectRoot(r.PathValue("project_id"))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	var req agentFileSizesRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024)).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if len(req.Paths) > maxAgentFileSizes {
		req.Paths = req.Paths[:maxAgentFileSizes]
	}
	headID := r.PathValue("id")
	head, err := heads.GetHeadByID(r.Context(), s.Sessions, s.DB, projectRoot, headID)
	if err != nil || head == nil {
		http.NotFound(w, r)
		return
	}
	worktree := ""
	if head.Worktree != nil {
		worktree = *head.Worktree
	}
	tmpDir := heads.HeadTmpDir(projectRoot, headID)
	out := agentFileSizesResponse{Sizes: agentFileSizes(projectRoot, worktree, tmpDir, req.Paths)}
	w.Header().Set("Content-Type", "application/json")
	// Agent scratch files get rewritten in place, so a size is only good for as
	// long as the file is - the same reason the blob endpoint revalidates.
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(out)
}

// HandleAgentFileBlob serves an image file an agent referenced by path in a chat
// message. Registered outside the OpenAPI mux (like HandleAgentBlob) because it
// returns raw bytes. Query: path (required) - absolute as the agent saw it, or
// relative to its worktree.
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
	if !agentImageExts[strings.ToLower(filepath.Ext(raw))] {
		http.NotFound(w, r)
		return
	}
	headID := r.PathValue("id")
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
