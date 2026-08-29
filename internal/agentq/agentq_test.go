package agentq

import (
	"os"
	"path/filepath"
	"testing"
)

func TestListRequestsTakesIdentityFromFilename(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "safe.req.json"), []byte(`{"reqid":"../../escape","ts":"t","op":"list"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	reqs, err := ListRequests(dir)
	if err != nil || len(reqs) != 1 {
		t.Fatalf("ListRequests = %+v, %v", reqs, err)
	}
	if reqs[0].ReqID != "safe" {
		t.Fatalf("request id = %q, want filename identity", reqs[0].ReqID)
	}
}
