package http

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/trolleyman/hydra/internal/paths"
)

// writeFile creates a file (and its parents) with some bytes, failing the test
// on error.
func writeFile(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte("png"), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func TestResolveAgentFile(t *testing.T) {
	root := t.TempDir()
	worktree := filepath.Join(root, ".hydra", "local", "worktrees", "head-1")
	tmpDir := filepath.Join(root, ".hydra", "local", "tmp", "head-1")
	uploads := paths.GetUploadsDirFromProjectRoot(root)

	shot := filepath.Join(tmpDir, "shot.png")
	inTree := filepath.Join(worktree, "web", "public", "logo.png")
	upload := filepath.Join(uploads, "123-image1.png")
	writeFile(t, shot)
	writeFile(t, inTree)
	writeFile(t, upload)

	t.Run("sandbox /tmp path maps to the head's private dir", func(t *testing.T) {
		if got := resolveAgentFile(root, worktree, tmpDir, "/tmp/shot.png"); got != shot {
			t.Fatalf("got %q, want %q", got, shot)
		}
	})

	t.Run("absolute worktree path", func(t *testing.T) {
		if got := resolveAgentFile(root, worktree, tmpDir, inTree); got != inTree {
			t.Fatalf("got %q, want %q", got, inTree)
		}
	})

	t.Run("relative path resolves against the worktree", func(t *testing.T) {
		if got := resolveAgentFile(root, worktree, tmpDir, "web/public/logo.png"); got != inTree {
			t.Fatalf("got %q, want %q", got, inTree)
		}
	})

	t.Run("upload path", func(t *testing.T) {
		if got := resolveAgentFile(root, worktree, tmpDir, upload); got != upload {
			t.Fatalf("got %q, want %q", got, upload)
		}
	})

	t.Run("rejects paths outside every root", func(t *testing.T) {
		outside := filepath.Join(root, "elsewhere", "secret.png")
		writeFile(t, outside)
		for _, p := range []string{
			outside,
			"/etc/hosts.png",
			"../../../etc/hosts.png",
			filepath.Join(worktree, "..", "..", "..", "elsewhere", "secret.png"),
		} {
			if got := resolveAgentFile(root, worktree, tmpDir, p); got != "" {
				t.Fatalf("%q: served %q, want no match", p, got)
			}
		}
	})

	t.Run("rejects a symlink escaping the worktree", func(t *testing.T) {
		if runtime.GOOS == "windows" {
			t.Skip("symlinks need privileges on Windows")
		}
		outside := filepath.Join(root, "elsewhere", "secret.png")
		writeFile(t, outside)
		link := filepath.Join(worktree, "leak.png")
		if err := os.Symlink(outside, link); err != nil {
			t.Fatalf("symlink: %v", err)
		}
		if got := resolveAgentFile(root, worktree, tmpDir, link); got != "" {
			t.Fatalf("served %q through an escaping symlink, want no match", got)
		}
	})

	t.Run("missing file is not a match", func(t *testing.T) {
		if got := resolveAgentFile(root, worktree, tmpDir, "/tmp/nope.png"); got != "" {
			t.Fatalf("got %q, want no match", got)
		}
	})

	t.Run("a directory is not a match", func(t *testing.T) {
		dir := filepath.Join(worktree, "assets.png")
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		if got := resolveAgentFile(root, worktree, tmpDir, dir); got != "" {
			t.Fatalf("got %q, want no match", got)
		}
	})

	t.Run("a recording resolves like a screenshot", func(t *testing.T) {
		clip := filepath.Join(tmpDir, "demo.webm")
		writeFile(t, clip)
		if got := resolveAgentFile(root, worktree, tmpDir, "/tmp/demo.webm"); got != clip {
			t.Fatalf("got %q, want %q", got, clip)
		}
	})

	t.Run("without a private tmp dir the real /tmp is allowed", func(t *testing.T) {
		// An unsandboxed head genuinely writes to the host /tmp.
		real := filepath.Join(os.TempDir(), "hydra-agentfiles-test.png")
		writeFile(t, real)
		defer os.Remove(real)
		if got := resolveAgentFile(root, worktree, "", real); got != real {
			t.Fatalf("got %q, want %q", got, real)
		}
		// ...but a head that HAS one must not reach past it into the host /tmp.
		if got := resolveAgentFile(root, worktree, tmpDir, real); got != "" {
			t.Fatalf("got %q, want no match", got)
		}
	})
}

// The endpoint serves what the chat renderer can show - stills and the video
// formats a browser plays - and nothing else, however legitimately the head
// could name it.
func TestAgentServableExt(t *testing.T) {
	for _, name := range []string{"/tmp/shot.png", "a/b/logo.SVG", "clip.webm", "/tmp/demo.MP4", "rec.mov"} {
		if !agentServableExt(name) {
			t.Errorf("%q: want servable", name)
		}
	}
	for _, name := range []string{"/etc/passwd", "notes.md", "secret.env", "archive.zip", "clip.webm.txt", "noext"} {
		if agentServableExt(name) {
			t.Errorf("%q: want not servable", name)
		}
	}
}

// A .webm has no entry in Go's built-in mime table, so without the pin in
// extContentTypes it would be served as whatever the host's /etc/mime.types
// happens to say - and under nosniff, anything but video/webm means a player
// that refuses to play.
func TestVideoContentTypePinned(t *testing.T) {
	for name, want := range map[string]string{
		"clip.webm": "video/webm",
		"clip.mp4":  "video/mp4",
		"clip.mov":  "video/quicktime",
	} {
		w := httptest.NewRecorder()
		setBlobFileHeaders(w, strings.NewReader("not really a video"), name)
		if got := w.Header().Get("Content-Type"); got != want {
			t.Errorf("%s: got %q, want %q", name, got, want)
		}
	}
}
