package reviewq

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRequestResultRoundTrip(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "h1")

	// A missing dir is "no requests", not an error - the watcher readdirs dirs
	// that heads may never have written to.
	if reqs, err := ListRequests(dir); err != nil || len(reqs) != 0 {
		t.Fatalf("ListRequests on missing dir = %v, %v; want none, nil", reqs, err)
	}
	if _, ok, err := ReadResult(dir, "1"); ok || err != nil {
		t.Fatalf("ReadResult with no result = %v, %v; want false, nil", ok, err)
	}

	if err := WriteRequest(dir, Request{ReqID: "2", TS: "2026-07-28T12:00:02Z"}); err != nil {
		t.Fatalf("WriteRequest: %v", err)
	}
	if err := WriteRequest(dir, Request{ReqID: "1", TS: "2026-07-28T12:00:01Z"}); err != nil {
		t.Fatalf("WriteRequest: %v", err)
	}
	reqs, err := ListRequests(dir)
	if err != nil || len(reqs) != 2 {
		t.Fatalf("ListRequests = %v, %v; want 2 requests", reqs, err)
	}
	if reqs[0].ReqID != "1" {
		t.Errorf("requests not oldest-first by TS: %v", reqs)
	}

	// Answering one request drops it from the pending list; the other stays, so a
	// crashed watcher re-answers only what it owes.
	if err := WriteResult(dir, "1", Result{OK: true, Refreshed: true}); err != nil {
		t.Fatalf("WriteResult: %v", err)
	}
	reqs, _ = ListRequests(dir)
	if len(reqs) != 1 || reqs[0].ReqID != "2" {
		t.Fatalf("after answering 1, pending = %v; want just 2", reqs)
	}
	res, ok, err := ReadResult(dir, "1")
	if err != nil || !ok || !res.OK || !res.Refreshed {
		t.Fatalf("ReadResult = %+v, %v, %v; want an OK refreshed result", res, ok, err)
	}
}

func TestSweepKeepsRecentPairs(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "h1")
	for _, id := range []string{"1", "2", "3", "4"} {
		if err := WriteRequest(dir, Request{ReqID: id, TS: id}); err != nil {
			t.Fatalf("WriteRequest: %v", err)
		}
		if err := WriteResult(dir, id, Result{OK: true}); err != nil {
			t.Fatalf("WriteResult: %v", err)
		}
	}
	// An unanswered request must survive the sweep however old it is - it is still
	// owed an answer.
	if err := WriteRequest(dir, Request{ReqID: "0", TS: "0"}); err != nil {
		t.Fatalf("WriteRequest: %v", err)
	}

	Sweep(dir, 2)

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	got := map[string]bool{}
	for _, e := range entries {
		got[e.Name()] = true
	}
	for _, name := range []string{"3.req.json", "3.result.json", "4.req.json", "4.result.json", "0.req.json"} {
		if !got[name] {
			t.Errorf("%s was swept but should have been kept: %v", name, got)
		}
	}
	for _, name := range []string{"1.req.json", "1.result.json", "2.req.json", "2.result.json"} {
		if got[name] {
			t.Errorf("%s should have been swept: %v", name, got)
		}
	}
	if pending, _ := ListRequests(dir); len(pending) != 1 || pending[0].ReqID != "0" {
		t.Errorf("unanswered request lost by the sweep: %v", pending)
	}
}
