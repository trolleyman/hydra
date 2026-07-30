package http

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/paths"
)

// maxUploadBytes caps a single pasted/attached file. Generous enough for
// screenshots and small assets, bounded so a paste can't fill the disk.
const maxUploadBytes = 25 * 1024 * 1024

// DefaultUploadMaxAge is how long a pasted/attached file is retained before the
// background pruner removes it. Uploads are referenced only by the absolute
// path embedded in a prompt at submit time, so once an agent has consumed them
// (or the user has moved on) they can safely age out.
const DefaultUploadMaxAge = 30 * 24 * time.Hour

// uploadResponse is returned to the browser after a successful upload. Path is
// the absolute host path of the stored file. Crucially, that same path is valid
// *inside* every agent sandbox: the whole host filesystem is bind-mounted
// read-only at the same locations (see internal/sandbox/linux.go "--ro-bind / /"),
// and the uploads dir lives under <projectRoot>/.hydra which is neither masked
// (masks are $HOME-relative) nor overlaid with tmpfs. So inserting this path
// into an agent's prompt/terminal lets it read the file directly - an
// agent-agnostic mechanism that works for Claude, Gemini and Copilot alike.
type uploadResponse struct {
	Path     string `json:"path"`
	Filename string `json:"filename"`
}

// HandleUpload accepts a multipart file upload (a pasted image, or any attached
// file) and stores it under <projectRoot>/.hydra/local/uploads. It is registered
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

	// Bound the request body before touching the multipart reader so an oversize
	// upload is rejected rather than buffered.
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBytes)
	file, header, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "invalid upload: "+err.Error(), http.StatusBadRequest)
		return
	}
	defer file.Close()

	dir := paths.GetUploadsDirFromProjectRoot(projectRoot)
	// EnsureHydraLocalIgnored makes the dir and ensures the .hydra/local root's
	// "*" .gitignore covers it, so pasted files never pollute the repo's status.
	if err := paths.EnsureHydraLocalIgnored(dir); err != nil {
		http.Error(w, "failed to prepare upload dir", http.StatusInternalServerError)
		return
	}

	dest, err := writeUpload(dir, header.Filename, file)
	if err != nil {
		// MaxBytesReader surfaces an oversize body as a copy error, so this is a
		// 400 rather than a 500: the request was too big, not the server broken.
		http.Error(w, "failed to store upload: "+err.Error(), http.StatusBadRequest)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(uploadResponse{Path: dest, Filename: filepath.Base(dest)})
}

// writeUpload copies `src` into the uploads dir under a fresh unique name and
// returns the absolute path it landed at. A partial write is cleaned up rather
// than left behind as a truncated file that would serve as a corrupt image.
//
// Split out of HandleUpload because the browser is no longer the only way a file
// becomes an upload: an agent can attach one to a review comment, and the daemon
// copies it in from the head's worktree the same way (see StoreUploadFile).
func writeUpload(dir, originalName string, src io.Reader) (string, error) {
	dest := filepath.Join(dir, uniqueUploadName(originalName))
	out, err := os.OpenFile(dest, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	if _, err := io.Copy(out, src); err != nil {
		_ = out.Close()
		_ = os.Remove(dest)
		return "", errtrace.Wrap(err)
	}
	if err := out.Close(); err != nil {
		_ = os.Remove(dest)
		return "", errtrace.Wrap(err)
	}
	return dest, nil
}

// StoreUploadFile copies an existing file on disk into the project's uploads dir
// and returns its new absolute path - how a file an AGENT wrote becomes an
// attachment. The copy is the point: the agent's own path is inside a worktree
// that gets deleted when the head is merged or killed, and /tmp is per-head and
// reclaimed with it, so a comment pointing at either would rot. An upload
// outlives the head that made it and is addressable by the browser's blob
// endpoint, which serves by name out of exactly this directory.
//
// The caller is responsible for having already confined `srcPath` to somewhere
// the agent is allowed to read from (resolveAgentFile); this only enforces that
// the file is regular and within the same size cap as a browser upload.
func StoreUploadFile(projectRoot, srcPath string) (string, error) {
	info, err := os.Stat(srcPath)
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	if info.IsDir() || !info.Mode().IsRegular() {
		return "", errtrace.Wrap(fmt.Errorf("not a regular file"))
	}
	if info.Size() > maxUploadBytes {
		return "", errtrace.Wrap(fmt.Errorf("file is %d bytes, over the %d byte limit", info.Size(), maxUploadBytes))
	}
	dir := paths.GetUploadsDirFromProjectRoot(projectRoot)
	if err := paths.EnsureHydraLocalIgnored(dir); err != nil {
		return "", errtrace.Wrap(err)
	}
	in, err := os.Open(srcPath)
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	defer in.Close()
	// Bounded even though the size was just checked - the file could grow between
	// the stat and the copy, and +1 lets a copy that hits the cap be told apart
	// from one that merely filled it exactly.
	dest, err := writeUpload(dir, filepath.Base(srcPath), io.LimitReader(in, maxUploadBytes+1))
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	return dest, nil
}

// safeUploadName matches the names uniqueUploadName produces (and nothing with a
// path separator or traversal), so HandleUploadBlob can serve only real uploads.
var safeUploadName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)

// HandleUploadBlob serves a previously uploaded file by its on-disk name so the
// web UI can render image attachments (thumbnails + a fullscreen lightbox) for
// the upload paths embedded in an agent's prompt. Registered outside the OpenAPI
// mux because it returns raw bytes, not JSON. GET only; the `name` query param is
// the bare on-disk filename (no path), validated against safeUploadName so a
// crafted value can't escape the uploads dir.
func (s *Server) HandleUploadBlob(w http.ResponseWriter, r *http.Request) {
	projectID := r.PathValue("project_id")
	projectRoot, err := s.resolveProjectRoot(projectID)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	name := r.URL.Query().Get("name")
	if !safeUploadName.MatchString(name) {
		http.NotFound(w, r)
		return
	}
	full := filepath.Join(paths.GetUploadsDirFromProjectRoot(projectRoot), name)
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
	// setBlobFileHeaders decides the Content-Type (ServeContent leaves a set one
	// alone); ServeContent handles range/conditional requests.
	setBlobFileHeaders(w, f, name)
	w.Header().Set("Cache-Control", "public, max-age=300")
	http.ServeContent(w, r, name, info.ModTime(), f)
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

// PruneUploads removes files in the project's uploads dir last modified longer
// ago than maxAge. The .gitignore is preserved. It's best-effort: failures on
// individual entries are skipped so one bad file can't stall the sweep. A
// missing dir (nothing ever uploaded) is not an error.
func PruneUploads(projectRoot string, maxAge time.Duration) error {
	dir := paths.GetUploadsDirFromProjectRoot(projectRoot)
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return errtrace.Wrap(err)
	}
	cutoff := time.Now().Add(-maxAge)
	for _, e := range entries {
		if e.IsDir() || e.Name() == ".gitignore" {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		if info.ModTime().Before(cutoff) {
			_ = os.Remove(filepath.Join(dir, e.Name()))
		}
	}
	return nil
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
