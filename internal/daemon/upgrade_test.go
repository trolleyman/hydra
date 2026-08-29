package daemon

import (
	"context"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestStopDaemonNeverSignalsItself is the guard for the restart-in-place path.
//
// A daemon that restarts by re-execing keeps its process ID, so on the way back
// up it calls StopDaemon (via serveUnixSocket) and finds a pidfile naming
// *itself*. Its /proc cmdline still contains `__daemon`, so pidIsHydraDaemon
// agrees it looks like a daemon worth evicting. Without the self-check the first
// thing a restarted daemon does is SIGTERM itself - and because that arrives
// before the signal handler is wired, it dies silently.
//
// The setup mirrors that state exactly: a live socket answering /health, plus a
// pidfile containing our own PID.
func TestStopDaemonNeverSignalsItself(t *testing.T) {
	projectRoot := t.TempDir()
	t.Setenv("XDG_RUNTIME_DIR", t.TempDir())

	sock, err := SocketPath(projectRoot)
	if err != nil {
		t.Fatalf("SocketPath: %v", err)
	}
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("OK"))
	})
	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() { _ = srv.Serve(ln) }()
	defer func() { _ = srv.Close() }()

	if err := WriteDaemonFiles(projectRoot); err != nil {
		t.Fatalf("WriteDaemonFiles: %v", err)
	}

	// A SIGTERM to ourselves would kill the test binary outright, so surviving
	// the call at all is most of the assertion. Catching the signal would only
	// mask a regression behind a handler the real daemon does not have yet at
	// this point in its startup.
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := StopDaemon(ctx, projectRoot); err != nil {
		t.Fatalf("StopDaemon on our own pidfile: %v", err)
	}

	// It should also have cleared the stale files so the caller can rebind.
	pp, err := pidPath(projectRoot)
	if err != nil {
		t.Fatalf("pidPath: %v", err)
	}
	if _, err := os.Stat(pp); !os.IsNotExist(err) {
		t.Errorf("pidfile still present after self-takeover, want it cleared (stat err = %v)", err)
	}
}

// TestStopDaemonClearsStaleFilesWhenNothingAnswers covers the ordinary cold
// path: no live socket, so there is nothing to signal and the leftovers just go.
func TestStopDaemonClearsStaleFilesWhenNothingAnswers(t *testing.T) {
	projectRoot := t.TempDir()
	t.Setenv("XDG_RUNTIME_DIR", t.TempDir())

	if err := WriteDaemonFiles(projectRoot); err != nil {
		t.Fatalf("WriteDaemonFiles: %v", err)
	}
	if err := StopDaemon(context.Background(), projectRoot); err != nil {
		t.Fatalf("StopDaemon: %v", err)
	}
	pp, _ := pidPath(projectRoot)
	if _, err := os.Stat(pp); !os.IsNotExist(err) {
		t.Errorf("pidfile still present, want it cleared")
	}
}

func TestRuntimePathsAreUserGlobal(t *testing.T) {
	t.Setenv("XDG_RUNTIME_DIR", t.TempDir())
	t.Setenv(runtimeNamespaceEnv, "")
	first, err := SocketPath("/projects/one")
	if err != nil {
		t.Fatal(err)
	}
	second, err := SocketPath("/projects/two")
	if err != nil {
		t.Fatal(err)
	}
	if first != second {
		t.Fatalf("SocketPath differs by project: %q != %q", first, second)
	}
}

func TestRuntimeNamespaceIsolatesDaemonFiles(t *testing.T) {
	t.Setenv("XDG_RUNTIME_DIR", t.TempDir())
	t.Setenv(runtimeNamespaceEnv, "development checkout one")
	first, err := SocketPath("/projects/one")
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv(runtimeNamespaceEnv, "development checkout two")
	second, err := SocketPath("/projects/one")
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatalf("SocketPath did not change with runtime namespace: %q", first)
	}
	if filepath.Dir(filepath.Dir(first)) != filepath.Dir(filepath.Dir(second)) {
		t.Fatalf("namespaced paths escaped their shared Hydra runtime directory: %q, %q", first, second)
	}
}

func TestRuntimeNamespaceCannotTraverse(t *testing.T) {
	base := t.TempDir()
	t.Setenv("XDG_RUNTIME_DIR", base)
	t.Setenv(runtimeNamespaceEnv, "../../outside")
	sock, err := SocketPath("/projects/one")
	if err != nil {
		t.Fatal(err)
	}
	wantParent := filepath.Join(base, "hydra")
	if filepath.Dir(filepath.Dir(sock)) != wantParent {
		t.Fatalf("SocketPath escaped runtime directory: %q", sock)
	}
}

func TestDesktopDaemonIsManaged(t *testing.T) {
	t.Setenv("XDG_RUNTIME_DIR", t.TempDir())
	t.Setenv("HYDRA_DESKTOP_SERVICE", "1")
	root := t.TempDir()
	if err := WriteDaemonFiles(root); err != nil {
		t.Fatal(err)
	}
	if !IsServiceManaged(root) {
		t.Fatal("desktop daemon was not recorded as managed")
	}
}
