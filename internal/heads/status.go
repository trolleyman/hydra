package heads

import (
	"encoding/json"
	"os"
	"path/filepath"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/paths"
)

// ReadAgentStatus reads the agent hook status from the <projectId>/.hydra/status/<id>.json
// file. Returns nil if the file doesn't exist or is invalid.
func ReadAgentStatus(projectDir, id string) *api.AgentStatusInfo {
	path := paths.GetStatusJsonFromProjectRoot(projectDir, id)
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

// WriteAgentStatus writes the agent hook status to <projectId>/.hydra/status/<id>.json.
func WriteAgentStatus(projectDir, id string, status *api.AgentStatusInfo) error {
	path := paths.GetStatusJsonFromProjectRoot(projectDir, id)
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return errtrace.Wrap(err)
	}
	data, err := json.MarshalIndent(status, "", "  ")
	if err != nil {
		return errtrace.Wrap(err)
	}
	return errtrace.Wrap(os.WriteFile(path, data, 0644))
}
