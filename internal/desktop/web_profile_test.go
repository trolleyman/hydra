package desktop

import (
	"path/filepath"
	"testing"
)

func TestWebProfileDirectoryFollowsSelectedStateRoot(t *testing.T) {
	root := t.TempDir()
	t.Setenv("HYDRA_STATE_DIR", root)

	profile, err := webProfileDirectory()
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(root, "webview"); profile != want {
		t.Errorf("profile directory = %q, want %q", profile, want)
	}
}
