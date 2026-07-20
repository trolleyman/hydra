package gate

import (
	"testing"
)

func TestApprovalRoundTrip(t *testing.T) {
	dir := t.TempDir()
	req := Request{ReqID: "123", Tool: "mcp__evil__run", Kind: "mcp", Target: "evil", Summary: "wants to use MCP server \"evil\"", TS: "2026-06-28T00:00:00Z"}
	if err := WriteRequest(dir, req); err != nil {
		t.Fatal(err)
	}

	// Pending until a decision is written.
	pending, err := ListRequests(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(pending) != 1 || pending[0].ReqID != "123" {
		t.Fatalf("expected 1 pending request, got %+v", pending)
	}

	if r, ok, _ := ReadRequest(dir, "123"); !ok || r.Target != "evil" {
		t.Fatalf("ReadRequest mismatch: ok=%v r=%+v", ok, r)
	}

	// No decision yet.
	if _, ok, _ := ReadDecision(dir, "123"); ok {
		t.Fatal("decision should not exist yet")
	}

	// Write a decision; the request is no longer pending and the decision reads back.
	if err := WriteDecision(dir, "123", DecisionFile{Decision: Allow, Remember: true}); err != nil {
		t.Fatal(err)
	}
	d, ok, err := ReadDecision(dir, "123")
	if err != nil || !ok || d.Decision != Allow || !d.Remember {
		t.Fatalf("decision read mismatch: ok=%v d=%+v err=%v", ok, d, err)
	}
	pending, _ = ListRequests(dir)
	if len(pending) != 0 {
		t.Fatalf("decided request should drop off the pending list, got %+v", pending)
	}
}

func TestListRequestsMissingDir(t *testing.T) {
	got, err := ListRequests(t.TempDir() + "/does-not-exist")
	if err != nil || got != nil {
		t.Fatalf("missing dir should be empty, no error: got=%v err=%v", got, err)
	}
}

func TestHostRunResultRoundTrip(t *testing.T) {
	dir := t.TempDir()

	// No result until the daemon writes one.
	if _, ok, _ := ReadHostRunResult(dir, "42"); ok {
		t.Fatal("result should not exist yet")
	}

	want := HostRunResult{ExitCode: 3, Output: "boom\n", Truncated: true, TimedOut: false, Error: ""}
	if err := WriteHostRunResult(dir, "42", want); err != nil {
		t.Fatal(err)
	}
	got, ok, err := ReadHostRunResult(dir, "42")
	if err != nil || !ok {
		t.Fatalf("read result: ok=%v err=%v", ok, err)
	}
	if got != want {
		t.Fatalf("result mismatch: got %+v want %+v", got, want)
	}

	// RemoveRequest also clears the result file.
	RemoveRequest(dir, "42")
	if _, ok, _ := ReadHostRunResult(dir, "42"); ok {
		t.Fatal("result should be gone after RemoveRequest")
	}
}
