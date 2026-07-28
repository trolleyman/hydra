package tests

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// A settled report keeps its summary and its cases in separate files, so the
// readers that only want counts never parse the big one - and a full read still
// reassembles both.
func TestWriteReportSplitsCasesFromSummary(t *testing.T) {
	m := NewManager(t.TempDir())
	dir := m.entryDir("t", "commit/abc123")
	rep := Report{
		Runner: "t", Key: "commit/abc123", Status: StatusPassing,
		Total: 2, Passed: 2, UpdatedAt: 100,
		Cases: []TestCase{{Name: "A", Status: CasePassed}, {Name: "B", Status: CasePassed}},
	}
	if err := writeReport(dir, rep); err != nil {
		t.Fatal(err)
	}
	// writeReport takes the report by value - the caller's cases survive.
	if len(rep.Cases) != 2 {
		t.Errorf("writeReport mutated the caller's report (cases = %d)", len(rep.Cases))
	}

	raw, err := os.ReadFile(filepath.Join(dir, reportFile))
	if err != nil {
		t.Fatal(err)
	}
	var onDisk map[string]any
	if err := json.Unmarshal(raw, &onDisk); err != nil {
		t.Fatal(err)
	}
	if _, present := onDisk["cases"]; present {
		t.Errorf("report.json still carries cases inline: %s", raw)
	}

	if got, ok := readReportSummary(dir); !ok || got.Total != 2 || len(got.Cases) != 0 {
		t.Errorf("readReportSummary = %+v (ok=%v), want the counts and no cases", got, ok)
	}
	full, ok := readReport(dir)
	if !ok || len(full.Cases) != 2 || full.Cases[1].Name != "B" {
		t.Fatalf("readReport = %+v (ok=%v), want both cases back", full, ok)
	}

	// A re-run that parses nothing must not leave the old cases behind.
	rep.Cases = nil
	rep.Total, rep.Passed = 0, 0
	if err := writeReport(dir, rep); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, casesFile)); !os.IsNotExist(err) {
		t.Errorf("stale cases sidecar survived a caseless re-run (err=%v)", err)
	}
}

// Entries written before the cases split hold their cases inline; readReport
// must keep returning them rather than looking for a sidecar that isn't there.
func TestReadReportHandlesLegacyInlineCases(t *testing.T) {
	m := NewManager(t.TempDir())
	dir := m.entryDir("t", "commit/legacy1")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	legacy := `{"runner":"t","key":"commit/legacy1","status":"failing","total":1,"failed":1,
		"cases":[{"name":"A","status":"failed","message":"boom"}],"updated_at":5}`
	if err := os.WriteFile(filepath.Join(dir, reportFile), []byte(legacy), 0o644); err != nil {
		t.Fatal(err)
	}
	rep, ok := readReport(dir)
	if !ok || len(rep.Cases) != 1 || rep.Cases[0].Message != "boom" {
		t.Fatalf("readReport(legacy) = %+v (ok=%v), want the inline case", rep, ok)
	}
}

// ageEntry backdates a cache entry, both its files (what PruneStale reads, via
// the newest mtime inside the entry) and the directory itself (what scanLatest
// orders by).
func ageEntry(t *testing.T, dir string, mod time.Time) {
	t.Helper()
	names, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, n := range names {
		if err := os.Chtimes(filepath.Join(dir, n.Name()), mod, mod); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Chtimes(dir, mod, mod); err != nil {
		t.Fatal(err)
	}
}

// Latest answers from the runner's pointer file, and repairs it by scanning
// when it is missing (a cache from before the pointer existed) or dangling (its
// entry was pruned or invalidated).
func TestLatestUsesPointerAndRepairsIt(t *testing.T) {
	m := NewManager(t.TempDir())
	write := func(key string, updatedAt int64, mod time.Time) string {
		dir := m.entryDir("t", key)
		if err := writeReport(dir, Report{Runner: "t", Key: key, Status: StatusPassing, Total: int(updatedAt), UpdatedAt: updatedAt}); err != nil {
			t.Fatal(err)
		}
		ageEntry(t, dir, mod)
		return dir
	}
	now := time.Now()
	write("commit/aaa", 100, now.Add(-2*time.Hour))
	newest := write("commit/bbb", 200, now.Add(-1*time.Hour))

	// No pointer yet (nothing called updateLatest): the scan picks the entry with
	// the newest directory mtime and writes the pointer for next time.
	rep, ok := m.Latest("t")
	if !ok || rep.Key != "commit/bbb" {
		t.Fatalf("Latest (no pointer) = %+v (ok=%v), want commit/bbb", rep, ok)
	}
	ptr, ok := readLatestPointer(m.runnerDir("t"))
	if !ok || ptr.Key != "commit/bbb" {
		t.Fatalf("pointer after scan = %+v (ok=%v), want commit/bbb", ptr, ok)
	}

	// With the entry gone the pointer dangles; Latest falls back to the scan and
	// re-points at what survives.
	if err := os.RemoveAll(newest); err != nil {
		t.Fatal(err)
	}
	rep, ok = m.Latest("t")
	if !ok || rep.Key != "commit/aaa" {
		t.Fatalf("Latest (dangling pointer) = %+v (ok=%v), want commit/aaa", rep, ok)
	}
	if ptr, ok := readLatestPointer(m.runnerDir("t")); !ok || ptr.Key != "commit/aaa" {
		t.Fatalf("pointer after repair = %+v (ok=%v), want commit/aaa", ptr, ok)
	}

	// An out-of-order settle (a queued run of an older commit finishing late)
	// must not drag the pointer backwards.
	m.updateLatest(Report{Runner: "t", Key: "commit/old", UpdatedAt: 1})
	if ptr, ok := readLatestPointer(m.runnerDir("t")); !ok || ptr.Key != "commit/aaa" {
		t.Errorf("pointer after a stale settle = %+v (ok=%v), want commit/aaa", ptr, ok)
	}
}

// A pointer whose key isn't a well-formed cache key is never trusted - it is
// joined onto a filesystem path.
func TestLatestPointerRejectsMalformedKey(t *testing.T) {
	m := NewManager(t.TempDir())
	runnerDir := m.runnerDir("t")
	if err := os.MkdirAll(runnerDir, 0o755); err != nil {
		t.Fatal(err)
	}
	raw := `{"key":"../../../etc","updated_at":1}`
	if err := os.WriteFile(filepath.Join(runnerDir, latestFile), []byte(raw), 0o644); err != nil {
		t.Fatal(err)
	}
	if ptr, ok := readLatestPointer(runnerDir); ok {
		t.Errorf("readLatestPointer accepted %+v, want it rejected", ptr)
	}
}

// PruneStale drops entries past maxAge, evicts oldest-first to fit maxBytes, and
// leaves the per-branch denominator sidecars alone.
func TestPruneStale(t *testing.T) {
	m := NewManager(t.TempDir())
	write := func(key string, mod time.Time) string {
		dir := m.entryDir("t", key)
		if err := writeReport(dir, Report{Runner: "t", Key: key, Status: StatusPassing, UpdatedAt: mod.Unix()}); err != nil {
			t.Fatal(err)
		}
		ageEntry(t, dir, mod)
		return dir
	}
	now := time.Now()
	old := write("commit/aaa", now.Add(-30*24*time.Hour))
	fresh := write("commit/bbb", now.Add(-time.Hour))
	branchDir := m.branchTotalDir("t", "main")
	if err := writeBranchTotal(branchDir, branchTotal{Total: 7, UpdatedAt: 1}); err != nil {
		t.Fatal(err)
	}
	m.updateLatest(Report{Runner: "t", Key: "commit/aaa", UpdatedAt: now.Add(-30 * 24 * time.Hour).Unix()})

	if err := m.PruneStale(14*24*time.Hour, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Errorf("aged-out entry survived (err=%v)", err)
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Errorf("fresh entry was pruned: %v", err)
	}
	if bt, ok := readBranchTotal(branchDir); !ok || bt.Total != 7 {
		t.Errorf("branch total sidecar = %+v (ok=%v), want it untouched", bt, ok)
	}
	// The pointer named the entry that was just pruned, so it should be gone
	// rather than left dangling for every later Latest to rescan past.
	if _, err := os.Stat(filepath.Join(m.runnerDir("t"), latestFile)); !os.IsNotExist(err) {
		t.Errorf("dangling pointer survived the prune (err=%v)", err)
	}

	// maxBytes evicts oldest-first, regardless of age.
	if err := m.PruneStale(0, 1); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(fresh); !os.IsNotExist(err) {
		t.Errorf("entry over the byte cap survived (err=%v)", err)
	}
}

// An in-flight generation's entry is never pruned out from under it.
func TestPruneStaleSkipsInFlight(t *testing.T) {
	m := NewManager(t.TempDir())
	dir := m.entryDir("t", "commit/aaa")
	if err := writeReport(dir, Report{Runner: "t", Key: "commit/aaa", Status: StatusPassing}); err != nil {
		t.Fatal(err)
	}
	ageEntry(t, dir, time.Now().Add(-30*24*time.Hour))
	m.mu.Lock()
	m.gens[dir] = struct{}{}
	m.mu.Unlock()

	if err := m.PruneStale(14*24*time.Hour, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir); err != nil {
		t.Errorf("in-flight entry was pruned: %v", err)
	}
}
