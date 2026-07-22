package heads

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"time"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/db"
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

// MarkPromptSubmitted records the provider-neutral lifecycle edge that a user
// submitted a terminal prompt. Claude/Gemini hooks report the same transition,
// but Codex has no equivalent hook in terminal mode; recording it at the PTY
// boundary prevents a working head remaining durably labelled "waiting".
func MarkPromptSubmitted(store *db.Store, projectRoot, id string) error {
	ts := time.Now().Format(time.RFC3339Nano)
	event := "prompt_submit"
	info := &api.AgentStatusInfo{Status: api.Running, Event: &event, Timestamp: ts}
	if err := WriteAgentStatus(projectRoot, id, info); err != nil {
		return errtrace.Wrap(err)
	}
	if store != nil {
		if err := store.UpdateAgentStatus(id, string(api.Running), ts, false); err != nil {
			return errtrace.Wrap(err)
		}
	}
	return nil
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
// status log, build log, review file, sub-agents dir, approvals dir (parked
// requests + session host grants, which must not leak to a future head reusing
// the ID), and any unsent chat queue.
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
	removeState("approvals dir", paths.GetApprovalsDirFromProjectRoot(projectRoot, id))
	removeState("chat queue", paths.GetChatQueueJsonFromProjectRoot(projectRoot, id))
	removeState("chat events", paths.GetChatEventsJSONLFromProjectRoot(projectRoot, id))
	removeState("chat state", paths.GetChatStateJSONFromProjectRoot(projectRoot, id))
}
