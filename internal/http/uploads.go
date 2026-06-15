package http

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/trolleyman/hydra/internal/paths"
)

// maxUploadBytes caps a single pasted/attached file. Generous enough for
// screenshots and small assets, bounded so a paste can't fill the disk.
const maxUploadBytes = 25 * 1024 * 1024

// uploadResponse is returned to the browser after a successful upload. Path is
// the absolute host path of the stored file. Crucially, that same path is valid
// *inside* every agent sandbox: the whole host filesystem is bind-mounted
// read-only at the same locations (see internal/sandbox/linux.go "--ro-bind / /"),
// and the uploads dir lives under <projectRoot>/.hydra which is neither masked
// (masks are $HOME-relative) nor overlaid with tmpfs. So inserting this path
// into an agent's prompt/terminal lets it read the file directly — an
// agent-agnostic mechanism that works for Claude, Gemini and Copilot alike.
type uploadResponse struct {
	Path     string `json:"path"`
	Filename string `json:"filename"`
}

// HandleUpload accepts a multipart file upload (a pasted image, or any attached
// file) and stores it under <projectRoot>/.hydra/uploads. It is registered
// outside the OpenAPI mux because it consumes multipart/form-data rather than
// JSON, mirroring HandleArtifactBlob which serves raw bytes.
func (s *Server) HandleUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	projectID := r.PathValue("project_id")
	projectRoot, err := s.resolveProjectRoot(projectID)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	// The daemon owns a single project; only accept uploads for it.
	if projectRoot != s.ProjectRoot {
		http.NotFound(w, r)
		return
	}

	// Bound the request body before touching the multipart reader so an oversize
	// upload is rejected rather than buffered.
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBytes)
	file, header, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "invalid upload: "+err.Error(), http.StatusBadRequest)
		return
	}
	defer file.Close()

	dir := filepath.Join(paths.GetHydraDirFromProjectRoot(projectRoot), "uploads")
	// CreateGitignoreAllInDir makes the dir and drops a "*" .gitignore so pasted
	// files never pollute the repo's status.
	if err := paths.CreateGitignoreAllInDir(dir); err != nil {
		http.Error(w, "failed to prepare upload dir", http.StatusInternalServerError)
		return
	}

	name := uniqueUploadName(header.Filename)
	dest := filepath.Join(dir, name)
	out, err := os.OpenFile(dest, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		http.Error(w, "failed to create file", http.StatusInternalServerError)
		return
	}
	if _, err := io.Copy(out, file); err != nil {
		_ = out.Close()
		_ = os.Remove(dest)
		// MaxBytesReader surfaces an oversize body as a copy error.
		http.Error(w, "failed to write file: "+err.Error(), http.StatusBadRequest)
		return
	}
	if err := out.Close(); err != nil {
		_ = os.Remove(dest)
		http.Error(w, "failed to finalize file", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(uploadResponse{Path: dest, Filename: name})
}

// uniqueUploadName builds a collision-resistant, filesystem-safe name that keeps
// the original extension and a slug of the original base name for readability.
// A nanosecond timestamp prefix plus O_EXCL on create avoids clobbering.
func uniqueUploadName(original string) string {
	base := filepath.Base(original)
	ext := strings.TrimPrefix(filepath.Ext(base), ".")
	stem := sanitizeUploadComponent(strings.TrimSuffix(base, filepath.Ext(base)))
	ext = sanitizeUploadComponent(ext)
	if stem == "" {
		stem = "paste"
	}
	name := strconv.FormatInt(time.Now().UnixNano(), 10) + "-" + stem
	if ext != "" {
		name += "." + ext
	}
	return name
}

// sanitizeUploadComponent maps anything outside [A-Za-z0-9-_.] to '-', trims
// leading/trailing separators, and caps length to keep names sane.
func sanitizeUploadComponent(s string) string {
	s = strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			return r
		case r == '-', r == '_', r == '.':
			return r
		default:
			return '-'
		}
	}, s)
	s = strings.Trim(s, "-.")
	if len(s) > 64 {
		s = s[:64]
	}
	return s
}
