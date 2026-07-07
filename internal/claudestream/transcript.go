package claudestream

import (
	"bytes"
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

// TailTranscript reads (up to) the last maxBytes of a session transcript and
// returns the conversation lines to backfill - user/assistant entries, minus
// sub-agent sidechains - plus the uuid set of EVERY entry seen. The uuid set
// (not just the relayed lines') is what the caller uses to dedup the
// scrollback-ring replay that follows: a ring line whose uuid appears in the
// transcript was either just relayed or deliberately filtered, and must not
// be replayed again either way.
func TailTranscript(path string, maxBytes int64) (lines [][]byte, uuids map[string]struct{}, err error) {
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
		if ev.IsSidechain || (ev.Type != "user" && ev.Type != "assistant") {
			continue
		}
		cp := make([]byte, len(line))
		copy(cp, line)
		lines = append(lines, cp)
	}
	return lines, uuids, nil
}
