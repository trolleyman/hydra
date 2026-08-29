package http

import (
	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/heads"
)

// shouldAutoRun applies the per-runner automatic-run policy. Unknown values use
// the historical behavior so a typo cannot silently turn CI off.
func shouldAutoRun(mode config.AutoRunMode, agentRunning bool) bool {
	switch mode {
	case config.AutoRunNever:
		return false
	case config.AutoRunSettled:
		return !agentRunning
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
