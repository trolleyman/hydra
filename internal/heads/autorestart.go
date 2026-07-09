package heads

import (
	"context"
	"log"
	"sync"
	"time"

	"github.com/trolleyman/hydra/internal/db"
	"github.com/trolleyman/hydra/internal/session"
)

// Auto-restart: a head whose session dies without hydra asking for it - an
// agent pkill-ing its own process, a CLI crash, an OOM kill, a stray /exit -
// is resumed automatically, so it keeps working without the user having to
// notice and reattach. Deliberate stops (kill/merge, the chat-mode toggle,
// RestartHead, daemon drain) are flagged by the registry (Info.StopRequested)
// and never restart. A crash loop is capped: once a head has been restarted
// autoRestartBurst times inside autoRestartWindow, further restarts are
// parked and the head stays stopped (the on-attach lazy resume remains the
// manual way back).

const (
	autoRestartBurst  = 3
	autoRestartWindow = 60 * time.Second
)

// autoRestartDelay separates the exit from the relaunch, letting the exit
// bookkeeping (DB status write, attacher teardown) settle and giving an
// attached client's own reconnect-resume the first move. A var so tests can
// shrink it.
var autoRestartDelay = time.Second

// restartHistory is the per-head sliding window of auto-restart timestamps.
type restartHistory struct {
	mu     sync.Mutex
	byHead map[string][]time.Time
}

var autoRestarts = &restartHistory{byHead: map[string][]time.Time{}}

// allow records a restart attempt at now and reports whether it fits the
// budget: at most autoRestartBurst restarts per autoRestartWindow per head. A
// denied attempt is not recorded, so a head that keeps crashing is retried
// again once the earlier restarts age out of the window.
func (h *restartHistory) allow(id string, now time.Time) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	recent := h.byHead[id][:0]
	for _, t := range h.byHead[id] {
		if now.Sub(t) < autoRestartWindow {
			recent = append(recent, t)
		}
	}
	if len(recent) >= autoRestartBurst {
		h.byHead[id] = recent
		return false
	}
	h.byHead[id] = append(recent, now)
	return true
}

// forget drops a head's restart history (kill/merge teardown).
func (h *restartHistory) forget(id string) {
	h.mu.Lock()
	delete(h.byHead, id)
	h.mu.Unlock()
}

// autoRestartResume performs the actual relaunch; a test seam.
var autoRestartResume = func(reg *session.Registry, store *db.Store, projectRoot string, head Head, rows, cols uint16) error {
	return ResumeHead(reg, store, projectRoot, head, rows, cols) //errtrace:skip
}

// MaybeAutoRestartHead is wired to Registry.SetOnExit: it resumes a head whose
// agent process died without hydra requesting it. The heavy lifting runs on
// its own goroutine (onExit is called from the session read loop).
func MaybeAutoRestartHead(reg *session.Registry, store *db.Store, info session.Info) {
	// Deliberate stops never restart; ephemeral sessions are web bash shells.
	if info.StopRequested || info.Ephemeral || store == nil {
		return
	}
	// Only agent sessions restart. Shell/session ids that aren't agent rows -
	// and heads already killed (soft-deleted rows read back as nil) - drop out
	// here.
	agent, err := store.GetAgent(info.ID)
	if err != nil || agent == nil || agent.Ephemeral || agent.ProjectPath == "" {
		return
	}
	if !autoRestarts.allow(info.ID, time.Now()) {
		log.Printf("heads: auto-restart of %s suppressed: %d restarts within %s (crash loop); head stays stopped", info.ID, autoRestartBurst, autoRestartWindow)
		return
	}
	projectRoot := agent.ProjectPath
	go func() {
		time.Sleep(autoRestartDelay)
		// An attached client's reconnect (or another exit's restart) may have
		// resumed it already; ResumeHead also re-checks under its lock.
		if reg.IsLive(info.ID) {
			return
		}
		head, err := GetHeadByID(context.Background(), reg, store, projectRoot, info.ID)
		if err != nil || head == nil {
			log.Printf("heads: auto-restart of %s skipped: head not found (killed since?): %v", info.ID, err)
			return
		}
		if head.Worktree == nil {
			return
		}
		rows, cols := LoadResumeSize(store, projectRoot, info.ID)
		log.Printf("heads: session for %s exited unexpectedly; auto-restarting", info.ID)
		if err := autoRestartResume(reg, store, projectRoot, *head, rows, cols); err != nil {
			log.Printf("heads: auto-restart of %s failed: %v", info.ID, err)
		}
	}()
}
