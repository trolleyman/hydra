// Package reviewstore holds the per-head review state the diff viewer renders:
// the last forge threads read for a head (a cache, so a forge outage or an
// unauthenticated CLI still shows the conversation) and Hydra's LOCAL-ONLY notes
// on those threads.
//
// A local note never reaches the forge. It exists so an agent can answer a
// reviewer where the user can see it - the agent has no forge credentials by
// design, and Hydra writing to a PR as the user is always an explicit user
// action - and so the user can leave themselves a note on a thread. The UI marks
// them as private; see docs/review-threads.md.
package reviewstore

import (
	"encoding/json"
	"os"
	"time"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/forge"
	"github.com/trolleyman/hydra/internal/paths"
)

// AuthorAgent is the author recorded for a note the head's agent wrote (the UI
// labels it with the agent, not the user). Anything else is the user.
const AuthorAgent = "agent"

// LocalNote is one Hydra-only reply on a forge thread.
type LocalNote struct {
	ID        string `json:"id"`
	ThreadID  string `json:"thread_id"`
	Author    string `json:"author"`
	Body      string `json:"body"`
	CreatedAt string `json:"created_at"`
}

// threadCache is the on-disk shape of a head's cached forge threads.
type threadCache struct {
	FetchedAt string         `json:"fetched_at"`
	Threads   []forge.Thread `json:"threads"`
}

// SaveThreads caches a head's freshly-read forge threads. Best-effort by
// construction: the cache is only ever a fallback for a failed live read.
func SaveThreads(projectRoot, id string, threads []forge.Thread) error {
	data, err := json.Marshal(threadCache{FetchedAt: time.Now().Format(time.RFC3339), Threads: threads})
	if err != nil {
		return errtrace.Wrap(err)
	}
	return errtrace.Wrap(writeJSON(paths.GetReviewThreadsJson(projectRoot, id), data))
}

// LoadThreads returns a head's cached threads and when they were read. A missing
// cache is not an error (no threads, no timestamp).
func LoadThreads(projectRoot, id string) ([]forge.Thread, string) {
	data, err := os.ReadFile(paths.GetReviewThreadsJson(projectRoot, id))
	if err != nil {
		return nil, ""
	}
	var c threadCache
	if err := json.Unmarshal(data, &c); err != nil {
		return nil, ""
	}
	return c.Threads, c.FetchedAt
}

// LoadNotes returns a head's local-only notes, oldest first.
func LoadNotes(projectRoot, id string) []LocalNote {
	data, err := os.ReadFile(paths.GetReviewNotesJson(projectRoot, id))
	if err != nil {
		return nil
	}
	var notes []LocalNote
	if err := json.Unmarshal(data, &notes); err != nil {
		return nil
	}
	return notes
}

// AppendNote adds a local note to a head, stamping its id and time. Returns the
// stored note.
func AppendNote(projectRoot, id string, n LocalNote) (LocalNote, error) {
	now := time.Now()
	if n.CreatedAt == "" {
		n.CreatedAt = now.Format(time.RFC3339)
	}
	if n.ID == "" {
		// Nanosecond stamps also sort the notes, which is all the ordering a
		// single-writer append-only list needs.
		n.ID = "local-" + now.Format("20060102150405.000000000")
	}
	notes := append(LoadNotes(projectRoot, id), n)
	data, err := json.Marshal(notes)
	if err != nil {
		return LocalNote{}, errtrace.Wrap(err)
	}
	return n, errtrace.Wrap(writeJSON(paths.GetReviewNotesJson(projectRoot, id), data))
}

// writeJSON writes data to path, creating the parent dir (and keeping it out of
// git like the rest of .hydra/local).
func writeJSON(path string, data []byte) error {
	if err := paths.EnsureHydraLocalIgnored(dirOf(path)); err != nil {
		return errtrace.Wrap(err)
	}
	return errtrace.Wrap(os.WriteFile(path, data, 0644))
}

func dirOf(path string) string {
	for i := len(path) - 1; i >= 0; i-- {
		if path[i] == '/' {
			return path[:i]
		}
	}
	return "."
}
