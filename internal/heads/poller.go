package heads

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"time"

	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/db"
	"github.com/trolleyman/hydra/internal/events"
	"github.com/trolleyman/hydra/internal/paths"
	"github.com/trolleyman/hydra/internal/session"
)

// RunLivenessReconciler periodically syncs session-registry liveness into the
// DB. The registry's OnExit callback is the primary, low-latency signal; this
// loop is a backstop that also reconciles rows whose session is gone.
//
// roots returns the set of project roots to reconcile on each tick; it is
// re-evaluated every cycle so projects added/removed at runtime are picked up.
func RunLivenessReconciler(ctx context.Context, reg *session.Registry, store *db.Store, roots func() []string, hub *events.Hub) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			for _, root := range roots() {
				ReconcileLivenessOnce(reg, store, root, hub)
			}
		}
	}
}

// ReconcileLivenessOnce performs a single liveness reconciliation cycle. When a
// session's status actually transitions it publishes an agents_changed event on
// hub (nil hub = no-op) so web clients refetch without polling.
func ReconcileLivenessOnce(reg *session.Registry, store *db.Store, projectRoot string, hub *events.Hub) {
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

	changed := false
	for _, a := range dbAgents {
		info, ok := live[a.ID]
		// A session can linger in the registry as "running" after its process has
		// actually died, if the read loop never saw the PTY close (e.g. a resume
		// whose agent exited immediately). Such a stale entry keeps IsLive true,
		// which both blocks lazy resume-on-attach and pins the head at "running"
		// here forever. Probe the real process and reap it if it's gone, so the
		// branches below treat it as the dead session it is.
		if ok && (info.Status == session.StatusRunning || info.Status == session.StatusStarting) {
			if reg.ReapDead(a.ID) {
				ok = false
			}
		}
		switch {
		case ok && (info.Status == session.StatusRunning || info.Status == session.StatusStarting):
			if err := store.UpdateSessionInfo(a.ID, info.PID, "running"); err != nil {
				log.Printf("warn: liveness reconciler: update %s: %v", a.ID, err)
			}
			// This runs every tick for a live agent (idempotent); only a genuine
			// transition into "running" is a change worth pushing.
			if a.SessionStatus != "running" {
				changed = true
			}
		case a.SessionStatus == "running":
			// Was running but the session is gone (exited, reaped above, or daemon
			// restarted).
			if err := store.UpdateSessionInfo(a.ID, 0, "stopped"); err != nil {
				log.Printf("warn: liveness reconciler: mark stopped %s: %v", a.ID, err)
			}
			changed = true
		}
	}
	if changed {
		hub.AgentsChanged(projectRoot)
	}
}

// graceUnread is how long a running-to-finished transition must persist
// before the poller raises the unread-changes flag.
// It exists because a head that ends its turn to await a *background subagent*
// briefly writes "finished" to the shared per-head status.json (its Stop hook),
// and the subagent - which runs in the same sandbox and writes the same file -
// resets it to "running" again within ~1s via its own tool hooks. Without this
// grace the 1s poller would latch a spurious unread dot on that blip even though
// the head is still working and resumes on its own. A genuine finish (nothing
// resetting it) outlasts the window and still raises the flag.
const graceUnread = 5 * time.Second

// SettleFunc is called by the poller the moment a head transitions into a
// resting status (finished / waiting / needs_input) - a definitive "the agent
// stopped editing" signal. The daemon wires it to the artifact prefetcher so a
// head's screenshots are pre-generated at once instead of waiting for the slower
// worktree-settle sweep. It must not block the poller (the caller runs it in its
// own goroutine); a nil func disables the hook.
type SettleFunc func(projectRoot, headID string)

// RunJSONStatusPoller runs a polling loop that syncs JSON status files into the
// DB every 1 second. roots returns the set of project roots to poll on each
// tick; it is re-evaluated every cycle so projects added/removed at runtime are
// picked up. onSettle (may be nil) is invoked on transitions into a resting
// status so background artifact generation can start immediately.
func RunJSONStatusPoller(ctx context.Context, store *db.Store, roots func() []string, hub *events.Hub, onSettle SettleFunc) {
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()
	// One debouncer for the lifetime of the loop: its pending-unread state must
	// survive across ticks for the grace window to mean anything.
	deb := newUnreadDebouncer()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			for _, root := range roots() {
				pollJSONStatusOnce(store, root, deb, hub, onSettle)
			}
		}
	}
}

// RunJSONStatusPollerOnce performs a single JSON status polling cycle. It uses a
// throwaway debouncer, so deferred unread flags never mature within one call -
// it is only the boot warmup; the long-lived RunJSONStatusPoller loop owns the
// persistent debouncer that actually resolves them. It fires no settle hook: boot
// warmup is the periodic prefetcher's job, not a fresh transition.
func RunJSONStatusPollerOnce(store *db.Store, projectRoot string) {
	pollJSONStatusOnce(store, projectRoot, newUnreadDebouncer(), nil, nil)
}

// pendingUnread records a running-to-finished transition whose unread flag
// is being deferred, along with the status it is waiting to confirm.
type pendingUnread struct {
	status string
	since  time.Time
}

// unreadDebouncer defers the unread-changes flag for transitions that can be a
// transient delegation blip (see graceUnread). It is keyed by agent id and
// owned by the single poller goroutine, so it needs no locking. now is the clock
// the poller reads for arm/ready timing; it is time.Now in production and
// overridable in tests so the grace window can be advanced deterministically.
type unreadDebouncer struct {
	pending map[string]pendingUnread
	now     func() time.Time
}

func newUnreadDebouncer() *unreadDebouncer {
	return &unreadDebouncer{pending: make(map[string]pendingUnread), now: time.Now}
}

// arm starts (or keeps) deferring the unread flag for id in the given status.
// Re-arming the same status preserves the original timestamp so the grace
// window keeps counting rather than restarting each poll.
func (d *unreadDebouncer) arm(id, status string, now time.Time) {
	if cur, ok := d.pending[id]; ok && cur.status == status {
		return
	}
	d.pending[id] = pendingUnread{status: status, since: now}
}

func (d *unreadDebouncer) forget(id string) {
	delete(d.pending, id)
}

// take removes id's pending entry and reports whether one was present. The
// poller uses it when an agent's session ends: a pending entry means the agent
// had reached finished/waiting and we were still riding out the grace window to
// tell a genuine finish from a transient subagent blip. A blip keeps the same
// session alive, so the session ending is definitive proof of a real finish -
// the caller raises the flag now instead of dropping it.
func (d *unreadDebouncer) take(id string) bool {
	if _, ok := d.pending[id]; !ok {
		return false
	}
	delete(d.pending, id)
	return true
}

// ready reports whether id's deferred flag has matured: the agent is still in
// the status it was armed for and graceUnread has elapsed. The entry is cleared
// when it fires, or when the status no longer matches (the transition was a
// blip that has since changed).
func (d *unreadDebouncer) ready(id, status string, now time.Time) bool {
	p, ok := d.pending[id]
	if !ok {
		return false
	}
	if p.status != status {
		delete(d.pending, id)
		return false
	}
	if now.Sub(p.since) >= graceUnread {
		delete(d.pending, id)
		return true
	}
	return false
}

// StatusFile is the on-disk shape of a per-head status.json. trigger_hook (the
// writer) and the poller (the reader) share this type. It currently adds nothing
// to the API-facing AgentStatusInfo - the immediacy of a wait is now encoded in
// the status value itself (needs_input vs waiting) rather than in a side channel
// - but it stays as the named on-disk type so the read/write split is explicit
// and future internal-only fields have a home.
type StatusFile struct {
	api.AgentStatusInfo
}

func pollJSONStatusOnce(store *db.Store, projectRoot string, deb *unreadDebouncer, hub *events.Hub, onSettle SettleFunc) {
	agents, err := store.ListAgents(projectRoot)
	if err != nil {
		log.Printf("warn: json status poller: list agents: %v", err)
		return
	}

	now := deb.now()
	changed := false
	// Tracks whether an unread flag actually went up this tick (distinct from any
	// status churn). A raised flag moves this project's cross-project unread total,
	// so it warrants a broadcast projects_changed; ordinary status changes do not.
	unreadRaised := false
	for _, a := range agents {
		if a.SessionStatus != "running" {
			// The session has ended. If a deferred unread was still pending for
			// this agent - it had reached finished/waiting and we were riding out
			// the grace window to tell a real finish from a transient subagent
			// blip - the session exiting confirms a genuine finish (a blip keeps
			// the same session alive; only a real end stops it). Raise the flag now
			// instead of dropping it, so the unread dot still appears for an agent
			// that finishes and exits before the grace window elapses. This is
			// mostly invisible for an agent you have open (opening it resumes the
			// session and the auto-clear effect dismisses the dot), so it bit
			// non-selected agents.
			if deb.take(a.ID) {
				if err := store.RaiseUnread(a.ID); err != nil {
					log.Printf("warn: json status poller: raise unread on session exit for %s: %v", a.ID, err)
				} else {
					changed = true
					unreadRaised = true
				}
			}
			continue
		}
		info := readStatusJSON(projectRoot, a.ID)
		if info == nil || info.Timestamp == "" {
			continue
		}
		agentStatus := mapAgentStatus(info.Status)
		if agentStatus == "" {
			continue
		}

		if statusTimeAfter(info.Timestamp, a.AgentStatusTime) {
			// The unread-changes flag is for the moments the user wants to be
			// drawn back to. The needs_input status is the explicit "the agent is
			// blocked on you" signal (AskUserQuestion/ExitPlanMode/permission), so
			// it's flagged the moment it appears, whatever the prior state. A
			// running-to-finished transition is deferred (graceUnread) because a
			// finished blip also fires when a head pauses to await a background
			// subagent that resumes on its own. The idle running-to-waiting nudge
			// raises no unread flag at all: waiting is never an explicit "needs
			// you" wait (those are needs_input) - it means the head has gone quiet
			// or is awaiting a background subagent, neither a moment to pull the
			// user back to - so it advances the status but arms no unread flag.
			prevRunning := a.AgentStatus != nil && *a.AgentStatus == "running"
			statusChanged := a.AgentStatus == nil || *a.AgentStatus != agentStatus
			immediate := statusChanged && agentStatus == "needs_input"
			// Only a change the client actually renders is worth an agents_changed
			// event: the status string flipping, or the unread flag being raised
			// (immediate). A running agent rewrites status.json on every tool call,
			// advancing the timestamp while staying "running" - we must persist that
			// so statusTimeAfter stops re-firing, but it yields an identical
			// AgentResponse (the timestamp isn't exposed), so emitting an event for it
			// just makes every connected client refetch agents (and, via the frontend,
			// push-status) roughly once a second for no visible change.
			if err := store.UpdateAgentStatus(a.ID, agentStatus, info.Timestamp, immediate); err != nil {
				log.Printf("warn: json status poller: update agent status for %s: %v", a.ID, err)
			} else {
				if statusChanged || immediate {
					changed = true
				}
				if immediate {
					unreadRaised = true
				}
			}
			switch {
			case immediate:
				deb.forget(a.ID)
			case prevRunning && agentStatus == "finished":
				deb.arm(a.ID, agentStatus, now)
			case agentStatus == "running" || agentStatus == "starting":
				// Activity resumed (e.g. the subagent's next tool hook) - cancel
				// any pending flag before it can mature.
				deb.forget(a.ID)
			}

			// A genuine transition into a resting status means the agent has stopped
			// editing, so its worktree is a stable target: kick off background
			// artifact generation now instead of waiting for the slower
			// worktree-settle sweep. Gated on statusChanged so a running agent's
			// per-tool-call status rewrites (which only advance the timestamp) don't
			// re-fire it; redundant fires are cheap anyway (the artifact manager
			// dedups by worktree version).
			if onSettle != nil && statusChanged &&
				(agentStatus == "finished" || agentStatus == "waiting" || agentStatus == "needs_input") {
				onSettle(projectRoot, a.ID)
			}
		}

		// Confirm a deferred flag once the agent has held the state past the
		// grace window without resuming activity.
		if deb.ready(a.ID, agentStatus, now) {
			if err := store.RaiseUnread(a.ID); err != nil {
				log.Printf("warn: json status poller: raise unread for %s: %v", a.ID, err)
			} else {
				changed = true
				unreadRaised = true
			}
		}
	}

	// Coalesced push: one agents_changed for the project if anything moved this
	// tick, so clients viewing this project refetch its list immediately.
	if changed {
		hub.AgentsChanged(projectRoot)
	}
	// A raised unread flag also moves this project's cross-project unread total,
	// which drives the "updates elsewhere" indicator and the browser-tab dot on
	// clients viewing *other* projects (their per-project agents_changed never
	// reaches them). Broadcast projects_changed so they refetch the project list -
	// but only when an unread flag actually went up, so ordinary status churn
	// still stays off this cross-project path and the hot 1s loop stays cheap. The
	// read/clear path does the same from the API handler (notifyAgentsChanged).
	if unreadRaised {
		hub.ProjectsChanged()
	}
}

func readStatusJSON(projectRoot, id string) *StatusFile {
	path := paths.GetStatusJsonFromProjectRoot(projectRoot, id)
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var s StatusFile
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
	case api.NeedsInput:
		return "needs_input"
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
// empty) b loses to any valid a. Parsing - rather than string comparison -
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
