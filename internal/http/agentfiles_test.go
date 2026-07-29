package http

import (
	"bytes"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"runtime"
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

// writePNGFile writes a real w×h PNG (writeFile's bytes are not an image, and
// the sizes endpoint has to read a header out of them).
func writePNGFile(t *testing.T, path string, w, h int) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(path), err)
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, w, h))); err != nil {
		t.Fatalf("encode: %v", err)
	}
	if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

// The sizes endpoint tells the chat how big a picture is before it fetches it,
// so a screenshot lands in a box that was already the right height instead of
// shoving the transcript. It answers only for files the blob endpoint would
// serve - it shares resolveAgentFile and the same extension allowlist - and says
// NOTHING (rather than zero) about anything it can't measure, because the client
// falls back to decoding the image itself for exactly those.
func TestAgentFileSizes(t *testing.T) {
	root := t.TempDir()
	worktree := filepath.Join(root, ".hydra", "local", "worktrees", "head-1")
	tmpDir := filepath.Join(root, ".hydra", "local", "tmp", "head-1")

	shot := filepath.Join(tmpDir, "shot.png")
	inTree := filepath.Join(worktree, "web", "public", "logo.png")
	writePNGFile(t, shot, 780, 1688)
	writePNGFile(t, inTree, 64, 32)
	// An image by extension whose bytes are not one - the shape of a screenshot
	// still being written when the page asks about it.
	writeFile(t, filepath.Join(tmpDir, "half-written.png"))

	got := agentFileSizes(root, worktree, tmpDir, []string{
		"/tmp/shot.png",         // the head's private tmp
		"web/public/logo.png",   // relative to the worktree
		"/tmp/half-written.png", // an image we cannot measure
		"/tmp/missing.png",      // nothing there
		"/etc/passwd.png",       // outside every root
		"/tmp/notes.txt",        // not an image at all
		"/tmp/shot.png",         // a duplicate: one answer, not two
	})

	want := map[string]agentFileSize{
		"/tmp/shot.png":       {Width: 780, Height: 1688},
		"web/public/logo.png": {Width: 64, Height: 32},
	}
	if len(got) != len(want) {
		t.Fatalf("got %d sizes %v, want %d %v", len(got), got, len(want), want)
	}
	for path, size := range want {
		if got[path] != size {
			t.Errorf("%s: got %v, want %v", path, got[path], size)
		}
	}
}
