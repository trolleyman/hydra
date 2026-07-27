package http

import (
	"encoding/json"
	"net/http/httptest"
	"testing"

	"github.com/trolleyman/hydra/internal/api"
)

// TestSimFullContextDiffsAreContiguous guards the invariant the diff viewer's
// full-content reveal model depends on: when full_context is requested, every
// *expanded* file the sim returns must carry a single contiguous whole-file hunk
// (old and new line numbers each increment by one). If it doesn't, the client
// rejects the file and falls back to rendering the reconstructed hunk
// uncollapsed - a wall of synthetic context lines. The hand-written fixtures
// don't keep a consistent old/new offset across hunks, so simReconstructFull
// must renumber rather than trust their stated numbers. A change deep in a large
// file is intentionally left windowed (not expanded) rather than reconstructed
// into thousands of synthetic lines, so those files are skipped here.
func TestSimFullContextDiffsAreContiguous(t *testing.T) {
	s := &SimulationServer{Development: true}
	full := true
	for _, id := range []string{"agent-1", "agent-2", "agent-3"} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/diff", nil)
		s.GetAgentDiff(rec, req, "proj", id, api.GetAgentDiffParams{FullContext: &full})

		var resp api.DiffResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatalf("%s: decode: %v", id, err)
		}
		for _, f := range resp.Files {
			if f.Binary {
				continue
			}
			// A change deep in a large file is intentionally windowed (see
			// simReconstructFull's cap); it doesn't drive the reveal model.
			if f.Expanded == nil || !*f.Expanded {
				continue
			}
			if len(f.Hunks) != 1 {
				t.Errorf("%s: %s: want a single merged hunk, got %d", id, f.Path, len(f.Hunks))
			}
			prevOld, prevNew := 0, 0
			for _, h := range f.Hunks {
				for _, l := range h.Lines {
					if l.OldLineNum != nil {
						if prevOld != 0 && *l.OldLineNum != prevOld+1 {
							t.Errorf("%s: %s: old line jumped %d -> %d", id, f.Path, prevOld, *l.OldLineNum)
						}
						prevOld = *l.OldLineNum
					}
					if l.NewLineNum != nil {
						if prevNew != 0 && *l.NewLineNum != prevNew+1 {
							t.Errorf("%s: %s: new line jumped %d -> %d", id, f.Path, prevNew, *l.NewLineNum)
						}
						prevNew = *l.NewLineNum
					}
				}
			}
		}
	}
}
