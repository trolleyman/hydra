package http

import (
	"io"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestSetBlobSecurityHeaders(t *testing.T) {
	// A script-capable type is sandboxed; a plain image is only pinned. PDF must
	// NOT get the sandbox directive - it would disable the browser's viewer.
	cases := []struct {
		contentType string
		sandboxed   bool
	}{
		{"image/svg+xml", true},
		{"text/html; charset=utf-8", true},
		{"application/xhtml+xml", true},
		{"text/xml", true},
		{"image/png", false},
		{"video/webm", false},
		{"application/pdf", false},
		{"text/plain; charset=utf-8", false},
	}
	for _, c := range cases {
		w := httptest.NewRecorder()
		setBlobSecurityHeaders(w, c.contentType)
		if got := w.Header().Get("X-Content-Type-Options"); got != "nosniff" {
			t.Errorf("%s: nosniff = %q, want nosniff", c.contentType, got)
		}
		csp := w.Header().Get("Content-Security-Policy")
		if c.sandboxed && csp != "default-src 'none'; sandbox" {
			t.Errorf("%s: CSP = %q, want the sandbox policy", c.contentType, csp)
		}
		if !c.sandboxed && csp != "" {
			t.Errorf("%s: CSP = %q, want none", c.contentType, csp)
		}
	}
}

func TestSetBlobFileHeaders(t *testing.T) {
	const svg = `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>x()</script></svg>`
	cases := []struct {
		name, body, wantType string
		wantSandbox          bool
	}{
		// An SVG sniffs as text/xml and Go's mime table can't be relied on for it,
		// so the extension has to pin the type - otherwise nosniff would stop the
		// repository browser and project icons rendering one via <img>.
		{"logo.svg", svg, "image/svg+xml", true},
		{"logo.SVG", svg, "image/svg+xml", true},
		{"page.html", "<html><body>hi", "text/html; charset=utf-8", true},
		{"shot.png", "\x89PNG\r\n\x1a\n", "image/png", false},
		{"notes.txt", "hello", "text/plain; charset=utf-8", false},
		// No extension at all: sniffed here rather than left for ServeContent, so
		// a scriptable type still picks up the sandbox policy.
		{"noext", "<html><body>hi", "text/html; charset=utf-8", true},
		{"noext-image", "\x89PNG\r\n\x1a\n", "image/png", false},
	}
	for _, c := range cases {
		w := httptest.NewRecorder()
		f := strings.NewReader(c.body)
		setBlobFileHeaders(w, f, c.name)
		if got := w.Header().Get("Content-Type"); got != c.wantType {
			t.Errorf("%s: Content-Type = %q, want %q", c.name, got, c.wantType)
		}
		if got := w.Header().Get("Content-Security-Policy") != ""; got != c.wantSandbox {
			t.Errorf("%s: sandboxed = %v, want %v", c.name, got, c.wantSandbox)
		}
		// The body must be left rewound for the ServeContent that follows.
		rest, _ := io.ReadAll(f)
		if string(rest) != c.body {
			t.Errorf("%s: reader left at %q, want the whole body", c.name, string(rest))
		}
	}
}

func TestBlobContentType(t *testing.T) {
	if got := blobContentType("a.svg", []byte("<svg/>")); got != "image/svg+xml" {
		t.Errorf("svg: got %q", got)
	}
	if got := blobContentType("a.png", []byte("\x89PNG\r\n\x1a\n")); got != "image/png" {
		t.Errorf("png: got %q", got)
	}
}

// A symlink an agent plants in its own worktree must not turn the worktree blob
// endpoint into a reader for any file the daemon can open.
func TestServeWorktreeBlobRejectsSymlinkEscape(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks need privileges on Windows")
	}
	root := t.TempDir()
	worktree := filepath.Join(root, "wt")
	if err := os.MkdirAll(worktree, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	secret := filepath.Join(root, "outside.txt")
	if err := os.WriteFile(secret, []byte("TOP SECRET"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := os.Symlink(secret, filepath.Join(worktree, "leak.txt")); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	inTree := filepath.Join(worktree, "ok.txt")
	if err := os.WriteFile(inTree, []byte("fine"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	srv := &Server{}
	t.Run("escaping symlink", func(t *testing.T) {
		w := httptest.NewRecorder()
		srv.serveWorktreeBlob(w, httptest.NewRequest("GET", "/blob", nil), worktree, "leak.txt")
		if w.Code != 404 {
			t.Fatalf("status %d body %q, want 404", w.Code, w.Body.String())
		}
	})
	t.Run("lexical escape", func(t *testing.T) {
		w := httptest.NewRecorder()
		srv.serveWorktreeBlob(w, httptest.NewRequest("GET", "/blob", nil), worktree, "../outside.txt")
		if w.Code != 404 {
			t.Fatalf("status %d, want 404", w.Code)
		}
	})
	t.Run("ordinary file still served", func(t *testing.T) {
		w := httptest.NewRecorder()
		srv.serveWorktreeBlob(w, httptest.NewRequest("GET", "/blob", nil), worktree, "ok.txt")
		if w.Code != 200 || w.Body.String() != "fine" {
			t.Fatalf("status %d body %q, want 200 \"fine\"", w.Code, w.Body.String())
		}
	})
	t.Run("symlink INSIDE the worktree still served", func(t *testing.T) {
		if err := os.Symlink(inTree, filepath.Join(worktree, "alias.txt")); err != nil {
			t.Fatalf("symlink: %v", err)
		}
		w := httptest.NewRecorder()
		srv.serveWorktreeBlob(w, httptest.NewRequest("GET", "/blob", nil), worktree, "alias.txt")
		if w.Code != 200 || w.Body.String() != "fine" {
			t.Fatalf("status %d body %q, want 200 \"fine\"", w.Code, w.Body.String())
		}
	})
}
