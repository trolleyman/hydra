//go:build !windows

package usage

import (
	"context"
	"io"
	"log"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"

	"braces.dev/errtrace"
	"github.com/charmbracelet/x/vt"
	"github.com/creack/pty"
)

const (
	probeCols = 100
	// probeIdle is how long the screen must be quiet (no new bytes) before we give
	// up on it. The `/usage` screen never exits on its own, so this is the backstop
	// that ends a probe whose quota block never appeared. It has to be generous -
	// the CLI prints its banner, then goes quiet for a beat while it starts up and
	// again while it fetches quota - and being generous is free, because the
	// success path doesn't wait for it: the loop stops the moment both quota bars
	// are readable (see the scan() call below).
	probeIdle = 3 * time.Second
	// probeMax bounds the whole probe regardless of CLI behaviour.
	probeMax = 15 * time.Second
	// probeKillGrace is how long after probeMax the watchdog waits before tearing
	// the emulator and PTY down from underneath the read loop. It only fires if
	// the loop is wedged somewhere it can't observe ctx (see startWatchdog).
	probeKillGrace = 3 * time.Second
	// renderThrottle caps how often we re-render the emulator grid to plain text
	// and re-scan it. The `/usage` TUI animates while quota loads, emitting many
	// tiny chunks; rendering the whole grid on every chunk pegged a CPU core for
	// the length of the probe. Throttling bounds that to a handful of renders per
	// second without affecting idle detection (idle is reset on raw bytes, not on
	// renders) or prompt latency.
	renderThrottle = 200 * time.Millisecond
	// probeMaxBytes caps how much output we will feed the emulator. A CLI stuck in
	// a repaint loop would otherwise spin us until probeMax burning CPU; past this
	// much output the screen is either parseable already or never will be.
	probeMaxBytes = 4 << 20
	// maxPromptAnswers caps how many Enter keypresses the probe will send, so a
	// screen that keeps matching a prompt fragment can't turn into a keystroke
	// firehose into an interactive CLI.
	maxPromptAnswers = 3
)

// probeVariant is one way of invoking the CLI. `--ax-screen-reader` renders the
// TUI as flat text with no animation or box drawing: about a third of the bytes,
// a fraction of the repaints, and far less to misparse. It is a recent flag, so
// when the CLI rejects it we fall back to driving the ordinary TUI.
type probeVariant struct {
	name string
	args []string
	// rows is the emulator height. Screen-reader output is a linear transcript
	// that scrolls, so it needs a grid tall enough to still hold the quota block
	// at the end; the ordinary TUI paints one screenful in place, and giving it a
	// huge terminal would only make it repaint more.
	rows int
}

var (
	screenReaderVariant = probeVariant{
		name: "screen-reader",
		args: []string{"--ax-screen-reader", "/usage", "--allowed-tools", ""},
		rows: 200,
	}
	legacyTUIVariant = probeVariant{
		name: "tui",
		args: []string{"/usage", "--allowed-tools", ""},
		rows: 50,
	}
)

// promptResponses are TUI prompt fragments the probe answers with Enter, so a
// trust/onboarding dialog doesn't block `/usage` from rendering. Kept deliberately
// narrow: the `/usage` screen itself carries hints ("Esc to cancel") that earlier
// versions of this list matched, and pressing Enter on the usage screen dismisses
// the very thing we came to read.
var promptResponses = []string{
	"Do you trust",
	"Yes, I trust this folder",
	"Ready to code here?",
	"Press Enter to continue",
}

// HostEnv returns the daemon's environment with CLAUDE_CODE_OAUTH_TOKEN removed
// and a sane TERM, so `claude /usage` falls back to the full-scope `claude
// login` credentials (setup-tokens only carry user:inference scope and can't
// read quota - see ClaudeBar's note).
func HostEnv() []string {
	out := make([]string, 0, len(os.Environ())+2)
	var hasTerm bool
	for _, kv := range os.Environ() {
		if strings.HasPrefix(kv, "CLAUDE_CODE_OAUTH_TOKEN=") {
			continue
		}
		if strings.HasPrefix(kv, "TERM=") {
			hasTerm = true
		}
		out = append(out, kv)
	}
	if !hasTerm {
		out = append(out, "TERM=xterm-256color")
	}
	return out
}

// Probe runs `claude /usage` under a PTY, renders the TUI through a virtual
// terminal, and parses the screen into a Snapshot. bin is the CLI name/path,
// workDir its working directory, env its environment (see HostEnv). A missing
// CLI is reported as an unavailable Snapshot, not an error.
func Probe(ctx context.Context, bin, workDir string, env []string) (Snapshot, error) {
	path, err := exec.LookPath(bin)
	if err != nil {
		return Snapshot{CapturedAt: time.Now(), Error: "claude CLI not found in PATH", Permanent: true}, nil
	}

	snap, screen, err := probeOnce(ctx, path, workDir, env, screenReaderVariant)
	if err != nil {
		return Snapshot{}, errtrace.Wrap(err)
	}
	// An older CLI rejects --ax-screen-reader outright (and exits in ~100ms, so
	// this costs next to nothing). Retry on the ordinary TUI once.
	if !snap.Available && strings.Contains(screen, "unknown option") {
		log.Printf("usage: CLI rejected --ax-screen-reader; retrying on the plain TUI")
		snap, _, err = probeOnce(ctx, path, workDir, env, legacyTUIVariant)
		if err != nil {
			return Snapshot{}, errtrace.Wrap(err)
		}
	}
	return snap, nil
}

// probeOnce runs a single CLI invocation and returns the parsed snapshot along
// with the rendered screen it was parsed from (the screen is what lets the caller
// tell "this CLI doesn't know the flag" from "the quota block never appeared").
func probeOnce(ctx context.Context, path, workDir string, env []string, v probeVariant) (Snapshot, string, error) {
	ctx, cancel := context.WithTimeout(ctx, probeMax)
	defer cancel()

	cmd := exec.CommandContext(ctx, path, v.args...)
	cmd.Env = env
	cmd.Dir = workDir
	// Wait must not outlive the probe: with the PTY closed there is nothing left
	// to copy, but this makes it unconditional.
	cmd.WaitDelay = time.Second

	start := time.Now()
	log.Printf("usage: probe start: bin=%q dir=%q variant=%s (idle=%s, max=%s)", path, workDir, v.name, probeIdle, probeMax)

	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: uint16(v.rows), Cols: probeCols}) //nolint:gosec // rows are small constants
	if err != nil {
		log.Printf("usage: probe failed to start PTY: %v", err)
		return Snapshot{}, "", errtrace.Wrap(err)
	}

	em := vt.NewEmulator(probeCols, v.rows)

	// done lets the helper goroutines exit promptly when the main loop stops
	// consuming (idle/timeout/early exit), so neither can be stranded.
	done := make(chan struct{})
	var closeOnce sync.Once
	stop := func() { closeOnce.Do(func() { close(done) }) }

	defer func() {
		stop()
		closeReplies(em)
		_ = ptmx.Close()
		if cmd.Process != nil {
			// Kill the whole process group, not just the direct child: `claude` is
			// a Node app that spawns helper processes, and SIGKILL to only the
			// leader would orphan them - repeated probes would then accumulate
			// stray `claude`/node processes. pty.Start puts the child in its own
			// session (pgid == pid), so a negative-pid signal hits the group.
			if err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); err != nil {
				_ = cmd.Process.Kill() // fall back to the lone process
			}
		}
		_ = cmd.Wait()
	}()

	// The CLI queries the terminal on startup (primary device attributes, cursor
	// position, ...). The emulator answers those queries by writing into an
	// unbuffered io.Pipe, so unless something reads that pipe the FIRST query
	// wedges em.Write forever - which is exactly what used to hang this probe (and,
	// through the cache mutex, every request behind it). Copy the replies back to
	// the PTY, which is both the unblock and the correct terminal behaviour: the
	// CLI is waiting for those answers.
	go func() {
		buf := make([]byte, 256)
		for {
			n, rerr := em.Read(buf)
			if n > 0 {
				select {
				case <-done:
					return
				default:
				}
				_, _ = ptmx.Write(buf[:n])
			}
			if rerr != nil {
				return
			}
		}
	}()

	// Backstop: em.Write is not interruptible by ctx, so if it ever blocks again
	// for a reason the reply drain doesn't cover, only tearing things down from
	// outside can free it. Closing the reply channel is what does that - a query
	// handler writing into a closed pipe fails instead of waiting for a reader.
	watchdog := time.AfterFunc(probeMax+probeKillGrace, func() {
		log.Printf("usage: probe watchdog fired after %s; tearing down", probeMax+probeKillGrace)
		closeReplies(em)
		_ = ptmx.Close()
		if cmd.Process != nil {
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		}
	})
	defer watchdog.Stop()

	chunks := make(chan []byte, 16)
	go func() {
		buf := make([]byte, 8192)
		for {
			n, rerr := ptmx.Read(buf)
			if n > 0 {
				c := make([]byte, n)
				copy(c, buf[:n])
				select {
				case chunks <- c:
				case <-done:
					return
				}
			}
			if rerr != nil {
				close(chunks)
				return
			}
		}
	}()

	responded := make(map[string]bool)
	answers := 0
	idle := time.NewTimer(probeIdle)
	defer idle.Stop()

	var (
		totalBytes int
		renders    int
		lastRender time.Time
		reason     string
		screen     string
		snap       Snapshot
	)
	// scan re-derives the screen text, answers any newly-visible prompt, and
	// reparses. It is throttled (see renderThrottle) unless force is set, so a
	// chatty TUI can't drive an unbounded number of full-grid renders. It returns
	// true once the screen holds a complete snapshot, which ends the probe without
	// waiting out the idle timer.
	scan := func(force bool) bool {
		if !force && time.Since(lastRender) < renderThrottle {
			return false
		}
		lastRender = time.Now()
		renders++
		screen = renderPlain(em, v.rows)
		for _, p := range promptResponses {
			if !responded[p] && answers < maxPromptAnswers && strings.Contains(screen, p) {
				responded[p] = true
				answers++
				log.Printf("usage: probe answering prompt %q with Enter", p)
				_, _ = ptmx.Write([]byte("\r"))
			}
		}
		snap = Parse(screen, time.Now())
		return snap.Complete()
	}

loop:
	for {
		select {
		case c, ok := <-chunks:
			if !ok {
				reason = "cli-exited"
				scan(true)
				break loop
			}
			totalBytes += len(c)
			_, _ = em.Write(c)
			// Drain any other chunks already buffered before rendering, so a burst
			// of small writes collapses into a single render pass.
			for drained := true; drained; {
				select {
				case c2, ok2 := <-chunks:
					if !ok2 {
						reason = "cli-exited"
						scan(true)
						break loop
					}
					totalBytes += len(c2)
					_, _ = em.Write(c2)
				default:
					drained = false
				}
			}
			if scan(false) {
				reason = "parsed"
				break loop
			}
			if totalBytes > probeMaxBytes {
				reason = "byte-cap"
				scan(true)
				break loop
			}
			if !idle.Stop() {
				select {
				case <-idle.C:
				default:
				}
			}
			idle.Reset(probeIdle)
		case <-idle.C:
			reason = "settled"
			break loop // screen settled
		case <-ctx.Done():
			// Distinguish the overall timeout from caller/shutdown cancellation.
			if time.Since(start) >= probeMax-50*time.Millisecond {
				reason = "timeout"
			} else {
				reason = "cancelled"
			}
			break loop
		}
	}

	if reason != "parsed" {
		// The loop may have exited before the throttle let a scan through.
		scan(true)
	}
	snap.CapturedAt = time.Now()
	log.Printf("usage: probe done: variant=%s reason=%s dur=%s bytes=%d renders=%d available=%t error=%q",
		v.name, reason, time.Since(start).Round(time.Millisecond), totalBytes, renders, snap.Available, snap.Error)
	if !snap.Available {
		// The screen didn't parse into usable quota - log a compact preview so a
		// future TUI restyle (or an auth/onboarding wall) is diagnosable from logs.
		log.Printf("usage: probe screen preview (unparsed):\n%s", screenPreview(screen))
	}
	return snap, screen, nil
}

// closeReplies shuts the emulator's reply channel: the io.Pipe its query
// handlers write into. Closing it from the writer side ends the drain goroutine
// (whose Read returns EOF) and makes any later reply write fail fast instead of
// waiting for a reader that is no longer there.
//
// Deliberately NOT vt.Emulator.Close, which would do the same job: that flips an
// unsynchronised `closed` field which the drain goroutine reads on every Read -
// a data race the race detector rightly flags. An *io.PipeWriter is safe to
// close from another goroutine, so we close that instead.
func closeReplies(em *vt.Emulator) {
	if pw, ok := em.InputPipe().(*io.PipeWriter); ok {
		_ = pw.CloseWithError(io.EOF)
		return
	}
	// The drain goroutine can only be woken by closing the pipe, so if vt ever
	// stops handing one out, say so rather than leaking silently.
	log.Printf("usage: vt.Emulator.InputPipe is no longer an *io.PipeWriter; the probe's reply drain will outlive it")
}

// screenPreview trims a rendered screen to its non-blank lines (capped) for
// logging, so an unparsed `/usage` screen is diagnosable without dumping the
// full grid of mostly-empty lines.
func screenPreview(screen string) string {
	var out []string
	for line := range strings.SplitSeq(screen, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		out = append(out, line)
		if len(out) >= 20 {
			out = append(out, "... (truncated)")
			break
		}
	}
	return strings.Join(out, "\n")
}

// renderPlain reads the emulator's screen grid into plain text (one line per
// row, trailing spaces trimmed), discarding styling and box glyphs' colour.
func renderPlain(em *vt.Emulator, rows int) string {
	var b strings.Builder
	for y := range rows {
		var line strings.Builder
		for x := range probeCols {
			c := em.CellAt(x, y)
			if c == nil || c.Content == "" {
				line.WriteByte(' ')
			} else {
				line.WriteString(c.Content)
			}
		}
		b.WriteString(strings.TrimRight(line.String(), " "))
		b.WriteByte('\n')
	}
	return b.String()
}
