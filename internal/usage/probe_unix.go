//go:build !windows

package usage

import (
	"context"
	"os"
	"os/exec"
	"strings"
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

	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: probeRows, Cols: probeCols})
	if err != nil {
		return Snapshot{}, errtrace.Wrap(err)
	}
	defer func() {
		_ = ptmx.Close()
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
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

loop:
	for {
		select {
		case c, ok := <-chunks:
			if !ok {
				break loop // CLI exited
			}
			_, _ = em.Write(c)
			screen := renderPlain(em)
			for _, p := range promptResponses {
				if !responded[p] && strings.Contains(screen, p) {
					responded[p] = true
					_, _ = ptmx.Write([]byte("\r"))
				}
			}
			if !idle.Stop() {
				select {
				case <-idle.C:
				default:
				}
			}
			idle.Reset(probeIdle)
		case <-idle.C:
			break loop // screen settled
		case <-ctx.Done():
			break loop
		}
	}

	return Parse(renderPlain(em), time.Now()), nil
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
