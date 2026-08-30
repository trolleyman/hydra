// Package statepath owns the filesystem layout for one Hydra runtime's durable
// generated state. Production uses the OS-native user state directory; a
// checkout development server sets HYDRA_STATE_DIR to that checkout's
// .hydra/local directory.
package statepath

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"

	"braces.dev/errtrace"
)

const (
	Environment            = "HYDRA_STATE_DIR"
	ProjectEnvironment     = "HYDRA_PROJECT_ID"
	ProjectRootEnvironment = "HYDRA_PROJECT_ROOT"
)

var registeredProjects = struct {
	sync.RWMutex
	byPath map[string]string
}{byPath: map[string]string{}}

// Root returns the selected runtime state root.
func Root() (string, error) {
	if override := strings.TrimSpace(os.Getenv(Environment)); override != "" {
		path, err := filepath.Abs(override)
		if err != nil {
			return "", errtrace.Wrap(fmt.Errorf("resolve %s: %w", Environment, err))
		}
		return filepath.Clean(path), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", errtrace.Wrap(fmt.Errorf("get home directory: %w", err))
	}
	switch runtime.GOOS {
	case "linux":
		if root := os.Getenv("XDG_STATE_HOME"); root != "" {
			return filepath.Join(root, "hydra"), nil
		}
		return filepath.Join(home, ".local", "state", "hydra"), nil
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", "Hydra"), nil
	case "windows":
		root := os.Getenv("LOCALAPPDATA")
		if root == "" {
			root = strings.TrimRight(home, `\/`) + `\AppData\Local`
		}
		return strings.TrimRight(root, `\/`) + `\Hydra`, nil
	default:
		return "", errtrace.Errorf("Hydra state directory is unsupported on %s", runtime.GOOS)
	}
}

func DatabasePath() (string, error) {
	root, err := Root()
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	return filepath.Join(root, "db.sqlite3"), nil
}

// RuntimeIsolationKey returns a stable identifier for an explicitly selected
// state root. Production, where HYDRA_STATE_DIR is unset, uses the unnamespaced
// runtime. Development checkouts use their state root to isolate IPC and scope
// units without a second environment variable.
func RuntimeIsolationKey() string {
	override := strings.TrimSpace(os.Getenv(Environment))
	if override == "" {
		return ""
	}
	if root, err := Root(); err == nil {
		return root
	}
	return filepath.Clean(override)
}

// RegisterProject associates a normalized repository path with its stable
// catalogue ID. It is safe to repeat and is refreshed whenever the catalogue
// changes.
func RegisterProject(id, projectPath string) {
	if !validProjectID(id) || projectPath == "" {
		return
	}
	registeredProjects.Lock()
	registeredProjects.byPath[pathKey(projectPath)] = id
	registeredProjects.Unlock()
}

func validProjectID(id string) bool {
	if id == "" || id == "." || id == ".." {
		return false
	}
	for _, r := range id {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			continue
		}
		return false
	}
	return true
}

func UnregisterProject(projectPath string) {
	registeredProjects.Lock()
	delete(registeredProjects.byPath, pathKey(projectPath))
	registeredProjects.Unlock()
}

func ProjectID(projectPath string) (string, bool) {
	registeredProjects.RLock()
	id, ok := registeredProjects.byPath[pathKey(projectPath)]
	registeredProjects.RUnlock()
	return id, ok
}

// ProjectDir returns centralized state for registered projects. An unregistered
// path retains the historical project-local fallback; this is useful for
// isolated package tests and recovery tools that intentionally operate without
// opening the machine catalogue.
func ProjectDir(projectPath string) string {
	id, ok := ProjectID(projectPath)
	environmentRoot := strings.TrimSpace(os.Getenv(ProjectRootEnvironment))
	if !ok && environmentRoot != "" && pathKey(environmentRoot) == pathKey(projectPath) {
		id = strings.TrimSpace(os.Getenv(ProjectEnvironment))
		ok = validProjectID(id)
	}
	if !ok {
		return filepath.Join(projectPath, ".hydra", "local")
	}
	root, err := Root()
	if err != nil {
		return filepath.Join(projectPath, ".hydra", "local")
	}
	return filepath.Join(root, "projects", id)
}

func pathKey(path string) string {
	abs, err := filepath.Abs(path)
	if err == nil {
		path = abs
	}
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		path = resolved
	}
	path = filepath.Clean(path)
	if runtime.GOOS == "windows" {
		path = strings.ToLower(path)
	}
	return path
}
