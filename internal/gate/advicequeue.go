package gate

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"

	"braces.dev/errtrace"
)

// Claude delivers a hook's additionalContext from PreToolUse and PostToolUse but
// silently DROPS it from PostToolUseFailure (measured on CLI 2.1.220: the hook
// runs and emits, the model never sees it). That is the one event where advice
// about a command's OUTPUT can be produced - a command that failed - so the
// explanation for a failure was being written into the void. GitReadonlyAdvice is
// the case that matters: a git write blocked by the read-only .git exits non-zero
// by definition, so its "use the mcp__hydra__git_* tools instead" pointer only
// ever landed when the git command was not what set the script's exit status.
//
// The fix is to hold that advice and attach it to the next PreToolUse, which does
// deliver. The queue is a file rather than memory because each hook is a separate
// short-lived process; it lives in the per-head approval dir, the one directory
// the sandbox already makes writable for this purpose.

// adviceTTL bounds how stale a deferred note may be when it is finally flushed.
// The next tool call is normally seconds away, so this only matters when a
// session ends or the user goes quiet mid-task - and an explanation of a failure
// from an hour ago, attached to an unrelated command, is worse than no
// explanation at all.
const adviceTTL = 5 * time.Minute

// adviceQueueMax caps the entries kept, newest first. A run of failures with
// nothing in between to flush them should not grow a file without bound, and old
// entries are the ones worth losing.
const adviceQueueMax = 8

type adviceEntry struct {
	At   int64  `json:"at"`
	Text string `json:"text"`
}

// adviceQueuePath is per SUB-AGENT, not per head: the approval dir is shared with
// a head's sub-agents, and flushing one agent's failure into another's next call
// would attach an explanation to a command it has nothing to do with. Sub-agent
// hooks carry an agent_id and the main agent's do not, so "" is the main agent.
func adviceQueuePath(dir, agentID string) string {
	name := "pending-advice"
	if id := sanitizeAgentID(agentID); id != "" {
		name += "-" + id
	}
	return filepath.Join(dir, name+".jsonl")
}

// sanitizeAgentID keeps only filename-safe characters. agent_ids are hex, so this
// is defensive.
func sanitizeAgentID(id string) string {
	var b strings.Builder
	for _, r := range id {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// QueueAdvice holds a note that its own event cannot deliver, for the next
// PreToolUse to flush. A no-op when the approval dir is unset (the gate is off,
// so no hook is emitting anything anyway).
func QueueAdvice(dir, agentID, text string, now time.Time) error {
	if dir == "" || text == "" {
		return nil
	}
	line, err := json.Marshal(adviceEntry{At: now.Unix(), Text: text})
	if err != nil {
		return errtrace.Wrap(err)
	}
	// O_APPEND so two failures racing (a head and its sub-agent share the dir, even
	// though they use different files) cannot truncate each other's write.
	f, err := os.OpenFile(adviceQueuePath(dir, agentID), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return errtrace.Wrap(err)
	}
	defer f.Close()
	if _, err := f.Write(append(line, '\n')); err != nil {
		return errtrace.Wrap(err)
	}
	return nil
}

// TakeAdvice returns the queued notes oldest-first and clears the queue. Entries
// past adviceTTL are dropped rather than delivered late. Callers must only take
// when they are actually going to emit: a deny path that swallowed the result
// would lose the advice for good, so it should leave the queue alone.
func TakeAdvice(dir, agentID string, now time.Time) []string {
	if dir == "" {
		return nil
	}
	path := adviceQueuePath(dir, agentID)
	data, err := os.ReadFile(path)
	if err != nil {
		return nil // no queue is the normal case
	}
	var entries []adviceEntry
	for line := range strings.SplitSeq(string(data), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var e adviceEntry
		if err := json.Unmarshal([]byte(line), &e); err != nil {
			continue // a torn write is not worth failing the whole flush over
		}
		entries = append(entries, e)
	}
	// Clear unconditionally: an entry we chose not to deliver (too old, unreadable)
	// will not get fresher, and leaving it behind would re-cost the read every call.
	_ = os.Remove(path)

	if len(entries) > adviceQueueMax {
		entries = entries[len(entries)-adviceQueueMax:]
	}
	var out []string
	for _, e := range entries {
		if now.Sub(time.Unix(e.At, 0)) > adviceTTL {
			continue
		}
		out = append(out, e.Text)
	}
	return out
}
