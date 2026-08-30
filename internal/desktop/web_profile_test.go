package desktop

import (
	"path/filepath"
	"testing"
)

func TestWebProfileDirectoriesFollowSelectedStateRoot(t *testing.T) {
	root := t.TempDir()
	t.Setenv("HYDRA_STATE_DIR", root)

	data, cache, err := webProfileDirectories()
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(root, "webview", "data"); data != want {
		t.Errorf("data directory = %q, want %q", data, want)
	}
	if want := filepath.Join(root, "webview", "cache"); cache != want {
		t.Errorf("cache directory = %q, want %q", cache, want)
	}
}
