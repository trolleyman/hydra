//go:build !windows

package usage

import (
	"context"
	"log"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"

	"braces.dev/errtrace"
	"github.com/charmbracelet/x/vt"
	"github.com/creack/pty"
)

const (
	probeCols = 100
	probeRows = 40
	// probeIdle is how long the screen must be quiet (no new bytes) before we
	// consider the TUI settled and capture it. The `/usage` screen never exits
	// on its own, so this is what ends the probe in the common case.
	probeIdle = 1500 * time.Millisecond
	// probeMax bounds the whole probe regardless of CLI behaviour.
	probeMax = 20 * time.Second
	// renderThrottle caps how often we re-render the emulator grid to plain text
	// and re-scan for prompts. The `/usage` TUI animates (spinners while quota
	// loads), emitting many tiny chunks; rendering the full 100x40 grid on every
	// chunk pegged a CPU core for the whole probe. Throttling bounds that work to
	// a handful of renders per second without affecting idle detection (idle is
	// reset on raw bytes, not on renders) or prompt latency.
	renderThrottle = 150 * time.Millisecond
)

// promptResponses are TUI prompt fragments the probe answers with Enter, so a
// trust/onboarding dialog doesn't block `/usage` from rendering. Matches the
// fragments ClaudeBar handles.
var promptResponses = []string{
	"Esc to cancel",
	"Ready to code here?",
	"Press Enter to continue",
	"ctrl+t to disable",
	"Yes, I trust this folder",
	"Do you trust",
}

// HostEnv returns the daemon's environment with CLAUDE_CODE_OAUTH_TOKEN removed
// and a sane TERM, so `claude /usage` falls back to the full-scope `claude
// login` credentials (setup-tokens only carry user:inference scope and can't
// read quota — see ClaudeBar's note).
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
		return Snapshot{CapturedAt: time.Now(), Error: "claude CLI not found in PATH"}, nil
	}

	ctx, cancel := context.WithTimeout(ctx, probeMax)
	defer cancel()

	cmd := exec.CommandContext(ctx, path, "/usage", "--allowed-tools", "")
	cmd.Env = env
	cmd.Dir = workDir

	start := time.Now()
	log.Printf("usage: probe start: bin=%q dir=%q (idle=%s, max=%s)", path, workDir, probeIdle, probeMax)

	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: probeRows, Cols: probeCols})
	if err != nil {
		log.Printf("usage: probe failed to start PTY: %v", err)
		return Snapshot{}, errtrace.Wrap(err)
	}
	defer func() {
		_ = ptmx.Close()
		if cmd.Process != nil {
			// Kill the whole process group, not just the direct child: `claude` is
			// a Node app that spawns helper processes, and SIGKILL to only the
			// leader would orphan them — repeated probes would then accumulate
			// stray `claude`/node processes. pty.Start puts the child in its own
			// session (pgid == pid), so a negative-pid signal hits the group.
			if err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); err != nil {
				_ = cmd.Process.Kill() // fall back to the lone process
			}
		}
		_ = cmd.Wait()
	}()

	em := vt.NewEmulator(probeCols, probeRows)

	// done lets the reader goroutine exit promptly when the main loop stops
	// consuming (idle/timeout), so a full channel can't strand it.
	done := make(chan struct{})
	defer close(done)

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
	idle := time.NewTimer(probeIdle)
	defer idle.Stop()

	var (
		totalBytes int
		renders    int
		lastRender time.Time
		reason     string
	)
	// render re-derives the screen text and answers any newly-visible prompts. It
	// is throttled (see renderThrottle) unless force is set, so a chatty TUI can't
	// drive an unbounded number of full-grid renders. force is used on the final
	// render so the parse always sees the latest screen.
	render := func(force bool) {
		if !force && time.Since(lastRender) < renderThrottle {
			return
		}
		lastRender = time.Now()
		renders++
		screen := renderPlain(em)
		for _, p := range promptResponses {
			if !responded[p] && strings.Contains(screen, p) {
				responded[p] = true
				log.Printf("usage: probe answering prompt %q with Enter", p)
				_, _ = ptmx.Write([]byte("\r"))
			}
		}
	}

loop:
	for {
		select {
		case c, ok := <-chunks:
			if !ok {
				reason = "cli-exited"
				break loop // CLI exited
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
						render(true)
						break loop
					}
					totalBytes += len(c2)
					_, _ = em.Write(c2)
				default:
					drained = false
				}
			}
			render(false)
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

	snap := Parse(renderPlain(em), time.Now())
	log.Printf("usage: probe done: reason=%s dur=%s bytes=%d renders=%d available=%t error=%q",
		reason, time.Since(start).Round(time.Millisecond), totalBytes, renders, snap.Available, snap.Error)
	if !snap.Available {
		// The screen didn't parse into usable quota — log a compact preview so a
		// future TUI restyle (or an auth/onboarding wall) is diagnosable from logs.
		log.Printf("usage: probe screen preview (unparsed):\n%s", screenPreview(renderPlain(em)))
	}
	return snap, nil
}

// screenPreview trims a rendered screen to its non-blank lines (capped) for
// logging, so an unparsed `/usage` screen is diagnosable without dumping the
// full 40-row grid of mostly-empty lines.
func screenPreview(screen string) string {
	var out []string
	for _, line := range strings.Split(screen, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		out = append(out, line)
		if len(out) >= 20 {
			out = append(out, "… (truncated)")
			break
		}
	}
	return strings.Join(out, "\n")
}

// renderPlain reads the emulator's screen grid into plain text (one line per
// row, trailing spaces trimmed), discarding styling and box glyphs' colour.
func renderPlain(em *vt.Emulator) string {
	var b strings.Builder
	for y := range probeRows {
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
