package heads

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"

	"github.com/trolleyman/hydra/internal/paths"
)

// Default PTY size used when no client has ever reported a terminal geometry —
// the classic VT100 80x24. It's almost always wrong for a browser (usually far
// wider), which is exactly why we persist and prefer the last real size a client
// sent: an agent resumed at this default repaints its UI at 80 cols, and those
// narrow-wrapped bytes then look broken once a wider browser attaches and
// replays the scrollback.
const (
	defaultResumeRows uint16 = 24
	defaultResumeCols uint16 = 80
)

type termGeometry struct {
	Rows uint16 `json:"rows"`
	Cols uint16 `json:"cols"`
}

func (g termGeometry) valid() bool { return g.Rows > 0 && g.Cols > 0 }

// terminalGeometryStore is the on-disk shape of a project's geometry file: a
// size remembered per head (the client persists the terminal panel height per
// agent, so heads genuinely differ in row count), plus a project-wide fallback —
// the last size any head reported — used to seed a head that has no size of its
// own yet.
type terminalGeometryStore struct {
	Project termGeometry            `json:"project"`
	Heads   map[string]termGeometry `json:"heads"`
}

var (
	resumeSizeMu   sync.Mutex
	lastResumeSize = map[string]termGeometry{} // projectRoot\x00headID -> last persisted size
)

func loadGeometryStore(projectRoot string) terminalGeometryStore {
	var s terminalGeometryStore
	if data, err := os.ReadFile(paths.GetTerminalGeometryPath(projectRoot)); err == nil {
		_ = json.Unmarshal(data, &s)
	}
	if s.Heads == nil {
		s.Heads = map[string]termGeometry{}
	}
	return s
}

// LoadResumeSize returns the geometry to seed a PTY started or resumed without a
// live client to measure it (daemon boot resume, TUI resume, the HTTP seed
// fallback). It prefers the size last reported for this specific head, then the
// project-wide fallback, then the 80x24 default. Mirrors the browser's geometry
// seed but server-side, so it works even when no client is connected.
func LoadResumeSize(projectRoot, headID string) (rows, cols uint16) {
	s := loadGeometryStore(projectRoot)
	if g, ok := s.Heads[headID]; ok && g.valid() {
		return g.Rows, g.Cols
	}
	if s.Project.valid() {
		return s.Project.Rows, s.Project.Cols
	}
	return defaultResumeRows, defaultResumeCols
}

// SaveResumeSize records the geometry a client just sent for a head and updates
// the project-wide fallback, so a later clientless resume renders at the right
// width. It's a no-op when the size is unchanged from the last persisted value
// for that head, so the frequent resizes during a drag don't churn the disk.
// Best-effort: a persistence failure only costs a slightly-wrong resume default
// next time, never a live resize.
func SaveResumeSize(projectRoot, headID string, rows, cols uint16) {
	if rows == 0 || cols == 0 {
		return
	}
	g := termGeometry{Rows: rows, Cols: cols}
	key := projectRoot + "\x00" + headID

	// Hold the lock across the read-modify-write so concurrent writers (e.g. two
	// heads resizing at once) don't clobber each other's entries.
	resumeSizeMu.Lock()
	defer resumeSizeMu.Unlock()
	if last, ok := lastResumeSize[key]; ok && last == g {
		return
	}

	s := loadGeometryStore(projectRoot)
	s.Heads[headID] = g
	s.Project = g

	path := paths.GetTerminalGeometryPath(projectRoot)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return
	}
	data, err := json.Marshal(s)
	if err != nil {
		return
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return
	}
	lastResumeSize[key] = g
}
