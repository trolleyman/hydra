package projects

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/paths"
)

// ProjectInfo describes a registered Hydra project.
type ProjectInfo struct {
	ID   string `json:"id"`
	Path string `json:"path"`
	Name string `json:"name"`
}

// Manager persists the list of known projects to ~/.config/hydra/projects.json.
type Manager struct {
	mu       sync.Mutex
	filePath string
	projects []ProjectInfo
}

// NewManager creates a Manager backed by the default config file.
func NewManager() (*Manager, error) {
	configDir, err := os.UserConfigDir()
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("get user config dir: %w", err))
	}
	dir := filepath.Join(configDir, "hydra")
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("create config dir: %w", err))
	}
	m := &Manager{filePath: filepath.Join(dir, "projects.json")}
	if err := m.load(); err != nil {
		return nil, errtrace.Wrap(err)
	}
	return m, nil
}

// load reads the project list from disk. Missing file is not an error.
func (m *Manager) load() error {
	data, err := os.ReadFile(m.filePath)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return errtrace.Wrap(fmt.Errorf("read projects file: %w", err))
	}
	return errtrace.Wrap(json.Unmarshal(data, &m.projects))
}

// save writes the project list to disk.
func (m *Manager) save() error {
	data, err := json.MarshalIndent(m.projects, "", "  ")
	if err != nil {
		return errtrace.Wrap(fmt.Errorf("marshal projects: %w", err))
	}
	if err := os.WriteFile(m.filePath, data, 0644); err != nil {
		return errtrace.Wrap(fmt.Errorf("write projects file: %w", err))
	}
	return nil
}

// ListProjects returns all registered projects (caller gets a copy).
func (m *Manager) ListProjects() []ProjectInfo {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]ProjectInfo, len(m.projects))
	copy(out, m.projects)
	return out
}

// GetByID returns the project with the given ID, or nil if not found.
func (m *Manager) GetByID(id string) *ProjectInfo {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i := range m.projects {
		if m.projects[i].ID == id {
			p := m.projects[i]
			return &p
		}
	}
	return nil
}

// GetByPath returns the project with the given path, or nil if not found.
func (m *Manager) GetByPath(path string) *ProjectInfo {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i := range m.projects {
		if m.projects[i].Path == path {
			p := m.projects[i]
			return &p
		}
	}
	return nil
}

// AddProject registers the given absolute path as a project (idempotent by path).
// Returns the ProjectInfo (existing or newly created).
func (m *Manager) AddProject(path string) (ProjectInfo, error) {
	norm, err := NormalizePath(path)
	if err == nil {
		path = norm
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	// Idempotent: return existing entry for this path.
	for _, p := range m.projects {
		if paths.ComparePaths(p.Path, path) {
			return p, nil
		}
	}

	id := m.generateID(path)
	name := filepath.Base(path)
	p := ProjectInfo{ID: id, Path: path, Name: name}
	m.projects = append(m.projects, p)
	if err := m.save(); err != nil {
		// Rollback in-memory addition.
		m.projects = m.projects[:len(m.projects)-1]
		return ProjectInfo{}, errtrace.Wrap(err)
	}
	return p, nil
}

// NormalizePath returns an absolute, symlink-resolved path with forward slashes.
// Internal wrapper to avoid circular dependency if needed, or just use the logic directly.
func NormalizePath(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	eval, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return filepath.ToSlash(abs), nil
	}
	return filepath.ToSlash(eval), nil
}

// generateID produces a unique project ID derived from the folder name.
// Must be called with m.mu held.
func (m *Manager) generateID(path string) string {
	base := filepath.Base(path)
	// Sanitize: lowercase, replace non-alphanumeric with hyphens.
	base = sanitizeID(base)
	if base == "" {
		base = "project"
	}

	// Build set of existing IDs.
	existing := make(map[string]bool, len(m.projects))
	for _, p := range m.projects {
		existing[p.ID] = true
	}

	if !existing[base] {
		return base
	}
	for suffix := 2; ; suffix++ {
		candidate := fmt.Sprintf("%s%d", base, suffix)
		if !existing[candidate] {
			return candidate
		}
	}
}

// sanitizeID lowercases the string and replaces non-alphanumeric characters
// (except hyphens) with hyphens, collapsing runs.
func sanitizeID(s string) string {
	s = strings.ToLower(s)
	var b strings.Builder
	prevHyphen := false
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
			prevHyphen = false
		} else if !prevHyphen {
			b.WriteByte('-')
			prevHyphen = true
		}
	}
	return strings.Trim(b.String(), "-")
}
