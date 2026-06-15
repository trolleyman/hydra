//go:build !windows

package cli

import (
	"encoding/json"
	"os"
	"os/signal"
	"syscall"

	"braces.dev/errtrace"
	"github.com/charmbracelet/x/term"
	"github.com/gorilla/websocket"
)

// attachWS connects the local terminal to an agent terminal websocket: it puts
// stdin in raw mode, streams session output to stdout, forwards keystrokes,
// reports window resizes, and detaches (without killing the agent) on Ctrl+C.
func attachWS(conn *websocket.Conn) error {
	defer conn.Close()

	sendResize := func() {
		if w, h, err := term.GetSize(os.Stdout.Fd()); err == nil {
			msg, _ := json.Marshal(map[string]any{"type": "resize", "cols": w, "rows": h})
			_ = conn.WriteMessage(websocket.TextMessage, msg)
		}
	}

	if old, err := term.MakeRaw(os.Stdin.Fd()); err == nil {
		defer term.Restore(os.Stdin.Fd(), old)
	}
	sendResize()

	winch := make(chan os.Signal, 1)
	signal.Notify(winch, syscall.SIGWINCH)
	defer signal.Stop(winch)
	go func() {
		for range winch {
			sendResize()
		}
	}()

	// stdin -> websocket (binary). Ctrl+C (0x03) detaches.
	done := make(chan struct{})
	go func() {
		defer close(done)
		buf := make([]byte, 4096)
		for {
			n, err := os.Stdin.Read(buf)
			if n > 0 {
				for i := 0; i < n; i++ {
					if buf[i] == 0x03 {
						if i > 0 {
							_ = conn.WriteMessage(websocket.BinaryMessage, buf[:i])
						}
						return
					}
				}
				if err := conn.WriteMessage(websocket.BinaryMessage, buf[:n]); err != nil {
					return
				}
			}
			if err != nil {
				return
			}
		}
	}()

	// websocket -> stdout. Binary frames are terminal output; text frames are
	// JSON status/diff events we ignore here.
	readErr := make(chan error, 1)
	go func() {
		for {
			mt, data, err := conn.ReadMessage()
			if err != nil {
				readErr <- err
				return
			}
			if mt == websocket.BinaryMessage {
				if _, err := os.Stdout.Write(data); err != nil {
					readErr <- err
					return
				}
			}
		}
	}()

	select {
	case <-done:
		return nil
	case err := <-readErr:
		if websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
			return nil
		}
		return errtrace.Wrap(err)
	}
}
