package http

import (
	"encoding/json"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"

	"github.com/trolleyman/hydra/internal/api"
)

// Native folder picker.
//
// The web UI is served only on localhost, so the browser and the daemon run on
// the same machine. That lets us pop a *real* OS folder dialog (zenity/kdialog
// on Linux, `osascript` on macOS) on the user's screen and hand the chosen
// absolute path back to the browser - something a browser-side picker can't do,
// since browsers deliberately hide absolute filesystem paths.
//
// Two hand-served routes back this (tag `manual`, mirroring uploads/terminal):
//   - GET  /folder-picker/available - whether to show the "Browse..." button.
//   - POST /folder-picker/open      - blocks until the user picks or cancels.
//
// Both are gated on the request originating from loopback, because the dialog
// appears on the *server's* display: offering it to a remote client would pop a
// window the user can never see.

// folderPickerMu serializes native dialog invocations. Only one OS folder
// dialog should ever be on screen at a time, no matter how many browser tabs
// (or stray double-clicks) ask for one.
var folderPickerMu sync.Mutex

// isLoopbackRequest reports whether the request originated from the local
// machine over loopback TCP. Non-loopback (LAN IP, port-forward) and
// unix-socket clients (empty RemoteAddr - the CLI, not a browser) return false.
func isLoopbackRequest(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip := net.ParseIP(strings.TrimSpace(host))
	return ip != nil && ip.IsLoopback()
}

// lookupFolderPicker resolves the native directory-chooser command for this OS,
// or (.., false) when none is usable (tool missing, no display, unsupported OS).
// The command must print the chosen absolute path to stdout and exit non-zero
// when the user cancels.
func lookupFolderPicker() (name string, args []string, ok bool) {
	const title = "Open project folder"
	switch runtime.GOOS {
	case "linux":
		// A GUI dialog is pointless without a display server to draw on.
		if os.Getenv("DISPLAY") == "" && os.Getenv("WAYLAND_DISPLAY") == "" {
			return "", nil, false
		}
		if p, err := exec.LookPath("zenity"); err == nil {
			return p, []string{"--file-selection", "--directory", "--title=" + title}, true
		}
		if p, err := exec.LookPath("kdialog"); err == nil {
			return p, []string{"--getexistingdirectory", homeDirOr("."), "--title", title}, true
		}
		return "", nil, false
	case "darwin":
		if p, err := exec.LookPath("osascript"); err == nil {
			return p, []string{"-e", `POSIX path of (choose folder with prompt "` + title + `")`}, true
		}
		return "", nil, false
	default:
		// Windows is stubbed elsewhere in Hydra; fall back to manual entry.
		return "", nil, false
	}
}

func homeDirOr(fallback string) string {
	if h, err := os.UserHomeDir(); err == nil {
		return h
	}
	return fallback
}

// HandleFolderPickerAvailable reports whether the UI should offer a native
// "Browse..." button: only when the request is local and a dialog tool exists.
func (s *Server) HandleFolderPickerAvailable(w http.ResponseWriter, r *http.Request) {
	available := false
	if isLoopbackRequest(r) {
		_, _, available = lookupFolderPicker()
	}
	writeJSONResponse(w, http.StatusOK, api.FolderPickerAvailableResponse{Available: available})
}

// HandleFolderPickerOpen pops the native folder dialog and blocks until the
// user picks a folder or dismisses it. Responds with {"path": "..."} on a pick
// or {"cancelled": true} when dismissed.
func (s *Server) HandleFolderPickerOpen(w http.ResponseWriter, r *http.Request) {
	if !isLoopbackRequest(r) {
		http.Error(w, "folder picker is only available to local clients", http.StatusForbidden)
		return
	}
	name, args, ok := lookupFolderPicker()
	if !ok {
		http.Error(w, "no native folder picker available on this system", http.StatusServiceUnavailable)
		return
	}

	// One dialog at a time - don't stack windows if the user clicks twice.
	if !folderPickerMu.TryLock() {
		http.Error(w, "a folder picker is already open", http.StatusConflict)
		return
	}
	defer folderPickerMu.Unlock()

	// Tie the dialog's lifetime to the request: if the browser navigates away
	// or the tab closes, the context cancels and the dialog process is killed.
	cmd := exec.CommandContext(r.Context(), name, args...)
	out, err := cmd.Output()
	if err != nil {
		// A non-zero exit is the normal "user cancelled" signal for these
		// dialogs; we can't reliably distinguish it from a genuine failure, so
		// log for diagnosis and treat it as a cancel from the UI's view.
		log.Printf("folder picker (%s) exited without a selection: %v", name, err)
		writeJSONResponse(w, http.StatusOK, api.FolderPickerOpenResponse{Cancelled: ptr(true)})
		return
	}

	path := strings.TrimSpace(string(out))
	if path == "" {
		writeJSONResponse(w, http.StatusOK, api.FolderPickerOpenResponse{Cancelled: ptr(true)})
		return
	}
	writeJSONResponse(w, http.StatusOK, api.FolderPickerOpenResponse{Path: &path})
}

func writeJSONResponse(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
