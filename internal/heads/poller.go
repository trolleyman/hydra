package heads

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"time"

	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/db"
	"github.com/trolleyman/hydra/internal/paths"
	"github.com/trolleyman/hydra/internal/session"
)

// RunLivenessReconciler periodically syncs session-registry liveness into the
// DB. The registry's OnExit callback is the primary, low-latency signal; this
// loop is a backstop that also reconciles rows whose session is gone.
//
// roots returns the set of project roots to reconcile on each tick; it is
// re-evaluated every cycle so projects added/removed at runtime are picked up.
func RunLivenessReconciler(ctx context.Context, reg *session.Registry, store *db.Store, roots func() []string) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			for _, root := range roots() {
				ReconcileLivenessOnce(reg, store, root)
			}
		}
	}
}

// ReconcileLivenessOnce performs a single liveness reconciliation cycle.
func ReconcileLivenessOnce(reg *session.Registry, store *db.Store, projectRoot string) {
	live := make(map[string]session.Info)
	if reg != nil {
		for _, info := range reg.Snapshot() {
			live[info.ID] = info
		}
	}

	dbAgents, err := store.ListAgents(projectRoot)
	if err != nil {
		log.Printf("warn: liveness reconciler: list db agents: %v", err)
		return
	}

	for _, a := range dbAgents {
		info, ok := live[a.ID]
		switch {
		case ok && (info.Status == session.StatusRunning || info.Status == session.StatusStarting):
			if err := store.UpdateSessionInfo(a.ID, info.PID, "running"); err != nil {
				log.Printf("warn: liveness reconciler: update %s: %v", a.ID, err)
			}
		case a.SessionStatus == "running":
			// Was running but the session is gone (exited or daemon restarted).
			if err := store.UpdateSessionInfo(a.ID, 0, "stopped"); err != nil {
				log.Printf("warn: liveness reconciler: mark stopped %s: %v", a.ID, err)
			}
		}
	}
}

// RunJSONStatusPoller runs a polling loop that syncs JSON status files into the
// DB every 1 second. roots returns the set of project roots to poll on each
// tick; it is re-evaluated every cycle so projects added/removed at runtime are
// picked up.
func RunJSONStatusPoller(ctx context.Context, store *db.Store, roots func() []string) {
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			for _, root := range roots() {
				RunJSONStatusPollerOnce(store, root)
			}
		}
	}
}

// RunJSONStatusPollerOnce performs a single JSON status polling cycle.
func RunJSONStatusPollerOnce(store *db.Store, projectRoot string) {
	pollJSONStatusOnce(store, projectRoot)
}

func pollJSONStatusOnce(store *db.Store, projectRoot string) {
	agents, err := store.ListAgents(projectRoot)
	if err != nil {
		log.Printf("warn: json status poller: list agents: %v", err)
		return
	}

	for _, a := range agents {
		if a.SessionStatus != "running" {
			continue
		}
		info := readStatusJSON(projectRoot, a.ID)
		if info == nil || info.Timestamp == "" {
			continue
		}
		if !statusTimeAfter(info.Timestamp, a.AgentStatusTime) {
			continue
		}
		agentStatus := mapAgentStatus(info.Status)
		if agentStatus == "" {
			continue
		}
		// Raise the unread-changes flag on a running→waiting/finished transition
		// (the moments the user wants to be drawn back to). Only that specific
		// transition counts, so e.g. a starting→waiting flicker doesn't mark it.
		markUnread := a.AgentStatus != nil && *a.AgentStatus == "running" &&
			(agentStatus == "waiting" || agentStatus == "finished")
		if err := store.UpdateAgentStatus(a.ID, agentStatus, info.Timestamp, markUnread); err != nil {
			log.Printf("warn: json status poller: update agent status for %s: %v", a.ID, err)
		}
	}
}

func readStatusJSON(projectRoot, id string) *api.AgentStatusInfo {
	path := paths.GetStatusJsonFromProjectRoot(projectRoot, id)
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var s api.AgentStatusInfo
	if err := json.Unmarshal(data, &s); err != nil {
		return nil
	}
	return &s
}

// mapAgentStatus maps an api.AgentStatus value to the DB agent_status string.
func mapAgentStatus(s api.AgentStatus) string {
	switch s {
	case api.Starting:
		return "starting"
	case api.Running:
		return "running"
	case api.Waiting:
		return "waiting"
	case api.Finished:
		return "finished"
	case api.Stopped, "ended", "exited":
		return "stopped"
	default:
		return ""
	}
}

// statusTimeAfter reports whether status timestamp a is strictly after b. Both
// are RFC3339/RFC3339Nano; an unparseable a never wins, and an unparseable (or
// empty) b loses to any valid a. Parsing — rather than string comparison —
// matters because status writes can collide within a single second (the spawn
// "starting" write and the SessionStart "running" hook), and the trailing-zero
// trimming in RFC3339Nano makes lexical ordering unreliable.
func statusTimeAfter(a, b string) bool {
	ta, err := time.Parse(time.RFC3339Nano, a)
	if err != nil {
		return false
	}
	tb, err := time.Parse(time.RFC3339Nano, b)
	if err != nil {
		return true
	}
	return ta.After(tb)
}
