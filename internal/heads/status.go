package heads

import (
	"encoding/json"
	"os"

	"github.com/trolleyman/hydra/internal/paths"
)

// ClaudeStatus represents the hook-reported status of a Claude agent session.
// It is written to ~/.hydra-status.json inside the agent by the  hydra-status.sh
// hook script (triggered on SessionStart, Stop, and SessionEnd).
type ClaudeStatus struct {
	// Status is one of: "starting", "waiting", "ended", or "unknown".
	Status string `json:"status"`
	// Event is the Claude Code hook event that triggered this status
	// (SessionStart, Stop, or SessionEnd).
	Event string `json:"event"`
	// Timestamp is the ISO 8601 time the status was recorded.
	Timestamp string `json:"timestamp"`
	// LastMessage is the last assistant message (only present on Stop events).
	LastMessage string `json:"last_message,omitempty"`
	// Reason is the session end reason (only present on SessionEnd events).
	Reason string `json:"reason,omitempty"`
}

// readClaudeStatus reads the Claude hook status from the <projectId>/.hydra/status/<id>.json
// file. Returns nil if the file doesn't exist or is invalid.
func readClaudeStatus(projectDir, id string) *ClaudeStatus {
	path := paths.GetStatusJsonFromProjectRoot(projectDir, id)
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var s ClaudeStatus
	if err := json.Unmarshal(data, &s); err != nil {
		return nil
	}
	return &s
}
