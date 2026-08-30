package chat

import (
	"encoding/json"
	"strings"

	"github.com/trolleyman/hydra/internal/claudestream"
	"github.com/trolleyman/hydra/internal/paths"
)

// Reading the agent's working directory instead of guessing at it.
//
// The Bash tool runs ONE shell for a whole session, so `cd web && bun test` in
// step 3 is still in force at step 40 - and a later bare `bun test` is only
// legible if the chat can say where it ran. The CLI records that directory on
// every transcript line, and the one on a tool RESULT is exactly where the shell
// was left. It prints none of it on the stdout stream-json the chat is built
// from (verified across every stored head: not one `"cwd"`), so the client used
// to reconstruct it by walking the `cd`s itself.
//
// That walk cannot be right in a client. History is PAGED - the newest hundred
// events on open, older pages as you scroll - so the walk restarts at the
// worktree part-way through a session and captions a command that really ran in
// web/ as running at the root. It is also blind to anything that happens outside
// a command: a resume replaces the process, and the shell with it.
//
// So the daemon reads the directory instead. Each tool result's recorded cwd
// becomes a shell_cwd event keyed by the tool_use id, which the client applies
// to that card - and the walk stays only as the fallback for logs recorded
// before this, and for providers with no transcript to read.
//
// Two things make this cheap enough to do inline on the ingest path. The read is
// bounded by a durable byte offset (kept with the plan and the history import's
// own offset, in the store's projection - see Store.ImportOffset), so it only
// ever costs the lines the CLI appended since the last look. And it runs only
// when a Bash call is outstanding, so a head that never shells out never reads
// anything.

// shellCwdOffsetSource keys this tail's byte offset in the projection. Distinct
// from the history import's key for the same file: the two walk it for different
// reasons and at different rates.
func shellCwdOffsetSource(transcript string) string { return "claude:cwd:" + transcript }

// toolResultCwd reads a transcript line's (tool_use id, cwd) pair, if it is a
// tool result that recorded one. The cwd sits on the ENTRY, not in the result
// block, and only a result entry's copy is trustworthy - on the assistant entry
// carrying the tool_use it is stamped at flush time and can land either side of
// the call.
func toolResultCwd(line []byte) (toolUseID, cwd string) {
	var entry struct {
		Type    string `json:"type"`
		Cwd     string `json:"cwd"`
		Message struct {
			Content []struct {
				Type      string `json:"type"`
				ToolUseID string `json:"tool_use_id"`
			} `json:"content"`
		} `json:"message"`
	}
	if json.Unmarshal(line, &entry) != nil || entry.Type != "user" || entry.Cwd == "" {
		return "", ""
	}
	// One result per entry is the shape Claude writes; a batched entry has no
	// way to say which cwd belongs to which call, so take none.
	found := ""
	for _, block := range entry.Message.Content {
		if block.Type != "tool_result" || block.ToolUseID == "" {
			continue
		}
		if found != "" {
			return "", ""
		}
		found = block.ToolUseID
	}
	if found == "" {
		return "", ""
	}
	return found, strings.TrimSpace(entry.Cwd)
}

// syncShellCwds catches the durable log up with what the CLI has written to its
// transcript since the last look, one shell_cwd event per tool result that
// recorded a directory. Idempotent: the offset only advances over complete
// lines, and AppendSource dedups by tool_use id, so calling it twice for the
// same command is free.
//
// Deliberately called at both ends of a Bash call. On the result, because that
// is when the answer is wanted and the line is usually already flushed; on the
// next call's START, because by then it certainly is - the agent only issues the
// next command after reading the last one's output.
func (w *worker) syncShellCwds() {
	if len(w.pendingBash) == 0 || w.ctx.AgentType != "claude" {
		return
	}
	transcript := claudestream.LatestTranscript(paths.ClaudeProjectDir(w.ctx.WorkingDirectory()))
	if transcript == "" {
		return
	}
	source := shellCwdOffsetSource(transcript)
	offset := w.store.ImportOffset(source)
	lines, next, err := claudestream.TranscriptLinesAfter(transcript, offset)
	if err != nil {
		return
	}
	for _, line := range lines {
		toolUseID, cwd := toolResultCwd(line)
		if toolUseID == "" {
			continue
		}
		// Results for the OTHER tools go by in the same file; only a Bash call
		// has a shell whose directory outlives it.
		if _, waiting := w.pendingBash[toolUseID]; !waiting {
			continue
		}
		delete(w.pendingBash, toolUseID)
		event := ShellCwd{}
		event.ToolUseId, event.Cwd = toolUseID, cwd
		_, _, _ = w.store.AppendSource("claude:cwd:"+toolUseID, event)
	}
	if next != offset {
		_ = w.store.SetImportOffset(source, next)
	}
}

// noteBashCall records a Bash tool_use id as outstanding, so the tail knows
// there is something to look for (and which results are worth an event).
// Bounded: a call whose result never lands - the process was killed mid-command
// - would otherwise sit in the map for the life of the head.
func (w *worker) noteBashCall(spec eventSpec) {
	started, ok := spec.payload.(*ToolStarted)
	if !ok || started.Name != "Bash" || started.Id == "" {
		return
	}
	// A sub-agent's Bash call is recorded in its OWN sidecar transcript, not the
	// one this tail reads, so holding its id would only ever fill the map.
	if started.Sidechain {
		return
	}
	if w.pendingBash == nil {
		w.pendingBash = map[string]struct{}{}
	}
	if len(w.pendingBash) >= maxPendingBash {
		clear(w.pendingBash)
	}
	w.pendingBash[started.Id] = struct{}{}
}

// maxPendingBash caps the outstanding-call map. Reached only when results stop
// arriving at all, at which point which ids are held no longer matters.
const maxPendingBash = 256
