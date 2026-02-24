package heads

import (
	"encoding/json"
	"os"

	"github.com/trolleyman/hydra/internal/apitypes"
	"github.com/trolleyman/hydra/internal/paths"
)

// AgentStatusInfo represents the hook-reported status of an agent session.
// It is written to ~/.hydra-status.json inside the agent by the hydra-status.sh
// hook script (triggered on SessionStart, Stop, and SessionEnd).
type AgentStatusInfo struct {
	apitypes.AgentStatusInfo
}

// readAgentStatus reads the agent hook status from the <projectId>/.hydra/status/<id>.json
// file. Returns nil if the file doesn't exist or is invalid.
func readAgentStatus(projectDir, id string) *AgentStatusInfo {
	path := paths.GetStatusJsonFromProjectRoot(projectDir, id)
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var s AgentStatusInfo
	if err := json.Unmarshal(data, &s); err != nil {
		return nil
	}
	return &s
}
