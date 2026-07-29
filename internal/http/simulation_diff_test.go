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

// TestSimSingleFilePromotionExpands covers the other half of the same rule. The
// bulk request's cap (6000) leaves a change deep in a big file windowed - that
// is what the client's "-U3 hunks + expand" fallback renders - but when the
// reader clicks one of that file's expanders the client re-asks for it alone
// with a much larger cap, and it must then come back expanded and contiguous,
// so every later reveal is client-side and touches only the gap clicked.
func TestSimSingleFilePromotionExpands(t *testing.T) {
	const deepFile = "web/src/components/AgentChat.tsx"
	s := &SimulationServer{Development: true}
	full := true

	path := deepFile
	get := func(maxFullLines int) api.DiffFile {
		t.Helper()
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/diff", nil)
		s.GetAgentDiff(rec, req, "proj", "agent-1", api.GetAgentDiffParams{
			FullContext:  &full,
			MaxFullLines: &maxFullLines,
			Path:         &path,
		})
		var resp api.DiffResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode: %v", err)
		}
		for _, f := range resp.Files {
			if f.Path == deepFile {
				return f
			}
		}
		t.Fatalf("%s missing from response", deepFile)
		return api.DiffFile{}
	}

	if f := get(6000); f.Expanded != nil && *f.Expanded {
		t.Errorf("bulk cap: want %s left windowed, got expanded", deepFile)
	}

	f := get(20000)
	if f.Expanded == nil || !*f.Expanded {
		t.Fatalf("promotion cap: want %s expanded", deepFile)
	}
	if len(f.Hunks) != 1 {
		t.Fatalf("want a single whole-file hunk, got %d", len(f.Hunks))
	}
	if f.Hunks[0].OldStart != 1 || f.Hunks[0].NewStart != 1 {
		t.Errorf("want the hunk to start at line 1, got old %d new %d", f.Hunks[0].OldStart, f.Hunks[0].NewStart)
	}
	prevOld, prevNew := 0, 0
	for _, l := range f.Hunks[0].Lines {
		if l.OldLineNum != nil {
			if prevOld != 0 && *l.OldLineNum != prevOld+1 {
				t.Fatalf("old line jumped %d -> %d", prevOld, *l.OldLineNum)
			}
			prevOld = *l.OldLineNum
		}
		if l.NewLineNum != nil {
			if prevNew != 0 && *l.NewLineNum != prevNew+1 {
				t.Fatalf("new line jumped %d -> %d", prevNew, *l.NewLineNum)
			}
			prevNew = *l.NewLineNum
		}
	}
}
