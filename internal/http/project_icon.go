package http

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// imageIconExtRe matches the icon values that are treated as images rather than
// an emoji or a lucide icon name. Kept in sync with IMAGE_ICON_RE in the web UI
// (web/src/lib/projectIcon.tsx).
func isImageIcon(icon string) bool {
	switch strings.ToLower(filepath.Ext(icon)) {
	case ".png", ".svg", ".ico", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp":
		return true
	}
	return false
}

// HandleProjectIcon serves a project's icon image when its configured icon is a
// local file path. Registered outside the OpenAPI mux because it returns raw
// bytes, not JSON. GET only; the icon path is operator-configured (the user
// administers the project they registered), so a relative path is resolved
// against the project root and an absolute path is used as-is. Non-image icons
// (emoji, lucide names) and http(s)/data URIs never reach here - the web UI only
// points an <img> at this route for a bare file path.
func (s *Server) HandleProjectIcon(w http.ResponseWriter, r *http.Request) {
	projectID := r.PathValue("project_id")
	p := s.ProjectsManager.GetByID(projectID)
	if p == nil {
		http.NotFound(w, r)
		return
	}
	icon := projectIconValue(p.Path)
	if icon == "" || !isImageIcon(icon) {
		http.NotFound(w, r)
		return
	}
	// An http(s) or data: URI is loaded directly by the browser and should never
	// be requested here; refuse to treat it as a filesystem path.
	if strings.HasPrefix(icon, "http://") || strings.HasPrefix(icon, "https://") || strings.HasPrefix(icon, "data:") {
		http.NotFound(w, r)
		return
	}
	full := icon
	if !filepath.IsAbs(full) {
		full = filepath.Join(p.Path, filepath.FromSlash(icon))
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
	// Go's mime table doesn't always map .svg; set it explicitly so browsers
	// render it via <img>. ServeContent leaves an already-set Content-Type alone.
	if strings.EqualFold(filepath.Ext(full), ".svg") {
		w.Header().Set("Content-Type", "image/svg+xml")
	}
	// The URL is stable while the icon value is, but the file it points at can be
	// swapped underneath it - don't let a stale copy stick around.
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeContent(w, r, filepath.Base(full), info.ModTime(), f)
}
