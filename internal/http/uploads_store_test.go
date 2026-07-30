package http

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/trolleyman/hydra/internal/paths"
)

// StoreUploadFile is how a file an AGENT wrote becomes a durable attachment, so
// what matters is that it COPIES (the agent's worktree is deleted on merge) and
// that the copy lands somewhere the blob endpoint can serve from.
func TestStoreUploadFileCopiesIntoUploads(t *testing.T) {
	root := t.TempDir()
	src := filepath.Join(root, "shot.png")
	if err := os.WriteFile(src, []byte("bytes"), 0o644); err != nil {
		t.Fatal(err)
	}

	dest, err := StoreUploadFile(root, src)
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	if got := filepath.Dir(dest); got != paths.GetUploadsDirFromProjectRoot(root) {
		t.Errorf("stored at %s, want it in the uploads dir", got)
	}
	// A copy, not a move or a link: the original must still be readable, since the
	// agent may go on using it.
	if _, err := os.Stat(src); err != nil {
		t.Errorf("the source was consumed: %v", err)
	}
	if b, err := os.ReadFile(dest); err != nil || string(b) != "bytes" {
		t.Errorf("copy read back as (%q, %v), want \"bytes\"", b, err)
	}
	// The name must be one HandleUploadBlob will agree to serve, or the chip the
	// user sees points at a 404.
	if name := filepath.Base(dest); !safeUploadName.MatchString(name) {
		t.Errorf("stored name %q is not servable by HandleUploadBlob", name)
	}
	if !strings.HasSuffix(dest, "-shot.png") {
		t.Errorf("stored name %q lost the original filename", dest)
	}

	// Two files of the same name must not collide.
	other, err := StoreUploadFile(root, src)
	if err != nil || other == dest {
		t.Errorf("second store returned (%q, %v), want a distinct path", other, err)
	}
}

func TestStoreUploadFileRejectsDirsAndOversize(t *testing.T) {
	root := t.TempDir()

	if _, err := StoreUploadFile(root, root); err == nil {
		t.Error("storing a directory succeeded, want an error")
	}
	if _, err := StoreUploadFile(root, filepath.Join(root, "nope.png")); err == nil {
		t.Error("storing a missing file succeeded, want an error")
	}

	big := filepath.Join(root, "big.bin")
	if err := os.WriteFile(big, make([]byte, maxUploadBytes+1), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := StoreUploadFile(root, big); err == nil {
		t.Error("storing an oversize file succeeded, want it capped like a browser upload")
	}
	// A rejected file must leave nothing behind in the uploads dir.
	entries, _ := os.ReadDir(paths.GetUploadsDirFromProjectRoot(root))
	for _, e := range entries {
		if strings.Contains(e.Name(), "big.bin") {
			t.Errorf("a rejected upload left %s behind", e.Name())
		}
	}
}
