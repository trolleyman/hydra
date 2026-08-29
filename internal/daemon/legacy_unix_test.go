//go:build !windows

package daemon

import (
	"context"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

func TestRefuseLegacyDaemons(t *testing.T) {
	t.Setenv("XDG_RUNTIME_DIR", t.TempDir())
	dir, err := ensureRuntimeDir()
	if err != nil {
		t.Fatal(err)
	}
	sock := filepath.Join(dir, "0123456789abcdef.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			_, _ = w.Write([]byte("OK"))
		}
	})}
	go func() { _ = srv.Serve(ln) }()
	defer srv.Close()

	if err := RefuseLegacyDaemons(context.Background()); err == nil {
		t.Fatal("RefuseLegacyDaemons allowed a live legacy socket")
	}
}

func TestRefuseLegacyDaemonsRemovesStaleSocket(t *testing.T) {
	t.Setenv("XDG_RUNTIME_DIR", t.TempDir())
	dir, err := ensureRuntimeDir()
	if err != nil {
		t.Fatal(err)
	}
	sock := filepath.Join(dir, "0123456789abcdef.sock")
	if err := os.WriteFile(sock, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := RefuseLegacyDaemons(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(sock); !os.IsNotExist(err) {
		t.Fatalf("stale legacy socket remains: %v", err)
	}
}
