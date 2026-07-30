package http

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/api"
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

// DefaultUploadMaxBytes bounds the uploads dir by total size, the way
// artifacts.DefaultMaxBytes and tests.DefaultMaxBytes bound their caches. Age
// alone is not a bound: at maxUploadBytes per file, a month of heavy pasting can
// reach several GB before anything is old enough to age out. 1 GiB sits between
// the test cache's 512 MiB and the artifact cache's 2 GiB - these are user
// pastes, so they are worth keeping longer than a regenerable build log and less
// long than a build output someone may have pinned.
const DefaultUploadMaxBytes = int64(1) << 30 // 1 GiB

// The response is api.UploadResponse. Path is the absolute host path of the
// stored file. Crucially, that same path is valid *inside* every agent sandbox:
// the whole host filesystem is bind-mounted read-only at the same locations (see
// internal/sandbox/linux.go "--ro-bind / /"), and the uploads dir lives under
// <projectRoot>/.hydra which is neither masked (masks are $HOME-relative) nor
// overlaid with tmpfs. So inserting this path into an agent's prompt/terminal
// lets it read the file directly - an agent-agnostic mechanism that works for
// Claude, Gemini and Copilot alike.

// HandleUpload accepts a multipart file upload (a pasted image, or any attached
// file) and stores it under <projectRoot>/.hydra/local/uploads. Documented in
// api/openapi.yaml under the `manual` tag but hand-served: it consumes
// multipart/form-data rather than JSON. Taking the response type from the
// generated package is what keeps the spec honest - a change to one is a compile
// error in the other.
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
	_ = json.NewEncoder(w).Encode(api.UploadResponse{Path: dest, Filename: name})
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

// PruneUploads bounds the project's uploads dir by age and by total size,
// matching the two-bound contract the artifact and test caches already use
// (artifacts.PruneStale, tests.PruneStale). Age alone leaves the dir unbounded
// for a whole retention window, and at a 25MB per-file ceiling that window can
// hold a lot.
//
// The sweep recurses. Nothing in the upload path ever creates a directory -
// uniqueUploadName emits no separators and the create is O_EXCL on a flat path -
// so any directory in here was put there by something else (an agent using the
// dir as scratch). Those were previously skipped outright and so lived forever;
// their files now age out on the same rule as everything else, and a directory
// left empty is removed. Emptied bottom-up, so a tree that ages out entirely
// goes in a single pass rather than one level per hourly tick.
//
// The .gitignore at the root is preserved - it is what keeps this dir out of the
// repo's status, not an upload.
//
// Best-effort throughout: failures on individual entries are skipped so one bad
// file can't stall the sweep, and a missing dir (nothing ever uploaded) is not an
// error.
func PruneUploads(projectRoot string, maxAge time.Duration, maxBytes int64) error {
	dir := paths.GetUploadsDirFromProjectRoot(projectRoot)
	if _, err := os.Stat(dir); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return errtrace.Wrap(err)
	}

	type survivor struct {
		path    string
		modTime time.Time
		size    int64
	}
	var kept []survivor
	cutoff := time.Now().Add(-maxAge)

	// Returns whether the directory is empty afterwards, so the parent can
	// reclaim it in this same pass.
	var sweep func(path string, depth int) bool
	sweep = func(path string, depth int) bool {
		entries, err := os.ReadDir(path)
		if err != nil {
			// Unreadable: report non-empty so nothing tries to remove it.
			return false
		}
		empty := true
		for _, e := range entries {
			// Only the uploads root carries the .gitignore; a nested one belongs to
			// whatever wrote the directory and is prunable like any other file.
			if depth == 0 && e.Name() == ".gitignore" {
				empty = false
				continue
			}
			full := filepath.Join(path, e.Name())
			if e.IsDir() {
				if sweep(full, depth+1) {
					if err := os.Remove(full); err != nil {
						empty = false
					}
					continue
				}
				empty = false
				continue
			}
			info, err := e.Info()
			if err != nil {
				empty = false
				continue
			}
			if maxAge > 0 && info.ModTime().Before(cutoff) {
				if err := os.Remove(full); err != nil {
					empty = false
				}
				continue
			}
			empty = false
			kept = append(kept, survivor{path: full, modTime: info.ModTime(), size: info.Size()})
		}
		return empty
	}
	sweep(dir, 0)

	if maxBytes > 0 {
		var total int64
		for _, s := range kept {
			total += s.size
		}
		if total > maxBytes {
			// Oldest-first, the same eviction order the artifact cache uses.
			sort.Slice(kept, func(i, j int) bool { return kept[i].modTime.Before(kept[j].modTime) })
			for _, s := range kept {
				if total <= maxBytes {
					break
				}
				if err := os.Remove(s.path); err != nil {
					continue
				}
				total -= s.size
			}
			// Evicting by size can empty a nested directory the age pass left
			// populated, so make one more bottom-up reclaim pass over the tree.
			// kept is reset first so the re-walk doesn't append a second copy of
			// every survivor to a slice we are done with either way.
			kept = nil
			sweep(dir, 0)
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
