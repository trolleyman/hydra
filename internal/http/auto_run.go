package http

import (
	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/heads"
)

// shouldAutoRun applies the per-runner automatic-run policy. Unknown values use
// the historical behavior so a typo cannot silently turn CI off.
func shouldAutoRun(mode string, agentRunning bool) bool {
	switch mode {
	case "never":
		return false
	case "settled":
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
