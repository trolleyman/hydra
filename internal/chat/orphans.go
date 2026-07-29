package chat

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"braces.dev/errtrace"
)

// The orphaned-turn problem
//
// A chat head's CLI can die mid-turn - the process is killed, the turn is
// rejected and the run ends, the daemon restarts under it. Whatever it had
// already streamed by then is in OUR normalized log, because we wrote each
// block the moment it arrived and the browser rendered it live. It is NOT in
// the CLI's own transcript: the transcript is the CLI's durable record, and a
// request that never finished leaves nothing behind in it.
//
// So when the head is resumed, the CLI restores the conversation from the
// transcript - which has no memory of the dead attempt - and re-runs the turn.
// It re-thinks and usually re-says almost exactly the same thing, under fresh
// uuids. Our log now holds both copies, and since the log is the durable record
// the browser reads, the duplicate is permanent: it survives reload, it is in
// every backfill, and it reads as the agent having said the same sentence twice
// in a row for no reason.
//
// The transcript is the arbiter. A block that WE recorded but the CLI never
// committed is, by definition, output from an attempt that no longer exists in
// the conversation - so it should not be in the conversation we show either.
// Correlating the two is possible because a stdout event and its transcript
// line carry the same uuid (see claudestream.Event.UUID).
//
// The retraction is expressed as a `messages_retracted` event appended to the
// log, which is the SAME mechanism the CLI's own safety-retry uses when it
// re-emits flagged blocks under new uuids - so the browser already knows how to
// evict them, live and on replay, and no new client concept is needed.

// retractableTypes are the normalized event types that produce a rendered
// message bubble carrying a uuid, and are therefore worth retracting. Tool
// calls are deliberately absent: a tool that ran had real side effects on the
// worktree, and its card is an honest record of that even if the turn it
// belonged to was thrown away.
var retractableTypes = map[string]bool{
	"assistant_message":   true,
	"reasoning_completed": true,
}

// turnBoundaryTypes end the backwards scan: everything we consider retracting
// has to belong to the ONE turn that was interrupted. A user message (or the
// previous retraction) is where that turn began.
var turnBoundaryTypes = map[string]bool{
	"user_message":        true,
	"user_message_echoed": true,
	"messages_retracted":  true,
}

// OrphanedUUIDs returns the uuids of blocks in the tail of the head's log that
// the CLI's transcript has no record of - i.e. output from an attempt that died
// before the CLI committed it.
//
// It scans BACKWARDS only to the start of the last turn. Anything older has
// been through at least one completed turn and is not in question, and bounding
// the scan means a long conversation costs the same as a short one. An empty
// result (the normal case, including a clean resume between turns) means there
// is nothing to do.
//
// transcriptDir is the head's ~/.claude/projects/<slug> directory. If it can't
// be read, the result is empty: with no arbiter available we retract NOTHING,
// because wrongly deleting a real message is far worse than leaving a duplicate.
func OrphanedUUIDs(events []Event, transcriptDir string) []string {
	candidates := lastTurnUUIDs(events)
	if len(candidates) == 0 {
		return nil
	}
	committed, err := transcriptUUIDs(transcriptDir)
	// A missing/unreadable transcript, or one we found no uuids in at all, is not
	// evidence that the blocks are orphans - it is an absence of evidence. Bail.
	if err != nil || len(committed) == 0 {
		return nil
	}
	var orphans []string
	for _, u := range candidates {
		if !committed[u] {
			orphans = append(orphans, u)
		}
	}
	return orphans
}

// lastTurnUUIDs collects the uuids of retractable blocks back to the start of
// the current turn, returned oldest-first.
func lastTurnUUIDs(events []Event) []string {
	var out []string
	for _, ev := range slices.Backward(events) {
		if turnBoundaryTypes[ev.Type] {
			break
		}
		if !retractableTypes[ev.Type] {
			continue
		}
		if u := payloadUUID(ev.Payload); u != "" {
			out = append(out, u)
		}
	}
	// Reverse into log order so the retraction reads oldest-first.
	for l, r := 0, len(out)-1; l < r; l, r = l+1, r-1 {
		out[l], out[r] = out[r], out[l]
	}
	return out
}

// payloadUUID pulls the uuid a normalized assistant/reasoning event carries.
func payloadUUID(payload json.RawMessage) string {
	if len(payload) == 0 {
		return ""
	}
	var p struct {
		UUID string `json:"uuid"`
	}
	if json.Unmarshal(payload, &p) != nil {
		return ""
	}
	return p.UUID
}

// transcriptUUIDs reads every uuid the CLI has committed for this worktree.
//
// It reads ALL transcripts in the directory, not just the newest: a resumed
// session can continue into a new file, and reading one file too many can only
// ever make us retract LESS (a uuid found anywhere counts as committed), which
// is the safe direction to be wrong in.
func transcriptUUIDs(dir string) (map[string]bool, error) {
	if dir == "" {
		return nil, errtrace.Wrap(os.ErrNotExist)
	}
	paths, err := filepath.Glob(filepath.Join(dir, "*.jsonl"))
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	out := map[string]bool{}
	for _, p := range paths {
		if err := scanTranscriptUUIDs(p, out); err != nil {
			return nil, errtrace.Wrap(err)
		}
	}
	return out, nil
}

func scanTranscriptUUIDs(path string, into map[string]bool) error {
	f, err := os.Open(path)
	if err != nil {
		return errtrace.Wrap(err)
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	// Transcript lines carry whole tool outputs and file contents, so the default
	// 64KB line cap is nowhere near enough - a truncated line would decode to no
	// uuid and read as "not committed", which is exactly the false positive that
	// would delete a real message.
	sc.Buffer(make([]byte, 0, 1<<20), 64<<20)
	for sc.Scan() {
		line := sc.Bytes()
		// Cheap pre-filter: skip a line with no uuid field at all rather than
		// decoding megabytes of tool output as JSON.
		if !strings.Contains(string(line), `"uuid"`) {
			continue
		}
		var e struct {
			UUID string `json:"uuid"`
		}
		if json.Unmarshal(line, &e) == nil && e.UUID != "" {
			into[e.UUID] = true
		}
	}
	return errtrace.Wrap(sc.Err())
}
