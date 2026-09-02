package http

import (
	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/heads"
)

// shouldScheduleAutoRun applies the per-runner policy to proactive background
// work. Unknown values use the historical behavior so a typo cannot silently
// turn CI off.
func shouldScheduleAutoRun(mode config.AutoRunMode, agentRunning bool) bool {
	switch mode {
	case config.AutoRunNever:
		return false
	case config.AutoRunSettled:
		return !agentRunning
	default:
		return true
	}
}

// shouldAutoRunOnView reports whether a passive tests/artifacts read may start
// missing work. "settled" belongs to the settle-triggered prefetchers, not to a
// page open that happens to observe an already-resting head; "never" requires an
// explicit Refresh or a workflow such as merge that requires a current verdict.
func shouldAutoRunOnView(mode config.AutoRunMode) bool {
	switch mode {
	case config.AutoRunSettled, config.AutoRunNever:
		return false
	default:
		return true
	}
}

func headActivelyRunning(head *heads.Head) bool {
	if head == nil || head.AgentStatus == nil {
		return false
	}
	return head.AgentStatus.Status == api.Running || head.AgentStatus.Status == api.Starting
}
