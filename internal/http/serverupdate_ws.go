package http

import (
	"net/http"
	"time"

	"braces.dev/errtrace"
	"github.com/gorilla/websocket"
	"github.com/trolleyman/hydra/internal/selfupdate"
)

// HandleServerUpdateWS streams the progress of a self-update to the browser.
// URL: /ws/server/update
//
// Frames are selfupdate.Event verbatim: a "phase" naming the stage, a "log" per
// line of build output, and a terminal "done" carrying an error string if the
// build failed.
//
// The interesting property is how this connection ends. On success the server
// re-execs itself, so the socket dies mid-stream with no "done" frame - the
// client is expected to treat "closed after the restarting phase" as success and
// switch to polling /health, not to report an error. On failure the "done" frame
// arrives normally and the server is still here, because nothing was swapped.
//
// Subscribers get the events already emitted before they connected, so a tab
// that opens the panel late (or reloads) still sees the whole build.
func (s *Server) HandleServerUpdateWS(w http.ResponseWriter, r *http.Request) {
	if s.SelfUpdate == nil {
		http.Error(w, "self-update is not available", http.StatusNotFound)
		return
	}

	conn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return // Upgrade already wrote the error response.
	}
	defer conn.Close()

	events, unsubscribe := s.SelfUpdate.Subscribe()
	defer unsubscribe()

	// Reader goroutine: no application messages are expected, but reading is
	// what processes pongs and notices the client going away.
	done := make(chan struct{})
	go func() {
		defer close(done)
		conn.SetReadLimit(512)
		_ = conn.SetReadDeadline(time.Now().Add(pongWait))
		conn.SetPongHandler(func(string) error {
			return errtrace.Wrap(conn.SetReadDeadline(time.Now().Add(pongWait)))
		})
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}()

	ping := time.NewTicker(pingPeriod)
	defer ping.Stop()

	for {
		select {
		case <-done:
			return
		case <-r.Context().Done():
			return
		case ev, ok := <-events:
			if !ok {
				return
			}
			_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := conn.WriteJSON(ev); err != nil {
				return
			}
			// Flush the terminal frame and let the client close, rather than
			// holding a connection open for a job that has finished.
			if ev.Kind == selfupdate.KindDone {
				return
			}
		case <-ping.C:
			_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(10*time.Second)); err != nil {
				return
			}
		}
	}
}
