package claudestream

import (
	"bytes"
	"io"
	"os"
	"path/filepath"

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
