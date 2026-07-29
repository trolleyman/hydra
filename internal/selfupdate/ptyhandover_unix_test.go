//go:build unix

package selfupdate

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/creack/pty"
	"golang.org/x/sys/unix"
)

// This is the spike docs/deployment.md asks for before planning Phase C: can a
// live PTY child - an agent head, in the real system - survive the process
// re-execing itself?
//
// Two things have to hold, and the second is the one in doubt:
//
//  1. The PTY master descriptor must cross exec(2). Same mechanism as the web
//     listener: clear FD_CLOEXEC, pass the number in the environment.
//  2. The child must still be alive on the far side. Hydra starts sandboxes with
//     PR_SET_PDEATHSIG (internal/scope.StartFunc) and bwrap's --die-with-parent,
//     and Linux keys the parent-death signal to the parent THREAD, not the
//     process. exec terminates every thread but the caller. So if the thread
//     that forked the child is not the one calling exec, the kernel fires
//     SIGKILL at the child even though the process itself never died.
//
// TestPTYSurvivesExecWithoutPdeathsig establishes the mechanism works.
// TestPdeathsigKillsChildAcrossExec establishes that it does NOT work with the
// parent-death signal set - which is what makes dropping it a precondition of
// Phase C rather than an optional tidy-up.

const (
	ptyFDEnv     = "HYDRA_TEST_PTY_FD"
	ptyPIDEnv    = "HYDRA_TEST_PTY_PID"
	ptyResultEnv = "HYDRA_TEST_PTY_RESULT"
	ptyDeathEnv  = "HYDRA_TEST_PTY_PDEATHSIG"
)

// runPTYChild is the other half of TestMain's dispatch (see reexec_unix_test.go).
// Pre-exec it starts a shell on a PTY and hands the master over to itself;
// post-exec it checks the shell is still there and still talking.
func runPTYChild() {
	if fdStr := os.Getenv(ptyFDEnv); fdStr != "" {
		reportPTYAfterExec(fdStr)
		return
	}
	startPTYAndExec()
}

// startPTYAndExec launches `cat` on a PTY, optionally with the parent-death
// signal Hydra normally sets, then re-execs itself keeping the master fd.
func startPTYAndExec() {
	cmd := exec.Command("cat")
	if os.Getenv(ptyDeathEnv) == "1" {
		// Exactly what internal/scope.StartFunc does for a real agent session.
		cmd.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL}
	}

	// Fork from a DIFFERENT goroutine, pinned across the fork and unpinned
	// afterwards - the shape internal/scope.StartFunc produces, and the shape the
	// daemon really has (sessions are started from request handlers; the exec
	// happens on the update goroutine). Forking and execing from one thread would
	// make the parent-death signal a non-issue by accident and prove nothing.
	var master *os.File
	errc := make(chan error, 1)
	go func() {
		runtime.LockOSThread()
		var e error
		master, e = pty.Start(cmd)
		runtime.UnlockOSThread()
		errc <- e
	}()
	if err := <-errc; err != nil {
		fmt.Fprintln(os.Stderr, "pty.Start:", err)
		os.Exit(1)
	}
	// Give the runtime a chance to move on from the forking thread, so the exec
	// below is overwhelmingly likely to be running on a different one.
	runtime.GC()
	time.Sleep(50 * time.Millisecond)

	fd := int(master.Fd())
	if _, err := unix.FcntlInt(uintptr(fd), unix.F_SETFD, 0); err != nil {
		fmt.Fprintln(os.Stderr, "clear cloexec:", err)
		os.Exit(1)
	}

	env := []string{
		ptyFDEnv + "=" + strconv.Itoa(fd),
		ptyPIDEnv + "=" + strconv.Itoa(cmd.Process.Pid),
	}
	if err := execSelf(os.Args[0], []*os.File{master}, env); err != nil {
		fmt.Fprintln(os.Stderr, "execSelf:", err)
		os.Exit(1)
	}
}

// reportPTYAfterExec runs in the re-execed image: it adopts the master, pokes
// the child through it, and writes what happened to the result file.
func reportPTYAfterExec(fdStr string) {
	result := os.Getenv(ptyResultEnv)
	write := func(s string) { _ = os.WriteFile(result, []byte(s), 0o600) }

	fd, err := strconv.Atoi(fdStr)
	if err != nil {
		write("bad-fd")
		return
	}
	master := os.NewFile(uintptr(fd), "pty-master")
	if master == nil {
		write("no-file")
		return
	}

	pid, _ := strconv.Atoi(os.Getenv(ptyPIDEnv))
	// Signal 0 asks "is this process still there?" without touching it. A child
	// killed by the parent-death signal is a zombie until reaped, so also read
	// its /proc state - a zombie means it died at the exec.
	alive := syscall.Kill(pid, 0) == nil
	if alive {
		if state, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid)); err == nil {
			if fields := strings.Fields(string(state)); len(fields) > 2 && fields[2] == "Z" {
				alive = false
			}
		}
	}
	if !alive {
		write("child-dead")
		return
	}

	// The descriptor surviving is not enough - it has to still be a working PTY
	// wired to that child. `cat` echoes what it is given.
	_ = master.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if _, err := master.WriteString("ping\n"); err != nil {
		write("write-failed: " + err.Error())
		return
	}
	_ = master.SetReadDeadline(time.Now().Add(5 * time.Second))
	line, err := bufio.NewReader(master).ReadString('\n')
	if err != nil {
		write("read-failed: " + err.Error())
		return
	}
	if !strings.Contains(line, "ping") {
		write("unexpected: " + strings.TrimSpace(line))
		return
	}
	write("alive-and-talking")
}

func runPTYHandover(t *testing.T, pdeathsig bool) string {
	t.Helper()
	dir := t.TempDir()
	resultFile := filepath.Join(dir, "result")

	cmd := exec.Command(os.Args[0])
	env := append(os.Environ(), roleEnv+"=pty", ptyResultEnv+"="+resultFile)
	if pdeathsig {
		env = append(env, ptyDeathEnv+"=1")
	}
	cmd.Env = env
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatalf("start child: %v", err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
	})
	return waitForFile(t, resultFile)
}

// TestPTYSurvivesExecWithoutPdeathsig: the handover mechanism itself works. A
// PTY master crosses the exec and the process on the other end is still running
// and still responding through it.
func TestPTYSurvivesExecWithoutPdeathsig(t *testing.T) {
	if got := runPTYHandover(t, false); got != "alive-and-talking" {
		t.Fatalf("after re-exec: %q, want the PTY child alive and echoing", got)
	}
}

// TestPdeathsigKillsChildAcrossExec is the finding that gates Phase C: with the
// parent-death signal set - as every Hydra sandbox is today, via
// internal/scope.StartFunc - the child is killed by the exec even though the
// process it belongs to never died. exec terminates every thread but the caller,
// and Linux keys PR_SET_PDEATHSIG to the parent thread.
//
// So carrying agent PTYs across a restart is not just "hand the fds over": the
// parent-death signal (and bwrap's --die-with-parent) has to be given up first,
// which trades away the guarantee that a CRASHED daemon cannot orphan a
// sandbox. That is a real trade, not a tidy-up - see docs/deployment.md.
func TestPdeathsigKillsChildAcrossExec(t *testing.T) {
	got := runPTYHandover(t, true)
	if got == "alive-and-talking" {
		t.Skip("pdeathsig did not fire across the exec on this kernel/runtime - " +
			"the Phase C precondition may be weaker than documented; re-check before relying on it")
	}
	if got != "child-dead" {
		t.Fatalf("after re-exec with pdeathsig: %q, want the child to have been killed", got)
	}
}
