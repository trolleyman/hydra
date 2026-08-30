package projects

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"braces.dev/errtrace"
	"github.com/google/uuid"
	"github.com/trolleyman/hydra/internal/db"
	"github.com/trolleyman/hydra/internal/paths"
	"github.com/trolleyman/hydra/internal/statepath"
)

// GetOrCreateInstanceUUID returns the persistent UUID for this Hydra instance,
// stored at ~/.config/hydra/uuid.txt. Creates a new UUID if not present.
func GetOrCreateInstanceUUID() (string, error) {
	configDir, err := os.UserConfigDir()
	if err != nil {
		return "", errtrace.Wrap(fmt.Errorf("get user config dir: %w", err))
	}
	dir := filepath.Join(configDir, "hydra")
	if err := os.MkdirAll(dir, 0755); err != nil {
		return "", errtrace.Wrap(fmt.Errorf("create config dir: %w", err))
	}
	uuidFile := filepath.Join(dir, "uuid.txt")
	data, err := os.ReadFile(uuidFile)
	if err == nil {
		if u := strings.TrimSpace(string(data)); u != "" {
			return u, nil
		}
	}
	u := uuid.New().String()
	if err := os.WriteFile(uuidFile, []byte(u+"\n"), 0644); err != nil {
		return "", errtrace.Wrap(fmt.Errorf("write uuid file: %w", err))
	}
	return u, nil
}

// ProjectInfo describes a registered Hydra project.
//
// Trust is not a separate flag: registration *is* the trust decision. The web UI
// makes the user review a project's .hydra/config.toml (via PreviewConfigToml,
// read-only) before it is added, because registering starts its [[services]] and
// its config can run code. So every project in this list is one the user trusted
// at add time; opening it later never re-prompts.
type ProjectInfo struct {
	ID   string `json:"id"`
	Path string `json:"path"`
	Name string `json:"name"`
	// Builtin marks a project Hydra created and owns rather than one the user
	// registered - currently only the chat project (see docs/chat-project.md).
	// It is never added via the add-project flow and never prompts for trust.
	// Callers asking "does the user have any projects yet?" must exclude these,
	// otherwise first-run states never render again.
	Builtin bool `json:"builtin,omitempty"`
	// Hidden keeps a project out of the project lists (the dropdown and the
	// Ctrl+` switcher) without unregistering it: its agents keep running and its
	// pages stay reachable. It lives here, next to the list order, rather than in
	// the project's own .hydra/config.toml, because "I don't want this in my
	// list" is a property of this machine's list - not of the repository, which
	// would commit one person's clutter to everybody's checkout.
	Hidden bool `json:"hidden,omitempty"`
}

// Manager persists the list of known projects in Hydra's runtime database.
// filePath is retained only by isolated unit tests and as the one-time legacy
// import source for installations upgrading from projects.json.
type Manager struct {
	mu       sync.Mutex
	filePath string
	store    *db.Store
	projects []ProjectInfo
}

// NewManager creates a SQLite-backed Manager. The JSON file is read only when
// the database has no project rows, as a one-time upgrade import.
func NewManager(store *db.Store) (*Manager, error) {
	if store == nil {
		return nil, errtrace.Wrap(fmt.Errorf("project manager requires a database store"))
	}
	configDir, err := os.UserConfigDir()
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("get user config dir: %w", err))
	}
	dir := filepath.Join(configDir, "hydra")
	m := &Manager{filePath: filepath.Join(dir, "projects.json"), store: store}
	if err := m.load(); err != nil {
		return nil, errtrace.Wrap(err)
	}
	return m, nil
}

// load reads SQLite first, falling back to the legacy JSON import source only
// when the database catalogue is empty. A missing legacy file is not an error.
func (m *Manager) load() error {
	if m.store != nil {
		rows, err := m.store.ListProjects()
		if err != nil {
			return errtrace.Wrap(fmt.Errorf("read projects from database: %w", err))
		}
		if len(rows) > 0 {
			m.projects = projectsFromRows(rows)
			m.registerPaths()
			return nil
		}
	}

	data, err := os.ReadFile(m.filePath)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return errtrace.Wrap(fmt.Errorf("read projects file: %w", err))
	}
	if err := json.Unmarshal(data, &m.projects); err != nil {
		return errtrace.Wrap(err)
	}
	if m.store != nil {
		if err := m.save(); err != nil {
			return errtrace.Wrap(fmt.Errorf("import projects into database: %w", err))
		}
	}
	m.registerPaths()
	return nil
}

// save persists the complete ordered project list.
func (m *Manager) save() error {
	if m.store != nil {
		rows := make([]db.Project, len(m.projects))
		for i, p := range m.projects {
			rows[i] = db.Project{ID: p.ID, Path: p.Path, Name: p.Name, Builtin: p.Builtin, Hidden: p.Hidden, Position: i}
		}
		return errtrace.Wrap(m.store.ReplaceProjects(rows))
	}
	data, err := json.MarshalIndent(m.projects, "", "  ")
	if err != nil {
		return errtrace.Wrap(fmt.Errorf("marshal projects: %w", err))
	}
	if err := os.WriteFile(m.filePath, data, 0644); err != nil {
		return errtrace.Wrap(fmt.Errorf("write projects file: %w", err))
	}
	return nil
}

func projectsFromRows(rows []db.Project) []ProjectInfo {
	projects := make([]ProjectInfo, len(rows))
	for i, p := range rows {
		projects[i] = ProjectInfo{ID: p.ID, Path: p.Path, Name: p.Name, Builtin: p.Builtin, Hidden: p.Hidden}
	}
	return projects
}

func (m *Manager) registerPaths() {
	for _, p := range m.projects {
		statepath.RegisterProject(p.ID, p.Path)
	}
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

// RemoveProject removes the project with the given ID from the persisted list.
// It does not delete any files. Returns false if not found.
func (m *Manager) RemoveProject(id string) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i, p := range m.projects {
		if p.ID == id {
			m.projects = append(m.projects[:i], m.projects[i+1:]...)
			if err := m.save(); err != nil {
				m.projects = append(m.projects[:i], append([]ProjectInfo{p}, m.projects[i:]...)...)
				return false, errtrace.Wrap(err)
			}
			statepath.UnregisterProject(p.Path)
			return true, nil
		}
	}
	return false, nil
}

// ReorderProjects rewrites the stored order of the project list to match ids.
// The list order *is* the order the UI shows, so this is what backs the
// drag-to-reorder in the project dropdown.
//
// Deliberately lenient about the ids it is given: any project not named in ids
// keeps its relative order and is appended after the named ones, and ids that
// name no known project are ignored. A client's list is always a snapshot -
// another window may have added or removed a project since it rendered - and
// dropping the whole reorder over that would be worse than placing a project
// the client never saw at the end.
func (m *Manager) ReorderProjects(ids []string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	prev := m.projects
	byID := make(map[string]ProjectInfo, len(m.projects))
	for _, p := range m.projects {
		byID[p.ID] = p
	}
	ordered := make([]ProjectInfo, 0, len(m.projects))
	seen := make(map[string]bool, len(ids))
	for _, id := range ids {
		p, ok := byID[id]
		if !ok || seen[id] {
			continue
		}
		seen[id] = true
		ordered = append(ordered, p)
	}
	for _, p := range prev {
		if !seen[p.ID] {
			ordered = append(ordered, p)
		}
	}

	m.projects = ordered
	if err := m.save(); err != nil {
		m.projects = prev // rollback, so memory and disk stay in step
		return errtrace.Wrap(err)
	}
	return nil
}

// SetHidden hides or shows the project with the given ID (see
// ProjectInfo.Hidden). Returns false if there is no such project.
func (m *Manager) SetHidden(id string, hidden bool) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i := range m.projects {
		if m.projects[i].ID != id {
			continue
		}
		if m.projects[i].Hidden == hidden {
			return true, nil // already there; don't rewrite the file
		}
		m.projects[i].Hidden = hidden
		if err := m.save(); err != nil {
			m.projects[i].Hidden = !hidden // rollback, so memory and disk stay in step
			return false, errtrace.Wrap(err)
		}
		return true, nil
	}
	return false, nil
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

	// Idempotent: return existing entry for this path. Adding a folder you had
	// hidden un-hides it - the add flow ends by selecting the project, so leaving
	// it out of the list would read as "nothing happened".
	for i := range m.projects {
		if !paths.ComparePaths(m.projects[i].Path, path) {
			continue
		}
		if m.projects[i].Hidden {
			m.projects[i].Hidden = false
			if err := m.save(); err != nil {
				m.projects[i].Hidden = true
				return ProjectInfo{}, errtrace.Wrap(err)
			}
		}
		return m.projects[i], nil
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
	statepath.RegisterProject(p.ID, p.Path)
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
