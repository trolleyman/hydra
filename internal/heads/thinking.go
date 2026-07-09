package heads

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"

	"github.com/trolleyman/hydra/internal/paths"
)

// Thinking-duration sidecar: a per-head JSON file mapping a Claude assistant
// message id to the wall-clock time Hydra measured that message's thinking
// block taking (see claudestream.RingFilter.OnThinking). The browser can only
// time a thought live in the tab that watched it stream, and Claude's own
// transcript carries no duration field - so without this a reload/resume loses
// the "Thought for Xs" (and empty silently-reasoned thoughts vanish entirely).
// The daemon writes each measurement here as it completes and replays them to
// every (re)attaching client during chat backfill.
//
// thinkingMu serialises the read-modify-write against concurrent completions
// (thoughts finish one per assistant message, dispatched off the read goroutine)
// and against a reader loading the file mid-write. One global lock is ample: the
// writes are small and infrequent.
var thinkingMu sync.Mutex

// thinkingFile is the on-disk shape: message id -> measured duration (ms).
type thinkingFile struct {
	Durations map[string]int64 `json:"durations"`
}

// RecordThinkingDuration merges one measured thinking duration into a head's
// sidecar (keyed by Claude message id), creating the file on first write.
// Best-effort: a read/parse/write error just drops this measurement (the client
// falls back to its transcript-gap estimate), so callers ignore failures.
func RecordThinkingDuration(projectRoot, id, messageID string, durationMS int64) {
	if messageID == "" {
		return
	}
	thinkingMu.Lock()
	defer thinkingMu.Unlock()

	path := paths.GetChatThinkingJsonFromProjectRoot(projectRoot, id)
	durations := readThinkingFile(path)
	if durations[messageID] == durationMS {
		return // unchanged (a re-measure of the same message) - skip the write
	}
	if durations == nil {
		durations = map[string]int64{}
	}
	durations[messageID] = durationMS

	data, err := json.Marshal(thinkingFile{Durations: durations})
	if err != nil {
		return
	}
	// The thinking dir is its own generated dir (.hydra/local/thinking), covered
	// by the .hydra/local top-level gitignore, so a bare MkdirAll suffices.
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return
	}
	_ = paths.WriteFileIfChanged(path, string(data), 0o644)
}

// LoadThinkingDurations reads a head's message-id -> duration map (nil when the
// sidecar is absent or unparseable - the common case for a head that has never
// produced a thought).
func LoadThinkingDurations(projectRoot, id string) map[string]int64 {
	thinkingMu.Lock()
	defer thinkingMu.Unlock()
	return readThinkingFile(paths.GetChatThinkingJsonFromProjectRoot(projectRoot, id))
}

// readThinkingFile parses the sidecar at path. Caller holds thinkingMu. Returns
// nil on any error (missing file, bad JSON).
func readThinkingFile(path string) map[string]int64 {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var f thinkingFile
	if json.Unmarshal(data, &f) != nil {
		return nil
	}
	return f.Durations
}
