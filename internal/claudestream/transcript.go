package claudestream

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"braces.dev/errtrace"
)

// DefaultBackfillBytes bounds how much of a transcript tail is read for chat
// backfill. Generous - a transcript line is typically well under 4KB - while
// keeping a pathological multi-hundred-MB transcript from stalling an attach.
const DefaultBackfillBytes = 4 * 1024 * 1024

// LatestTranscript returns the newest session .jsonl in a Claude project
// directory ("" when the directory or any transcript is absent). Claude Code
// appends resumed turns to the same session file (spike-verified), so the
// newest file holds the head's full conversation.
func LatestTranscript(claudeProjectDir string) string {
	entries, err := os.ReadDir(claudeProjectDir)
	if err != nil {
		return ""
	}
	newest := ""
	var newestMod int64
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".jsonl" {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		if m := info.ModTime().UnixNano(); newest == "" || m > newestMod {
			newest, newestMod = filepath.Join(claudeProjectDir, e.Name()), m
		}
	}
	return newest
}

// LatestSessionID returns the session id (transcript basename) of the newest
// non-sidechain session in a Claude project directory, or "" when none is
// found. Used to resume a head by explicit id: the interactive TUI's
// --continue ignores conversations recorded by -p/stream-json runs
// (spike-verified "No conversation found to continue"), so a head toggled
// from chat mode back to terminal mode must be resumed with --resume <id> -
// which loads them fine. Newest-first by mtime; a file whose first line is a
// sub-agent sidechain entry is skipped so a freshly-written Task-tool
// transcript can't hijack the resume.
func LatestSessionID(claudeProjectDir string) string {
	entries, err := os.ReadDir(claudeProjectDir)
	if err != nil {
		return ""
	}
	type candidate struct {
		name string
		mod  int64
	}
	var candidates []candidate
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".jsonl" {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		candidates = append(candidates, candidate{e.Name(), info.ModTime().UnixNano()})
	}
	sort.Slice(candidates, func(i, j int) bool { return candidates[i].mod > candidates[j].mod })
	for _, c := range candidates {
		if firstLineIsSidechain(filepath.Join(claudeProjectDir, c.name)) {
			continue
		}
		return strings.TrimSuffix(c.name, ".jsonl")
	}
	return ""
}

// firstLineIsSidechain peeks a transcript's first parseable line and reports
// whether it belongs to a sub-agent sidechain. Read errors report false: an
// unreadable file shouldn't disqualify itself here, the resume just behaves
// as before.
func firstLineIsSidechain(path string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	buf := make([]byte, 64*1024)
	n, _ := f.Read(buf)
	for line := range bytes.SplitSeq(buf[:n], []byte{'\n'}) {
		if ev, ok := ParseEvent(line); ok {
			return ev.IsSidechain
		}
	}
	return false
}

// SubagentMeta is the sidecar Claude Code writes next to each sub-agent
// transcript (agent-<id>.meta.json), linking the sub-agent to the Task tool_use
// that spawned it. The chat client uses ToolUseID to fold the sub-agent's
// activity into that Task card and AgentType/Description to label it.
type SubagentMeta struct {
	AgentType   string `json:"agentType"`
	Description string `json:"description"`
	ToolUseID   string `json:"toolUseId"`
}

// subagentsSubdir is the per-session directory Claude Code writes sub-agent
// (Task tool) transcripts and their meta sidecars into, alongside the main
// session .jsonl (i.e. <claudeProjectDir>/<sessionID>/subagents/).
func subagentsSubdir(claudeProjectDir, sessionID string) string {
	return filepath.Join(claudeProjectDir, sessionID, "subagents")
}

// ReadSubagentMeta reads the meta sidecar for one sub-agent, or (nil, false)
// when it is absent (a sub-agent whose meta hasn't been flushed yet) or
// unparseable. sessionID is the main transcript basename (without .jsonl).
func ReadSubagentMeta(claudeProjectDir, sessionID, agentID string) (*SubagentMeta, bool) {
	path := filepath.Join(subagentsSubdir(claudeProjectDir, sessionID), "agent-"+agentID+".meta.json")
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, false
	}
	var m SubagentMeta
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, false
	}
	return &m, true
}

// SubagentTranscript pairs a sub-agent's id with the lines of its transcript.
type SubagentTranscript struct {
	AgentID string
	Meta    *SubagentMeta
	Lines   [][]byte
}

// TailSubagentTranscripts reads every sub-agent transcript recorded for one
// session (the newest main transcript's siblings under subagents/), returning
// each sub-agent's relayable lines plus the union of all their entry uuids (for
// ring-replay dedup, exactly like TailTranscript). Only user/assistant lines
// are relayed; the sub-agent's low-level attachment/system entries are dropped.
// Best-effort: a missing subagents/ dir returns nothing.
func TailSubagentTranscripts(claudeProjectDir, sessionID string, maxBytes int64) (subs []SubagentTranscript, uuids map[string]struct{}) {
	uuids = make(map[string]struct{})
	dir := subagentsSubdir(claudeProjectDir, sessionID)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, uuids
	}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasPrefix(name, "agent-") || filepath.Ext(name) != ".jsonl" {
			continue
		}
		agentID := strings.TrimSuffix(strings.TrimPrefix(name, "agent-"), ".jsonl")
		lines, lineUUIDs, err := tailTranscript(filepath.Join(dir, name), maxBytes, true)
		if err != nil {
			continue
		}
		for u := range lineUUIDs {
			uuids[u] = struct{}{}
		}
		meta, _ := ReadSubagentMeta(claudeProjectDir, sessionID, agentID)
		subs = append(subs, SubagentTranscript{AgentID: agentID, Meta: meta, Lines: lines})
	}
	return subs, uuids
}

// SubagentGrowth is one Poll's worth of new relayable lines from one
// sub-agent's transcript (user/assistant lines appended since the last Poll).
type SubagentGrowth struct {
	AgentID   string
	SessionID string
	Lines     [][]byte
}

// SubagentTailer incrementally reads sub-agent transcript growth for a Claude
// project directory. Current CLIs (2.1.x) do NOT relay a sub-agent's inner
// steps on the main process stdout - they exist only in the per-session
// subagents/agent-*.jsonl files, appended live - so the chat socket tails
// those files to stream sub-agent activity while it runs. Each Poll scans the
// newest session's subagents/ dir and returns the complete lines each file
// gained since the previous Poll (a trailing partial line stays buffered in
// the file until its newline arrives). A file first seen is read from its
// start (capped like backfill), so Poll overlaps the attach-time backfill;
// the caller dedups by uuid, exactly like the ring replay.
type SubagentTailer struct {
	claudeProjectDir string
	maxBytes         int64
	// offsets tracks consumed bytes per transcript path (absolute), so a
	// session change mid-connection just starts tracking the new dir's files.
	offsets map[string]int64
}

// NewSubagentTailer tails the sub-agent transcripts of whatever session is
// newest in claudeProjectDir. maxBytes caps how much of a file first seen is
// read (0 = unlimited), mirroring the backfill cap.
func NewSubagentTailer(claudeProjectDir string, maxBytes int64) *SubagentTailer {
	return &SubagentTailer{claudeProjectDir: claudeProjectDir, maxBytes: maxBytes, offsets: map[string]int64{}}
}

// Poll returns the relayable growth of every sub-agent transcript of the
// newest session since the last Poll. Best-effort: no session or no
// subagents/ dir returns nil, unreadable files are skipped (retried next
// Poll, offsets unchanged on error).
func (t *SubagentTailer) Poll() []SubagentGrowth {
	transcript := LatestTranscript(t.claudeProjectDir)
	if transcript == "" {
		return nil
	}
	sessionID := strings.TrimSuffix(filepath.Base(transcript), ".jsonl")
	dir := subagentsSubdir(t.claudeProjectDir, sessionID)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var growth []SubagentGrowth
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasPrefix(name, "agent-") || filepath.Ext(name) != ".jsonl" {
			continue
		}
		path := filepath.Join(dir, name)
		lines, ok := t.pollFile(path)
		if !ok || len(lines) == 0 {
			continue
		}
		agentID := strings.TrimSuffix(strings.TrimPrefix(name, "agent-"), ".jsonl")
		growth = append(growth, SubagentGrowth{AgentID: agentID, SessionID: sessionID, Lines: lines})
	}
	return growth
}

// pollFile reads path's complete new lines since the recorded offset,
// advancing the offset past them (a trailing partial line is left for the
// next Poll). First sight of a large file seeks like tailTranscript and drops
// the fragment before the first newline.
func (t *SubagentTailer) pollFile(path string) (lines [][]byte, ok bool) {
	f, err := os.Open(path)
	if err != nil {
		return nil, false
	}
	defer f.Close()
	offset, seen := t.offsets[path]
	if !seen && t.maxBytes > 0 {
		if info, err := f.Stat(); err == nil && info.Size() > t.maxBytes {
			offset = info.Size() - t.maxBytes
		}
	}
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return nil, false
	}
	data, err := io.ReadAll(f)
	if err != nil {
		return nil, false
	}
	consumed := int64(0)
	if !seen && offset > 0 {
		// The seek landed mid-line; drop the fragment before the first newline.
		if idx := bytes.IndexByte(data, '\n'); idx >= 0 {
			consumed = int64(idx + 1)
			data = data[idx+1:]
		} else {
			t.offsets[path] = offset
			return nil, true
		}
	}
	// Cut at the last newline: everything after it is a partial line still
	// being written, left unconsumed for the next Poll.
	end := bytes.LastIndexByte(data, '\n')
	if end < 0 {
		t.offsets[path] = offset + consumed
		return nil, true
	}
	consumed += int64(end + 1)
	for line := range bytes.SplitSeq(data[:end], []byte{'\n'}) {
		ev, evOK := ParseEvent(line)
		if !evOK || (ev.Type != "user" && ev.Type != "assistant") {
			continue
		}
		cp := make([]byte, len(line))
		copy(cp, line)
		lines = append(lines, cp)
	}
	t.offsets[path] = offset + consumed
	return lines, true
}

// HistoryBatchBytes is how much older conversation one load-older request pulls.
const HistoryBatchBytes = 512 * 1024

// HistoryBefore returns the batch of conversation lines (user/assistant, minus
// sub-agent sidechains) immediately older than the line carrying beforeUUID -
// the "load older" page for the chat view's infinite scroll. Lines are returned
// oldest-first (ready to prepend). done is true once the batch reaches the start
// of the transcript (or nothing older exists), so the client can stop asking.
// A missing/anchorless transcript yields an empty, done result.
func HistoryBefore(path, beforeUUID string, maxBytes int64) (lines [][]byte, done bool, err error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, true, errtrace.Wrap(err)
	}
	all := bytes.Split(data, []byte{'\n'})
	// Locate the anchor (the client's current oldest line).
	anchor := -1
	for i, line := range all {
		if ev, ok := ParseEvent(line); ok && ev.UUID != "" && ev.UUID == beforeUUID {
			anchor = i
			break
		}
	}
	if anchor <= 0 {
		return nil, true, nil // not found, or already at the first line
	}
	// Walk backward from just before the anchor, collecting conversation lines
	// (newest-first) until the byte budget, then reverse to oldest-first.
	var batch [][]byte
	var used int64
	i := anchor - 1
	for ; i >= 0; i-- {
		ev, ok := ParseEvent(all[i])
		if !ok || ev.IsSidechain || (ev.Type != "user" && ev.Type != "assistant") {
			continue
		}
		cp := make([]byte, len(all[i]))
		copy(cp, all[i])
		batch = append(batch, cp)
		used += int64(len(cp))
		if used >= maxBytes {
			break
		}
	}
	for l, r := 0, len(batch)-1; l < r; l, r = l+1, r-1 {
		batch[l], batch[r] = batch[r], batch[l]
	}
	// done when we reached the start, or found nothing more to give (so the
	// client doesn't loop forever on an unchanged anchor).
	return batch, i < 0 || len(batch) == 0, nil
}

// TailTranscript reads (up to) the last maxBytes of a session transcript and
// returns the conversation lines to backfill - user/assistant entries, minus
// sub-agent sidechains - plus the uuid set of EVERY entry seen. The uuid set
// (not just the relayed lines') is what the caller uses to dedup the
// scrollback-ring replay that follows: a ring line whose uuid appears in the
// transcript was either just relayed or deliberately filtered, and must not
// be replayed again either way.
func TailTranscript(path string, maxBytes int64) (lines [][]byte, uuids map[string]struct{}, err error) {
	return errtrace.Wrap3(tailTranscript(path, maxBytes, false))
}

// tailTranscript is the shared core of TailTranscript. keepSidechain relays
// sub-agent sidechain user/assistant lines instead of dropping them - the
// main-transcript backfill drops them (main conversation only), but a sub-agent
// transcript IS entirely sidechain, so its own backfill keeps them.
func tailTranscript(path string, maxBytes int64, keepSidechain bool) (lines [][]byte, uuids map[string]struct{}, err error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, nil, errtrace.Wrap(err)
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		return nil, nil, errtrace.Wrap(err)
	}
	truncated := false
	if maxBytes > 0 && info.Size() > maxBytes {
		if _, err := f.Seek(info.Size()-maxBytes, io.SeekStart); err != nil {
			return nil, nil, errtrace.Wrap(err)
		}
		truncated = true
	}
	data, err := io.ReadAll(f)
	if err != nil {
		return nil, nil, errtrace.Wrap(err)
	}
	if truncated {
		// The seek landed mid-line; drop the fragment before the first newline.
		if idx := bytes.IndexByte(data, '\n'); idx >= 0 {
			data = data[idx+1:]
		} else {
			data = nil
		}
	}

	uuids = make(map[string]struct{})
	for line := range bytes.SplitSeq(data, []byte{'\n'}) {
		ev, ok := ParseEvent(line)
		if !ok {
			continue
		}
		if ev.UUID != "" {
			uuids[ev.UUID] = struct{}{}
		}
		if (ev.IsSidechain && !keepSidechain) || (ev.Type != "user" && ev.Type != "assistant") {
			continue
		}
		cp := make([]byte, len(line))
		copy(cp, line)
		lines = append(lines, cp)
	}
	return lines, uuids, nil
}
