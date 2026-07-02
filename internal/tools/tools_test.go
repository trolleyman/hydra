package tools

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestEnvPrefersExistingOverride(t *testing.T) {
	root := t.TempDir()
	// Even with a bundled pasta present, an explicit HYDRA_PASTA must win.
	writeExecutable(t, PastaPath(root))
	env := Env(root, func(k string) string {
		if k == "HYDRA_PASTA" {
			return "/custom/pasta"
		}
		return ""
	})
	if _, ok := env["HYDRA_PASTA"]; ok {
		t.Errorf("Env must not override an already-set HYDRA_PASTA: %v", env)
	}
}

func TestEnvPointsAtBundledPasta(t *testing.T) {
	root := t.TempDir()
	if env := Env(root, func(string) string { return "" }); len(env) != 0 {
		t.Errorf("Env should be empty when nothing is bundled: %v", env)
	}
	writeExecutable(t, PastaPath(root))
	env := Env(root, func(string) string { return "" })
	if env["HYDRA_PASTA"] != PastaPath(root) {
		t.Errorf("Env should point HYDRA_PASTA at the bundled pasta, got %v", env)
	}
}

func TestFetchDownloadsThenSkipsUnchanged(t *testing.T) {
	const lastMod = "Thu, 02 Jul 2026 05:44:55 GMT"
	body := []byte("#!/bin/true\n")
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.Header().Set("Last-Modified", lastMod)
		if r.Method == http.MethodHead {
			w.Header().Set("Content-Length", itoa(len(body)))
			return
		}
		_, _ = w.Write(body)
	}))
	defer srv.Close()

	dest := filepath.Join(t.TempDir(), "pasta")
	ctx := context.Background()

	// First fetch downloads and records meta, and marks the binary executable.
	if action, err := fetch(ctx, srv.URL, dest, false); err != nil {
		t.Fatalf("first fetch: %v", err)
	} else if action != "downloaded pasta" {
		t.Errorf("first action = %q, want downloaded", action)
	}
	if info, err := os.Stat(dest); err != nil {
		t.Fatalf("stat dest: %v", err)
	} else if info.Mode()&0o100 == 0 {
		t.Errorf("downloaded binary not executable: %v", info.Mode())
	}

	// Ensure (force=false) with the file present makes no network call.
	before := hits
	if action, err := fetch(ctx, srv.URL, dest, false); err != nil {
		t.Fatalf("second fetch: %v", err)
	} else if action != "pasta present" {
		t.Errorf("second action = %q, want present", action)
	}
	if hits != before {
		t.Errorf("ensure hit the network %d times, want 0", hits-before)
	}

	// Update (force=true) HEADs upstream but skips the download when unchanged.
	if action, err := fetch(ctx, srv.URL, dest, true); err != nil {
		t.Fatalf("update fetch: %v", err)
	} else if action != "pasta up to date" {
		t.Errorf("update action = %q, want up to date", action)
	}
}

func TestFetchRedownloadsWhenUpstreamChanges(t *testing.T) {
	lastMod := "Thu, 02 Jul 2026 05:44:55 GMT"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Last-Modified", lastMod)
		if r.Method == http.MethodHead {
			return
		}
		_, _ = w.Write([]byte("payload"))
	}))
	defer srv.Close()

	dest := filepath.Join(t.TempDir(), "pasta")
	ctx := context.Background()
	if _, err := fetch(ctx, srv.URL, dest, false); err != nil {
		t.Fatalf("initial: %v", err)
	}

	// Upstream build changes → force must re-download.
	lastMod = "Fri, 03 Jul 2026 06:00:00 GMT"
	if action, err := fetch(ctx, srv.URL, dest, true); err != nil {
		t.Fatalf("update: %v", err)
	} else if action != "updated pasta" {
		t.Errorf("action = %q, want updated pasta", action)
	}
}

func writeExecutable(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("#!/bin/true\n"), 0o755); err != nil {
		t.Fatal(err)
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}
