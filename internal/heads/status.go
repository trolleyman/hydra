package heads

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/db"
	"github.com/trolleyman/hydra/internal/gate"
	"github.com/trolleyman/hydra/internal/paths"
)

// ReadAgentStatus reads the agent hook status from the <projectId>/.hydra/status/<id>.json
// file. Returns nil if the file doesn't exist or is invalid.
func ReadAgentStatus(projectDir, id string) *api.AgentStatusInfo {
	path := paths.GetStatusJsonFromProjectRoot(projectDir, id)
	data := readStatusJSONBytes(path)
	if data == nil {
		return nil
	}
	var s api.AgentStatusInfo
	if err := json.Unmarshal(data, &s); err != nil {
		return nil
	}
	return &s
}

// readStatusJSONBytes reads a status.json, retrying briefly on an apparent torn
// read (missing/empty/invalid JSON). status.json is written in place (os.WriteFile,
// truncate+write) by both the in-sandbox trigger-hook and the daemon-side
// WriteAgentStatus - deliberately, so the host and the sandbox's file-level bind
// mount keep sharing one inode (an atomic temp+rename would orphan the bind). The
// cost is a brief truncate window a concurrent reader can catch; such a read is
// rare and self-heals within microseconds, so a few short retries make it
// invisible. Returns nil if it never reads valid JSON.
func readStatusJSONBytes(path string) []byte {
	for attempt := 0; ; attempt++ {
		data, err := os.ReadFile(path)
		if err == nil && json.Valid(data) {
			return data
		}
		if attempt >= 3 {
			return nil
		}
		time.Sleep(2 * time.Millisecond)
	}
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
	// Deliberately an in-place os.WriteFile (truncate+write), NOT an atomic
	// temp+rename: status.json is bind-mounted into the head's sandbox at the file
	// level (sandbox.linux.go `--bind p p`), and the in-sandbox trigger-hook writes
	// the same file in place. A rename would swap the host inode and orphan the
	// sandbox's bind mount (host and sandbox would then see different inodes), so
	// this must keep the same inode. The brief truncate window a concurrent reader
	// could catch is absorbed by readStatusJSONBytes, which retries a torn read.
	return errtrace.Wrap(os.WriteFile(path, data, 0644))
}

// pendingApprovalStatus derives the user-visible wait from the approval request
// files themselves. Those files are the authoritative state of a parked call:
// provider hooks may concurrently rewrite status.json to "running" after the
// daemon or gate wrote policy_approval (Codex runs its PreToolUse status hook
// late enough to hit this race). The request remains pending, so hiding the card
// because of that lossy status side channel leaves the connection parked with no
// way for the user to answer it.
func pendingApprovalStatus(projectRoot, id string) *api.AgentStatusInfo {
	reqs, err := gate.ListRequests(paths.GetApprovalsDirFromProjectRoot(projectRoot, id))
	if err != nil || len(reqs) == 0 {
		return nil
	}
	req := reqs[len(reqs)-1]
	nt := gate.NotificationPolicyApproval
	msg := req.Summary
	event := "policy_approval"
	return &api.AgentStatusInfo{
		Status:           api.NeedsInput,
		Event:            &event,
		Timestamp:        req.TS,
		LastMessage:      &msg,
		NotificationType: &nt,
	}
}

// onStateRemoved is notified with the id whose per-head state has just been
// deleted, so anything holding the same state in memory can drop it. The
// daemon's chat manager is the one that matters: it keeps a head's whole event
// log resident (that is what lets it page without touching the disk), and
// deleting the file underneath it tells it nothing.
var (
	stateRemovedMu sync.RWMutex
	onStateRemoved func(id string)
)

// SetOnStateRemoved registers that hook. Set once at daemon startup.
func SetOnStateRemoved(fn func(id string)) {
	stateRemovedMu.Lock()
	defer stateRemovedMu.Unlock()
	onStateRemoved = fn
}

// RemoveAgentRuntimeFiles removes a head's disposable runtime state: the status
// JSON, status log, build log, review file, sub-agents dir, approvals dir
// (parked requests + session host grants, which must not leak to a future head
// reusing the ID), and any unsent chat queue.
//
// It deliberately preserves the normalized chat event log and projection. A
// killed or merged head is archived rather than deleted, and Resume needs that
// durable timeline to show every prior turn after recreating the worktree. Use
// RemoveAgentStatusFiles only for a permanent purge or an aborted fresh spawn.
func RemoveAgentRuntimeFiles(projectRoot, id string) {
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
	removeState("review request dir", paths.GetReviewReqDir(projectRoot, id))
	removeState("agent request dir", paths.GetAgentReqDir(projectRoot, id))
	removeState("review threads cache", paths.GetReviewThreadsJson(projectRoot, id))
	removeState("review notes", paths.GetReviewNotesJson(projectRoot, id))
	removeState("subagents dir", paths.GetSubagentsDirFromProjectRoot(projectRoot, id))
	removeState("approvals dir", paths.GetApprovalsDirFromProjectRoot(projectRoot, id))
	removeState("chat queue", paths.GetChatQueueJsonFromProjectRoot(projectRoot, id))
	// Remove category directories when this was their final head. All of these
	// are recreated lazily on the next write, so empty sidecar scaffolding does
	// not accumulate as heads come and go.
	for _, dir := range []string{
		paths.GetStatusDirFromProjectRoot(projectRoot),
		paths.GetStatusLogDirFromProjectRoot(projectRoot),
		paths.GetBuildLogDirFromProjectRoot(projectRoot),
		paths.GetReviewDirFromProjectRoot(projectRoot),
		paths.GetReviewReqRootDir(projectRoot),
		paths.GetAgentReqRootDir(projectRoot),
		filepath.Dir(paths.GetReviewThreadsJson(projectRoot, id)),
		filepath.Dir(paths.GetReviewNotesJson(projectRoot, id)),
		paths.GetSubagentsBaseDirFromProjectRoot(projectRoot),
		filepath.Dir(paths.GetApprovalsDirFromProjectRoot(projectRoot, id)),
		paths.GetChatQueueDirFromProjectRoot(projectRoot),
	} {
		_ = os.Remove(dir)
	}
}

// RemoveAgentStatusFiles removes all per-head state, including the durable chat
// timeline. It is for permanent deletion and failed fresh spawns only; archiving
// uses RemoveAgentRuntimeFiles so Resume can restore the full conversation.
func RemoveAgentStatusFiles(projectRoot, id string) {
	RemoveAgentRuntimeFiles(projectRoot, id)
	removeState := func(what, path string) {
		if _, err := os.Stat(path); err != nil {
			return
		}
		if err := os.RemoveAll(path); err != nil {
			log.Printf("warn: heads: remove %s %s failed for %s: %v", what, path, id, err)
		}
	}
	removeState("chat events", paths.GetChatEventsJSONLFromProjectRoot(projectRoot, id))
	removeState("chat state", paths.GetChatStateJSONFromProjectRoot(projectRoot, id))
	_ = os.Remove(paths.GetChatEventsDirFromProjectRoot(projectRoot))
	_ = os.Remove(paths.GetChatStateDirFromProjectRoot(projectRoot))
	stateRemovedMu.RLock()
	notify := onStateRemoved
	stateRemovedMu.RUnlock()
	if notify != nil {
		notify(id)
	}
}
