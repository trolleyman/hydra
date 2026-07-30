//go:build !windows

package nshost

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"

	"braces.dev/errtrace"
	"github.com/creack/pty"
)

// Serve runs the supervisor: it listens on socketPath and handles each incoming
// connection as one spawn request. It is meant to run as pid-1 inside the
// namespace host's bwrap (see `hydra __sandbox-init`). Blocks until the listener
// fails (e.g. the daemon tears the host down).
func Serve(socketPath string) error {
	_ = os.Remove(socketPath)
	ln, err := net.Listen("unix", socketPath)
	if err != nil {
		return errtrace.Wrap(fmt.Errorf("listen %s: %w", socketPath, err))
	}
	defer ln.Close()
	for {
		c, err := ln.Accept()
		if err != nil {
			return errtrace.Wrap(err)
		}
		uc, ok := c.(*net.UnixConn)
		if !ok {
			_ = c.Close()
			continue
		}
		go handleConn(uc)
	}
}

// handleConn services one spawned child for the lifetime of the connection:
// read the request, launch a PTY child, pass the master fd back, relay signals,
// and report exit.
func handleConn(c *net.UnixConn) {
	defer c.Close()
	r := bufio.NewReader(c)

	line, err := r.ReadBytes('\n')
	if err != nil {
		return
	}
	var req SpawnRequest
	if err := json.Unmarshal(line, &req); err != nil || len(req.Argv) == 0 {
		_ = writeReply(c, spawnReply{Err: "bad spawn request"}, -1)
		return
	}

	cmd := exec.Command(req.Argv[0], req.Argv[1:]...)
	cmd.Env = req.Env
	cmd.Dir = req.Cwd
	if req.Pipes {
		if !startPipesChild(c, cmd, req.StderrPrefix) {
			return
		}
	} else {
		rows, cols := req.Rows, req.Cols
		if rows == 0 {
			rows = 24
		}
		if cols == 0 {
			cols = 80
		}
		master, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: rows, Cols: cols})
		if err != nil {
			_ = writeReply(c, spawnReply{Err: err.Error()})
			return
		}

		if err := writeReply(c, spawnReply{OK: true, Pid: cmd.Process.Pid}, int(master.Fd())); err != nil {
			_ = master.Close()
			_ = cmd.Process.Kill()
			_, _ = cmd.Process.Wait()
			return
		}
		// The daemon now holds a dup of the master via SCM_RIGHTS; the supervisor
		// keeps no master fd so that the daemon closing its copy is what delivers
		// SIGHUP to the child. The child's slave keeps the pty alive until then.
		_ = master.Close()
	}

	// Relay signal requests from the daemon until the connection closes.
	go func() {
		for {
			cl, err := r.ReadBytes('\n')
			if err != nil {
				return
			}
			var ctl control
			if json.Unmarshal(cl, &ctl) == nil && ctl.Signal != 0 {
				_ = cmd.Process.Signal(syscall.Signal(ctl.Signal))
			}
		}
	}()

	werr := cmd.Wait()
	_ = writeLine(c, event{Exited: true, ExitCode: exitCode(werr)})
}

// startPipesChild launches the child on plain stdin/stdout pipes (SpawnRequest
// Pipes mode) and passes the daemon the stdin-write and stdout-read ends. The
// child's stderr is diagnostics, not protocol: it folds into the supervisor's
// stderr, which the daemon folds into its log. Reports false when the spawn
// failed or the reply could not be delivered (the connection is then dead and
// the caller must not wait on the child's exit relay).
func startPipesChild(c *net.UnixConn, cmd *exec.Cmd, stderrPrefix string) bool {
	stdinR, stdinW, err := os.Pipe()
	if err != nil {
		_ = writeReply(c, spawnReply{Err: err.Error()})
		return false
	}
	stdoutR, stdoutW, err := os.Pipe()
	if err != nil {
		_ = stdinR.Close()
		_ = stdinW.Close()
		_ = writeReply(c, spawnReply{Err: err.Error()})
		return false
	}
	cmd.Stdin = stdinR
	cmd.Stdout = stdoutW
	cmd.Stderr = os.Stderr
	if stderrPrefix != "" {
		cmd.Stderr = &linePrefixWriter{dst: os.Stderr, prefix: []byte(stderrPrefix), lineStart: true}
	}
	if err := cmd.Start(); err != nil {
		for _, f := range []*os.File{stdinR, stdinW, stdoutR, stdoutW} {
			_ = f.Close()
		}
		_ = writeReply(c, spawnReply{Err: err.Error()})
		return false
	}
	// The child holds dups of its ends; drop the supervisor's copies so the
	// daemon's stdout read end EOFs when the child exits.
	_ = stdinR.Close()
	_ = stdoutW.Close()

	err = writeReply(c, spawnReply{OK: true, Pid: cmd.Process.Pid}, int(stdinW.Fd()), int(stdoutR.Fd()))
	// The daemon holds dups via SCM_RIGHTS (or the reply failed); either way the
	// supervisor keeps no pipe ends, so a daemon-side Close delivers stdin EOF.
	_ = stdinW.Close()
	_ = stdoutR.Close()
	if err != nil {
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
		return false
	}
	return true
}

// stderrWriteMu keeps prefixed writes from separate children of this supervisor
// intact on the shared stderr.
var stderrWriteMu sync.Mutex

type linePrefixWriter struct {
	dst       io.Writer
	prefix    []byte
	lineStart bool
}

func (w *linePrefixWriter) Write(p []byte) (int, error) {
	stderrWriteMu.Lock()
	defer stderrWriteMu.Unlock()

	inputLen := len(p)
	out := make([]byte, 0, len(p)+len(w.prefix))
	for len(p) > 0 {
		if w.lineStart {
			out = append(out, w.prefix...)
			w.lineStart = false
		}
		i := bytes.IndexByte(p, '\n')
		if i < 0 {
			out = append(out, p...)
			break
		}
		out = append(out, p[:i+1]...)
		p = p[i+1:]
		w.lineStart = true
	}
	n, err := w.dst.Write(out)
	if err != nil {
		return 0, errtrace.Wrap(err)
	}
	if n != len(out) {
		return 0, errtrace.Wrap(io.ErrShortWrite)
	}
	return inputLen, nil
}

// writeReply sends a JSON reply line, optionally carrying fds as an SCM_RIGHTS
// control message in the same datagram.
func writeReply(c *net.UnixConn, rep spawnReply, fds ...int) error {
	b, _ := json.Marshal(rep)
	b = append(b, '\n')
	var oob []byte
	if len(fds) > 0 {
		oob = syscall.UnixRights(fds...)
	}
	_, _, err := c.WriteMsgUnix(b, oob, nil)
	return errtrace.Wrap(err)
}

func writeLine(c *net.UnixConn, v any) error {
	b, _ := json.Marshal(v)
	b = append(b, '\n')
	_, err := c.Write(b)
	return errtrace.Wrap(err)
}

func exitCode(werr error) int {
	if werr == nil {
		return 0
	}
	var ee *exec.ExitError
	if errors.As(werr, &ee) {
		return ee.ExitCode()
	}
	return -1
}

// Client talks to a supervisor over its control socket.
type Client struct {
	socket string
}

// Dial returns a client for the supervisor listening at socketPath. It does not
// itself open a long-lived connection; each Spawn dials its own.
func Dial(socket string) *Client { return &Client{socket: socket} }

// WaitForSocket blocks until socketPath exists (the supervisor has begun
// listening) or timeout elapses.
func WaitForSocket(socketPath string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		if _, err := os.Stat(socketPath); err == nil {
			return nil
		}
		if time.Now().After(deadline) {
			return errtrace.Wrap(fmt.Errorf("nshost: control socket %s never appeared", socketPath))
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// Spawned is the daemon-side handle for one child running inside the namespace
// host. It satisfies the PTY shape the session layer expects (Read/Write/
// Resize/Wait/Signal/Pid/Close), backed by the child's master fd plus the
// control connection. In Pipes mode master is the stdout read end and in is
// the stdin write end; Resize is then a no-op.
type Spawned struct {
	master *os.File
	in     *os.File // Pipes mode only; nil when master is a real PTY
	conn   *net.UnixConn
	pid    int
	exitCh chan int
}

// Spawn launches a child inside the namespace host and returns its handle.
func (c *Client) Spawn(req SpawnRequest) (*Spawned, error) {
	conn, err := net.Dial("unix", c.socket)
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("dial supervisor: %w", err))
	}
	uc := conn.(*net.UnixConn)

	b, _ := json.Marshal(req)
	b = append(b, '\n')
	if _, err := uc.Write(b); err != nil {
		_ = uc.Close()
		return nil, errtrace.Wrap(err)
	}

	buf := make([]byte, 4096)
	oob := make([]byte, 256)
	n, oobn, _, _, err := uc.ReadMsgUnix(buf, oob)
	if err != nil {
		_ = uc.Close()
		return nil, errtrace.Wrap(err)
	}
	replyLine, leftover, found := bytes.Cut(buf[:n], []byte{'\n'})
	if !found {
		_ = uc.Close()
		return nil, errtrace.Wrap(fmt.Errorf("nshost: malformed reply"))
	}
	var rep spawnReply
	if err := json.Unmarshal(replyLine, &rep); err != nil {
		_ = uc.Close()
		return nil, errtrace.Wrap(err)
	}
	fds := parseRights(oob[:oobn])
	wantFds := 1
	if req.Pipes {
		wantFds = 2
	}
	if !rep.OK || len(fds) < wantFds {
		for _, fd := range fds {
			_ = syscall.Close(fd)
		}
		_ = uc.Close()
		if rep.Err == "" {
			rep.Err = "supervisor returned too few fds"
		}
		return nil, errtrace.Wrap(fmt.Errorf("nshost: spawn failed: %s", rep.Err))
	}

	sp := &Spawned{
		conn:   uc,
		pid:    rep.Pid,
		exitCh: make(chan int, 1),
	}
	if req.Pipes {
		sp.in = os.NewFile(uintptr(fds[0]), "nshost-stdin")
		sp.master = os.NewFile(uintptr(fds[1]), "nshost-stdout")
	} else {
		sp.master = os.NewFile(uintptr(fds[0]), "nshost-pty")
	}
	// Any bytes after the reply line belong to the event stream.
	go sp.readEvents(append([]byte(nil), leftover...))
	return sp, nil
}

func parseRights(oob []byte) []int {
	if len(oob) == 0 {
		return nil
	}
	scms, err := syscall.ParseSocketControlMessage(oob)
	if err != nil {
		return nil
	}
	var fds []int
	for _, scm := range scms {
		if got, err := syscall.ParseUnixRights(&scm); err == nil {
			fds = append(fds, got...)
		}
	}
	return fds
}

func (s *Spawned) readEvents(leftover []byte) {
	r := bufio.NewReader(io.MultiReader(bytes.NewReader(leftover), s.conn))
	for {
		line, err := r.ReadBytes('\n')
		if len(line) > 0 {
			var ev event
			if json.Unmarshal(line, &ev) == nil && ev.Exited {
				select {
				case s.exitCh <- ev.ExitCode:
				default:
				}
			}
		}
		if err != nil {
			// Connection closed without an explicit exit event: treat as exited.
			select {
			case s.exitCh <- -1:
			default:
			}
			return
		}
	}
}

func (s *Spawned) Read(b []byte) (int, error) { return s.master.Read(b) } //errtrace:skip

func (s *Spawned) Write(b []byte) (int, error) {
	if s.in != nil {
		return s.in.Write(b) //errtrace:skip
	}
	return s.master.Write(b) //errtrace:skip
}

// Close drops the daemon's fds (delivering SIGHUP to a PTY child, stdin EOF to
// a pipes child) and closes the control connection.
func (s *Spawned) Close() error {
	err := s.master.Close()
	if s.in != nil {
		_ = s.in.Close()
	}
	_ = s.conn.Close()
	return err //errtrace:skip
}

func (s *Spawned) Resize(rows, cols uint16) error {
	if s.in != nil {
		return nil // no terminal to resize in pipes mode
	}
	return errtrace.Wrap(pty.Setsize(s.master, &pty.Winsize{Rows: rows, Cols: cols}))
}

// Wait blocks until the supervisor reports the child has exited.
func (s *Spawned) Wait() error {
	<-s.exitCh
	return nil
}

func (s *Spawned) Pid() int { return s.pid }

// Signal asks the supervisor to deliver sig to the child.
func (s *Spawned) Signal(sig os.Signal) error {
	n := 15 // default SIGTERM
	if ss, ok := sig.(syscall.Signal); ok {
		n = int(ss)
	}
	b, _ := json.Marshal(control{Signal: n})
	b = append(b, '\n')
	_, err := s.conn.Write(b)
	return errtrace.Wrap(err)
}
