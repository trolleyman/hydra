package heads

import (
	"encoding/json"
	"log"
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

// RemoveAgentStatusFiles removes a head's per-type state files: the status JSON,
// status log, build log, review file, sub-agents dir, and any unsent chat queue.
func RemoveAgentStatusFiles(projectRoot, id string) {
	removeState := func(what, path string) {
		if _, err := os.Stat(path); err != nil {
			return // absent - nothing to remove
		}
		if err := os.RemoveAll(path); err != nil {
			log.Printf("warn: heads: remove %s %s failed for %s: %v", what, path, id, err)
		}
	}
	removeState("status json", paths.GetStatusJsonFromProjectRoot(projectRoot, id))
	removeState("status log", paths.GetStatusLogFromProjectRoot(projectRoot, id))
	removeState("build log", paths.GetBuildLogFromProjectRoot(projectRoot, id))
	removeState("review json", paths.GetReviewJsonFromProjectRoot(projectRoot, id))
	removeState("subagents dir", paths.GetSubagentsDirFromProjectRoot(projectRoot, id))
	removeState("chat queue", paths.GetChatQueueJsonFromProjectRoot(projectRoot, id))
}
