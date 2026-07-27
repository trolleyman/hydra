package gitq

import (
	"path/filepath"
	"testing"
)

func TestChannelRoundTrip(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "gitops", "head-1")

	// A missing dir lists no requests (not an error).
	if reqs, err := ListRequests(dir); err != nil || len(reqs) != 0 {
		t.Fatalf("empty ListRequests = %v, %v; want nil, nil", reqs, err)
	}
	// No result yet.
	if _, ok, err := ReadResult(dir, "a"); err != nil || ok {
		t.Fatalf("ReadResult before write = ok %v, err %v; want false, nil", ok, err)
	}

	// Two requests, oldest-first by TS.
	if err := WriteRequest(dir, Request{ReqID: "b", Message: "second", TS: "2024-01-02"}); err != nil {
		t.Fatal(err)
	}
	if err := WriteRequest(dir, Request{ReqID: "a", Message: "first", Paths: []string{"x.go"}, TS: "2024-01-01"}); err != nil {
		t.Fatal(err)
	}
	reqs, err := ListRequests(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(reqs) != 2 || reqs[0].ReqID != "a" || reqs[1].ReqID != "b" {
		t.Fatalf("ListRequests order = %+v; want [a b] by TS", reqs)
	}
	if len(reqs[0].Paths) != 1 || reqs[0].Paths[0] != "x.go" {
		t.Errorf("request payload not round-tripped: %+v", reqs[0])
	}

	// Writing a result retires that request from the pending list (idempotency).
	if err := WriteResult(dir, "a", Result{OK: true, Message: "Committed abc"}); err != nil {
		t.Fatal(err)
	}
	res, ok, err := ReadResult(dir, "a")
	if err != nil || !ok || !res.OK || res.Message != "Committed abc" {
		t.Fatalf("ReadResult(a) = %+v, ok %v, err %v", res, ok, err)
	}
	reqs, _ = ListRequests(dir)
	if len(reqs) != 1 || reqs[0].ReqID != "b" {
		t.Fatalf("decided request 'a' should be skipped; pending = %+v", reqs)
	}
}
