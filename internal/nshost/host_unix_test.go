//go:build !windows

package nshost

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestSupervisorSharedWrites proves the core namespace-host mechanism end to end
// without bwrap: one supervisor (Serve) spawns two PTY-attached children via the
// client, their master fds are passed back over the control socket, and - because
// both are children of the one supervisor - they write to the *same* filesystem.
// This is the property that, with a bwrap overlay underneath the supervisor,
// lets the agent and its bash terminals share one writable copy-on-write path.
//
// The overlay itself needs an overlay-capable bwrap and is exercised on a real
// host by the daemon's per-head namespace supervisor; here we validate the
// spawn/fd-passing/exit machinery that carries it.
func TestSupervisorSharedWrites(t *testing.T) {
	dir := t.TempDir()
	sock := filepath.Join(dir, "control.sock")
	go func() { _ = Serve(sock) }()
	if err := WaitForSocket(sock, 2*time.Second); err != nil {
		t.Fatalf("supervisor never listened: %v", err)
	}
	client := Dial(sock)

	shared := t.TempDir()
	out := filepath.Join(shared, "out.txt")

	spawnAppend := func(tag string) *Spawned {
		sp, err := client.Spawn(SpawnRequest{
			Argv: []string{"/bin/sh", "-c", "printf '%s\\n' " + tag + " >> " + out},
			Env:  os.Environ(),
			Cwd:  shared,
			Rows: 24, Cols: 80,
		})
		if err != nil {
			t.Fatalf("spawn %s: %v", tag, err)
		}
		return sp
	}

	for _, tag := range []string{"AAA", "BBB"} {
		sp := spawnAppend(tag)
		go func() { _, _ = io.Copy(io.Discard, sp) }() // drain pty so the child never blocks
		done := make(chan struct{})
		go func() { _ = sp.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatalf("child %s did not report exit", tag)
		}
		if pid := sp.Pid(); pid <= 0 {
			t.Errorf("child %s: expected a positive pid from the supervisor, got %d", tag, pid)
		}
		_ = sp.Close()
	}

	data, err := os.ReadFile(out)
	if err != nil {
		t.Fatalf("read shared output: %v", err)
	}
	got := string(data)
	if !strings.Contains(got, "AAA") || !strings.Contains(got, "BBB") {
		t.Fatalf("both children should have written to the shared file; got %q", got)
	}
}

// TestSpawnReportsExitCode verifies a non-zero child exit is propagated.
func TestSpawnReportsExitCode(t *testing.T) {
	dir := t.TempDir()
	sock := filepath.Join(dir, "control.sock")
	go func() { _ = Serve(sock) }()
	if err := WaitForSocket(sock, 2*time.Second); err != nil {
		t.Fatalf("supervisor never listened: %v", err)
	}
	client := Dial(sock)

	sp, err := client.Spawn(SpawnRequest{
		Argv: []string{"/bin/sh", "-c", "exit 7"},
		Env:  os.Environ(),
		Cwd:  dir,
		Rows: 24, Cols: 80,
	})
	if err != nil {
		t.Fatalf("spawn: %v", err)
	}
	go func() { _, _ = io.Copy(io.Discard, sp) }()
	code := <-sp.exitCh
	if code != 7 {
		t.Errorf("expected exit code 7, got %d", code)
	}
	_ = sp.Close()
}

// TestSpawnPipes exercises Pipes mode end to end: the child runs on plain
// stdin/stdout pipes (no PTY), both fds are passed back over the control
// socket, writes reach the child's stdin unechoed, its stdout comes back
// verbatim (no CRLF translation), and closing the daemon's handle delivers
// stdin EOF so the child exits.
func TestSpawnPipes(t *testing.T) {
	dir := t.TempDir()
	sock := filepath.Join(dir, "control.sock")
	go func() { _ = Serve(sock) }()
	if err := WaitForSocket(sock, 2*time.Second); err != nil {
		t.Fatalf("supervisor never listened: %v", err)
	}
	client := Dial(sock)

	sp, err := client.Spawn(SpawnRequest{
		Argv:  []string{"/bin/cat"},
		Env:   os.Environ(),
		Cwd:   dir,
		Pipes: true,
	})
	if err != nil {
		t.Fatalf("spawn cat: %v", err)
	}

	if _, err := sp.Write([]byte("{\"type\":\"user\"}\n")); err != nil {
		t.Fatalf("write to child stdin: %v", err)
	}
	buf := make([]byte, 64)
	n, err := sp.Read(buf)
	if err != nil {
		t.Fatalf("read child stdout: %v", err)
	}
	// A PTY would have echoed the input AND translated \n to \r\n; pipes must
	// return exactly what cat copied through.
	if got := string(buf[:n]); got != "{\"type\":\"user\"}\n" {
		t.Fatalf("stdout = %q, want the exact bytes written", got)
	}

	if err := sp.Resize(50, 100); err != nil {
		t.Errorf("Resize in pipes mode should be a no-op, got %v", err)
	}

	// Closing the daemon handle closes the child's stdin; cat exits on EOF.
	done := make(chan struct{})
	go func() { _ = sp.Wait(); close(done) }()
	_ = sp.Close()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("child did not exit after stdin EOF")
	}
}
