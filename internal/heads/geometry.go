package heads

import (
	"github.com/trolleyman/hydra/internal/db"
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

// LoadResumeSize returns the geometry to seed a PTY started or resumed without a
// live client to measure it (daemon boot resume, TUI resume, the HTTP seed
// fallback). It prefers the size last reported for this specific head (stored on
// the head's DB row), then the most recent size across the project's heads, then
// the 80x24 default — so a head with no size of its own still resumes at a sane
// width. Mirrors the browser's geometry seed but server-side, so it works even
// when no client is connected. Best-effort: any DB error falls through.
func LoadResumeSize(store *db.Store, projectRoot, headID string) (rows, cols uint16) {
	if store == nil {
		return defaultResumeRows, defaultResumeCols
	}
	if r, c, err := store.GetAgentTermSize(headID); err == nil && r > 0 && c > 0 {
		return r, c
	}
	if r, c, err := store.LatestTermSizeForProject(projectRoot); err == nil && r > 0 && c > 0 {
		return r, c
	}
	return defaultResumeRows, defaultResumeCols
}

// SaveResumeSize records, on the head's DB row, the geometry a client just sent,
// so a later clientless resume renders at the right width. Best-effort: a
// persistence failure only costs a slightly-wrong resume default next time,
// never a live resize.
func SaveResumeSize(store *db.Store, headID string, rows, cols uint16) {
	if store == nil || rows == 0 || cols == 0 {
		return
	}
	_ = store.SetAgentTermSize(headID, rows, cols)
}
