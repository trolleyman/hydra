//go:build unix

package selfupdate

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// This file tests the two mechanics the whole restart design rests on, and
// neither can be checked by calling a function: that syscall.Exec keeps the
// process ID, and that a listening socket survives the exec so the port is never
// unbound.
//
// So the test drives a real process through a real restart. TestMain dispatches
// on an environment variable to become the child, which binds a port, hands it
// to itself across an exec, and serves from the far side.

const (
	roleEnv    = "HYDRA_SELFUPDATE_TEST_ROLE"
	portEnv    = "HYDRA_SELFUPDATE_TEST_PORTFILE"
	prePIDEnv  = "HYDRA_SELFUPDATE_TEST_PREPIDFILE"
	markerFile = "restarted"
)

func TestMain(m *testing.M) {
	if os.Getenv(roleEnv) == "child" {
		runChild()
		return
	}
	os.Exit(m.Run())
}

// runChild is both halves of a restart. On first entry it binds a socket and
// re-execs itself; on the far side of that exec InheritedListener finds the
// socket and it starts serving, reporting the PID it is running as.
func runChild() {
	if ln := InheritedListener(); ln != nil {
		// Post-exec image. Answer with our PID so the parent can compare.
		srv := &http.Server{
			Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				fmt.Fprintf(w, "pid=%d", os.Getpid())
			}),
			ReadHeaderTimeout: 5 * time.Second,
		}
		_ = srv.Serve(ln)
		return
	}

	// Pre-exec image: bind, publish the port and our PID, then hand the socket
	// over to the process we are about to become.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		fmt.Fprintln(os.Stderr, "child listen:", err)
		os.Exit(1)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	if err := os.WriteFile(os.Getenv(prePIDEnv), []byte(strconv.Itoa(os.Getpid())), 0o600); err != nil {
		fmt.Fprintln(os.Stderr, "child write pid:", err)
		os.Exit(1)
	}
	if err := os.WriteFile(os.Getenv(portEnv), []byte(strconv.Itoa(port)), 0o600); err != nil {
		fmt.Fprintln(os.Stderr, "child write port:", err)
		os.Exit(1)
	}

	f, env, err := KeepListener(ln)
	if err != nil {
		fmt.Fprintln(os.Stderr, "child KeepListener:", err)
		os.Exit(1)
	}
	if err := execSelf(os.Args[0], []*os.File{f}, env); err != nil {
		fmt.Fprintln(os.Stderr, "child execSelf:", err)
		os.Exit(1)
	}
}

// TestRestartKeepsPIDAndListener is the end-to-end check: after the restart the
// same process (same PID) is serving on the same socket, and no rebind happened.
func TestRestartKeepsPIDAndListener(t *testing.T) {
	dir := t.TempDir()
	portFile := filepath.Join(dir, "port")
	prePIDFile := filepath.Join(dir, "prepid")

	cmd := exec.Command(os.Args[0])
	cmd.Env = append(os.Environ(),
		roleEnv+"=child",
		portEnv+"="+portFile,
		prePIDEnv+"="+prePIDFile,
	)
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatalf("start child: %v", err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
	})

	port := waitForFile(t, portFile)
	prePID := waitForFile(t, prePIDFile)

	// The child's PID as the parent sees it must be the PID it reported before
	// the exec - exec replaces the image, not the process.
	if got := strconv.Itoa(cmd.Process.Pid); got != prePID {
		t.Fatalf("child reported pid %s but we spawned %s", prePID, got)
	}

	body := getWithRetry(t, "http://127.0.0.1:"+port+"/")
	wantPID := "pid=" + prePID
	if body != wantPID {
		t.Fatalf("server after restart says %q, want %q - the process was replaced rather than re-execed", body, wantPID)
	}
}

// TestInheritedListenerAbsentOnFreshStart: a normal start must not go looking
// for a handed-over socket, and must clear the variable so nothing we later
// spawn inherits a stale descriptor number.
func TestInheritedListenerAbsentOnFreshStart(t *testing.T) {
	t.Setenv(ListenerFDEnv, "")
	if ln := InheritedListener(); ln != nil {
		_ = ln.Close()
		t.Fatal("InheritedListener returned a listener with no handover in the environment")
	}

	t.Setenv(ListenerFDEnv, "not-a-number")
	if ln := InheritedListener(); ln != nil {
		_ = ln.Close()
		t.Fatal("InheritedListener accepted a malformed descriptor number")
	}
	if os.Getenv(ListenerFDEnv) != "" {
		t.Error("ListenerFDEnv survived InheritedListener; a child process would inherit a stale fd number")
	}
}

// TestKeepListenerClearsCloseOnExec is the specific property that makes the
// handover possible: Go marks everything it opens close-on-exec, so without
// clearing that flag the socket would vanish at the exec.
func TestKeepListenerClearsCloseOnExec(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	f, env, err := KeepListener(ln)
	if err != nil {
		t.Fatalf("KeepListener: %v", err)
	}
	defer f.Close()

	if len(env) != 1 || !strings.HasPrefix(env[0], ListenerFDEnv+"=") {
		t.Fatalf("env = %v, want a single %s= entry", env, ListenerFDEnv)
	}
	if got := strings.TrimPrefix(env[0], ListenerFDEnv+"="); got != strconv.Itoa(int(f.Fd())) {
		t.Errorf("env names fd %s but the file is fd %d", got, f.Fd())
	}
	if closeOnExec(t, int(f.Fd())) {
		t.Error("descriptor is still close-on-exec; it would not survive the restart")
	}
}

func waitForFile(t *testing.T, path string) string {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if data, err := os.ReadFile(path); err == nil && len(data) > 0 {
			return strings.TrimSpace(string(data))
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", path)
	return ""
}

func getWithRetry(t *testing.T, url string) string {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	var lastErr error
	for time.Now().Before(deadline) {
		resp, err := http.Get(url) //nolint:noctx // short-lived test request
		if err == nil {
			body, _ := io.ReadAll(resp.Body)
			_ = resp.Body.Close()
			return strings.TrimSpace(string(body))
		}
		lastErr = err
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timed out requesting %s: %v", url, lastErr)
	return ""
}
