package heads

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"

	"github.com/trolleyman/hydra/internal/paths"
)

// Default PTY size used when no client has ever reported a terminal geometry for
// a project — the classic VT100 80x24. It's almost always wrong for a browser
// (usually far wider), which is exactly why we persist and prefer the last real
// size a client sent: an agent resumed at this default repaints its UI at 80
// cols, and those narrow-wrapped bytes then look broken once a wider browser
// attaches and replays the scrollback.
const (
	defaultResumeRows uint16 = 24
	defaultResumeCols uint16 = 80
)

type termGeometry struct {
	Rows uint16 `json:"rows"`
	Cols uint16 `json:"cols"`
}

var (
	resumeSizeMu   sync.Mutex
	lastResumeSize = map[string]termGeometry{} // projectRoot -> last persisted size
)

// LoadResumeSize returns the last terminal geometry a client reported for the
// project, used to seed the PTY when a session is started or resumed without a
// live client to measure it (daemon boot resume, TUI resume). It mirrors the
// browser's localStorage geometry seed, but server-side so it works even when no
// browser is connected. Falls back to the 80x24 default when nothing has been
// recorded or the file is unreadable/corrupt.
func LoadResumeSize(projectRoot string) (rows, cols uint16) {
	data, err := os.ReadFile(paths.GetTerminalGeometryPath(projectRoot))
	if err != nil {
		return defaultResumeRows, defaultResumeCols
	}
	var g termGeometry
	if err := json.Unmarshal(data, &g); err != nil || g.Rows == 0 || g.Cols == 0 {
		return defaultResumeRows, defaultResumeCols
	}
	return g.Rows, g.Cols
}

// SaveResumeSize records the geometry a client just sent so a later clientless
// resume renders at the right width. It's a no-op when the size is unchanged
// from the last persisted value, so the frequent resizes during a drag don't
// churn the disk. Best-effort: a persistence failure only costs a slightly
// wrong resume default next time, never a live resize.
func SaveResumeSize(projectRoot string, rows, cols uint16) {
	if rows == 0 || cols == 0 {
		return
	}
	g := termGeometry{Rows: rows, Cols: cols}

	resumeSizeMu.Lock()
	if last, ok := lastResumeSize[projectRoot]; ok && last == g {
		resumeSizeMu.Unlock()
		return
	}
	lastResumeSize[projectRoot] = g
	resumeSizeMu.Unlock()

	path := paths.GetTerminalGeometryPath(projectRoot)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return
	}
	data, err := json.Marshal(g)
	if err != nil {
		return
	}
	_ = os.WriteFile(path, data, 0o644)
}
