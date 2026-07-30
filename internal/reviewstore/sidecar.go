package reviewstore

// Hydra's overlay on a head's review conversation: the numbering, what has been
// resolved, and what has been read.
//
// All three exist because Hydra owns something about a comment without owning the
// comment. That distinction is the whole design (docs/review-agent.md): people
// write, edit and delete on GitHub directly, and Hydra cannot prevent that and
// should not try. A local copy of forge content declaring itself authoritative
// would be a replica pretending to be a source. So forge CONTENT keeps flowing
// live on every read, and what lives here is only what Hydra itself decides:
//
//   - The NUMBER. One sequence per head across every origin, assigned on first
//     sight, so "fix #3" works whether #3 was left in Hydra or on the PR. A UI
//     with two numbering schemes in one gutter is worse than none.
//   - The RESOLVED flag, for forge threads. Hydra cannot resolve a thread on the
//     forge (see ThreadState), so this is explicitly a local mark.
//   - The READ flag. Who has seen what is not a fact about the comment at all -
//     it is a fact about this Hydra install, and no forge would store it.
//
// One file, one writer. Every write path - the browser over HTTP, agents over
// reviewq, the forge poller - lands in the daemon, so a plain read-modify-write of
// a single JSON file is sound, and the numbering can be assigned in one place.

import (
	"encoding/json"
	"fmt"
	"os"
	"sync"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/paths"
)

// Origin prefixes for a numbering key. Native comments are numbered by the store
// itself and never appear in the key map; only things Hydra did not author need
// an external identity mapped onto a number.
const (
	OriginForge = "forge"
)

// NumberedRef is what a numbering key resolves to: the number handed out, and -
// for a forge note - the thread it belongs to, so a reply by number knows where
// to attach without a second lookup against the live forge.
type NumberedRef struct {
	Number int    `json:"number"`
	Thread string `json:"thread,omitempty"`
}

// ThreadState is Hydra's local overlay on ONE forge thread.
//
// Resolved is deliberately local-only. Resolving on the forge is a write to
// someone else's PR, and the two providers do not make it equally reachable:
// GitHub's resolveReviewThread is a GraphQL mutation keyed by a thread NODE id,
// which Hydra does not fetch (its thread handle is the root comment's id), so a
// "resolve" that silently worked on GitLab and silently did not on GitHub would
// be worse than one that is honestly local everywhere. The UI says so, and the
// forge's own resolved flag still wins when it is set.
type ThreadState struct {
	Resolved   bool   `json:"resolved,omitempty"`
	ResolvedAt string `json:"resolved_at,omitempty"`
}

type sidecar struct {
	// Last number handed out for this head, across every origin. Monotonic:
	// a number is retired the moment it is issued and is never reissued, so "#3"
	// means one thing forever even after the comment it named is deleted.
	Last int `json:"last"`
	// External identity -> number, e.g. "forge:701". Append-only in practice.
	Keys map[string]NumberedRef `json:"keys,omitempty"`
	// Forge thread id -> Hydra's local overlay on it.
	Threads map[string]ThreadState `json:"threads,omitempty"`
	// Numbers the user has seen. A set rather than a watermark because numbers
	// interleave by FIRST SIGHT across origins, so "everything below N" is not a
	// meaningful thing to have read.
	Read map[string]bool `json:"read,omitempty"`
}

// sidecarMu serializes read-modify-write on the file. The daemon is the only
// writer, but it is a concurrent one: a browser GET assigning numbers to freshly
// fetched forge notes can land at the same moment an agent appends a comment.
var sidecarMu sync.Mutex

func sidecarPath(projectRoot, id string) string {
	return paths.GetReviewCommentsJson(projectRoot, id+".meta")
}

func loadSidecar(projectRoot, id string) sidecar {
	sc := sidecar{Keys: map[string]NumberedRef{}, Threads: map[string]ThreadState{}, Read: map[string]bool{}}
	data, err := os.ReadFile(sidecarPath(projectRoot, id))
	if err != nil {
		return sc
	}
	if err := json.Unmarshal(data, &sc); err != nil {
		return sidecar{Keys: map[string]NumberedRef{}, Threads: map[string]ThreadState{}, Read: map[string]bool{}}
	}
	if sc.Keys == nil {
		sc.Keys = map[string]NumberedRef{}
	}
	if sc.Threads == nil {
		sc.Threads = map[string]ThreadState{}
	}
	if sc.Read == nil {
		sc.Read = map[string]bool{}
	}
	return sc
}

func saveSidecar(projectRoot, id string, sc sidecar) error {
	data, err := json.Marshal(sc)
	if err != nil {
		return errtrace.Wrap(err)
	}
	return errtrace.Wrap(writeJSON(sidecarPath(projectRoot, id), data))
}

// update runs fn against the head's sidecar under the lock and persists it.
func update[T any](projectRoot, id string, fn func(sc *sidecar) T) (T, error) {
	sidecarMu.Lock()
	defer sidecarMu.Unlock()
	sc := loadSidecar(projectRoot, id)
	out := fn(&sc)
	return out, errtrace.Wrap(saveSidecar(projectRoot, id, sc))
}

// forgeKey builds the numbering key for a forge note.
func forgeKey(noteID string) string { return OriginForge + ":" + noteID }

// NumberForForgeNote returns the number for a forge note, assigning the next one
// on first sight. Idempotent: the same note always resolves to the same number,
// which is what lets the diff viewer assign numbers on every render without
// burning through the sequence.
//
// Note the ordering consequence, which is deliberate: a forge comment written
// while the daemon was down gets its number on the next fetch, so numbers reflect
// when Hydra FIRST SAW a comment, not when it was written. They are handles, not
// a chronology.
func NumberForForgeNote(projectRoot, id, noteID, threadID string) int {
	if noteID == "" {
		return 0
	}
	n, err := update(projectRoot, id, func(sc *sidecar) int {
		if ref, ok := sc.Keys[forgeKey(noteID)]; ok {
			// Backfill the thread for a key numbered before threads were recorded,
			// so an old number stays repliable.
			if ref.Thread == "" && threadID != "" {
				ref.Thread = threadID
				sc.Keys[forgeKey(noteID)] = ref
			}
			return ref.Number
		}
		sc.Last++
		sc.Keys[forgeKey(noteID)] = NumberedRef{Number: sc.Last, Thread: threadID}
		return sc.Last
	})
	if err != nil {
		return n // the number is still usable in this response; it just may not stick
	}
	return n
}

// allocNumber hands out the next number in the head's single sequence. Used by
// AppendComment for Hydra's own comments; forge notes go through
// NumberForForgeNote, which allocates from this same counter.
func allocNumber(projectRoot, id string) (int, error) {
	return errtrace.Wrap2(update(projectRoot, id, func(sc *sidecar) int {
		sc.Last++
		return sc.Last
	}))
}

// noteHighWater raises the sequence to at least n. It exists for the store's own
// comments, whose numbers are visible in the list itself: if a sidecar is lost or
// a store is copied in, the counter must not start handing out numbers that are
// already in use.
func noteHighWater(projectRoot, id string, n int) {
	_, _ = update(projectRoot, id, func(sc *sidecar) struct{} {
		if n > sc.Last {
			sc.Last = n
		}
		return struct{}{}
	})
}

// ForgeThreads returns the thread handle of every numbered forge note, with
// duplicates left in - one per note, since a thread with three notes appears
// three times. Callers that want threads dedupe; the sidecar deliberately does
// not, because "which threads exist" and "how many notes are in them" are both
// answered from this and only one of them wants a set.
func ForgeThreads(projectRoot, id string) []string {
	sc := loadSidecar(projectRoot, id)
	out := make([]string, 0, len(sc.Keys))
	for _, ref := range sc.Keys {
		out = append(out, ref.Thread)
	}
	return out
}

// ForgeRef resolves a number back to the forge note (and thread) it names.
func ForgeRef(projectRoot, id string, number int) (noteID string, ref NumberedRef, ok bool) {
	sc := loadSidecar(projectRoot, id)
	for key, r := range sc.Keys {
		if r.Number != number {
			continue
		}
		return key[len(OriginForge)+1:], r, true
	}
	return "", NumberedRef{}, false
}

// ThreadResolved reports Hydra's local resolve overlay for a forge thread.
func ThreadResolved(projectRoot, id, threadID string) bool {
	return loadSidecar(projectRoot, id).Threads[threadID].Resolved
}

// SetThreadResolved marks a forge thread resolved (or not) LOCALLY. It never
// reaches the forge - see ThreadState.
func SetThreadResolved(projectRoot, id, threadID string, resolved bool, now string) error {
	_, err := update(projectRoot, id, func(sc *sidecar) struct{} {
		if !resolved {
			delete(sc.Threads, threadID)
			return struct{}{}
		}
		sc.Threads[threadID] = ThreadState{Resolved: true, ResolvedAt: now}
		return struct{}{}
	})
	return errtrace.Wrap(err)
}

// IsRead reports whether a number has been seen by the user.
func IsRead(projectRoot, id string, number int) bool {
	return loadSidecar(projectRoot, id).Read[fmt.Sprint(number)]
}

// ReadSet returns every number the user has seen, for bulk rendering.
func ReadSet(projectRoot, id string) map[int]bool {
	sc := loadSidecar(projectRoot, id)
	out := make(map[int]bool, len(sc.Read))
	for k, v := range sc.Read {
		var n int
		if _, err := fmt.Sscanf(k, "%d", &n); err == nil && v {
			out[n] = true
		}
	}
	return out
}

// MarkRead records that the user has seen these numbers, or - with read=false -
// puts them back to unread, which is how you say "seen it, come back to it".
// Idempotent, and it is the ONLY way read state changes: nothing is read by the
// passage of time.
func MarkRead(projectRoot, id string, numbers []int, read bool) error {
	_, err := update(projectRoot, id, func(sc *sidecar) struct{} {
		for _, n := range numbers {
			if read {
				sc.Read[fmt.Sprint(n)] = true
			} else {
				delete(sc.Read, fmt.Sprint(n))
			}
		}
		return struct{}{}
	})
	return errtrace.Wrap(err)
}

// AllNumbers returns every number handed out to a non-native comment (i.e. the
// forge notes). Used by "mark everything read", which has to cover comments that
// are not in Hydra's own store at all.
func AllNumbers(projectRoot, id string) []int {
	sc := loadSidecar(projectRoot, id)
	out := make([]int, 0, len(sc.Keys))
	for _, ref := range sc.Keys {
		out = append(out, ref.Number)
	}
	return out
}
