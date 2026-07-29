package http

import (
	"bytes"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gorilla/websocket"
)

// firstFrameOverWS runs send against a live socket and returns the first text
// frame the client receives.
func firstFrameOverWS(t *testing.T, send func(*safeConn)) []byte {
	t.Helper()
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		send(&safeConn{Conn: raw})
		_ = raw.Close()
	}))
	defer srv.Close()

	cli, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer cli.Close()
	_, data, err := cli.ReadMessage()
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	return data
}

// A chat socket has no fallback once the normalized log can't be opened: the
// raw provider relay is gone, so the connection renders nothing. That has to
// reach both the operator (the daemon log) and the user (a frame the chat turns
// into a banner) - a silently empty transcript is indistinguishable from a head
// that never said anything.
func TestSendChatErrorReportsToClientAndLog(t *testing.T) {
	var buf bytes.Buffer
	origOut := log.Writer()
	log.SetOutput(&buf)
	defer log.SetOutput(origOut)

	data := firstFrameOverWS(t, func(conn *safeConn) {
		sendChatError(conn, "head-7", "watch normalized events", errors.New("store is on fire"))
	})

	var frame struct {
		Type  string `json:"type"`
		Error string `json:"error"`
	}
	if err := json.Unmarshal(data, &frame); err != nil {
		t.Fatalf("unmarshal frame: %v", err)
	}
	if frame.Type != "chat_error" {
		t.Fatalf("frame type = %q, want chat_error", frame.Type)
	}
	if !strings.Contains(frame.Error, "watch normalized events") || !strings.Contains(frame.Error, "store is on fire") {
		t.Fatalf("frame error = %q, want it to name the step and the cause", frame.Error)
	}

	logged := buf.String()
	for _, want := range []string{"ERROR", "head-7", "watch normalized events", "store is on fire"} {
		if !strings.Contains(logged, want) {
			t.Fatalf("daemon log = %q, want it to contain %q", logged, want)
		}
	}
}
