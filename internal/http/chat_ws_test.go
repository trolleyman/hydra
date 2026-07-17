package http

import (
	"bytes"
	"encoding/json"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gorilla/websocket"

	"github.com/trolleyman/hydra/internal/claudestream"
)

// relayChatChunkOverWS runs relayChatChunk (server side) on chunk with the given
// dropResults flag and returns the inner event `type` of every claude_event
// frame the client received, in order.
func relayChatChunkOverWS(t *testing.T, chunk string, dropResults bool) []string {
	t.Helper()
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		conn := &safeConn{Conn: raw}
		relayChatChunk(conn, &claudestream.LineBuffer{}, []byte(chunk), "agent", map[string]struct{}{}, nil, dropResults, nil, nil)
		_ = raw.Close()
	}))
	defer srv.Close()

	cli, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer cli.Close()

	var types []string
	for {
		_, data, err := cli.ReadMessage()
		if err != nil {
			break // server closed after relaying
		}
		var frame struct {
			Type  string          `json:"type"`
			Event json.RawMessage `json:"event"`
		}
		if json.Unmarshal(data, &frame) != nil || frame.Type != "claude_event" {
			continue
		}
		var inner struct {
			Type string `json:"type"`
		}
		_ = json.Unmarshal(frame.Event, &inner)
		types = append(types, inner.Type)
	}
	return types
}

func TestRelayChatChunkDropsResultsOnReplay(t *testing.T) {
	// A ring-snapshot replay carrying a past turn's assistant blocks + its result:
	// the result must be dropped (it would land misplaced at the conversation
	// bottom), the assistant lines kept.
	chunk := `{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"hi"}]}}` + "\n" +
		`{"type":"result","subtype":"success","duration_ms":48211}` + "\n" +
		`{"type":"assistant","message":{"id":"m2","content":[{"type":"text","text":"bye"}]}}` + "\n"

	dropped := relayChatChunkOverWS(t, chunk, true)
	for _, ty := range dropped {
		if ty == "result" {
			t.Fatalf("result relayed during replay, want dropped; got %v", dropped)
		}
	}
	if len(dropped) != 2 {
		t.Fatalf("relayed %v, want the two assistant events only", dropped)
	}

	// Live (dropResults=false): the result is kept and streamed in order.
	kept := relayChatChunkOverWS(t, chunk, false)
	sawResult := false
	for _, ty := range kept {
		if ty == "result" {
			sawResult = true
		}
	}
	if !sawResult || len(kept) != 3 {
		t.Fatalf("live relay = %v, want all three events including result", kept)
	}
}

// relayChatChunkWithTimer runs relayChatChunk live (dropResults=false) with the
// given timer, draining the client so writes never block, and returns nothing -
// the caller inspects side effects (the debug log).
func relayChatChunkWithTimer(t *testing.T, chunk string, timer *streamTimer) {
	t.Helper()
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		conn := &safeConn{Conn: raw}
		relayChatChunk(conn, &claudestream.LineBuffer{}, []byte(chunk), "agent-x", map[string]struct{}{}, nil, false, timer, nil)
		_ = raw.Close()
	}))
	defer srv.Close()
	cli, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer cli.Close()
	for {
		if _, _, err := cli.ReadMessage(); err != nil {
			break
		}
	}
}

func TestChatStreamDebugTrace(t *testing.T) {
	// Two token deltas + one non-delta assistant line in a single chunk. Only the
	// stream_event deltas should be traced (the CLI's per-line flush cadence is
	// what we're measuring); the assistant line must not.
	chunk := `{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}}` + "\n" +
		`{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}}` + "\n" +
		`{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"Hello"}]}}` + "\n"

	var buf bytes.Buffer
	origOut := log.Writer()
	log.SetOutput(&buf)
	defer log.SetOutput(origOut)
	origDebug := chatStreamDebug
	defer func() { chatStreamDebug = origDebug }()

	// Enabled: both deltas traced, with incrementing counts; the assistant line not.
	chatStreamDebug = true
	relayChatChunkWithTimer(t, chunk, &streamTimer{})
	out := buf.String()
	if !strings.Contains(out, "chat stream[agent-x]: delta #1") || !strings.Contains(out, "delta #2") {
		t.Fatalf("want two traced deltas, got:\n%s", out)
	}
	if strings.Count(out, "chat stream[") != 2 {
		t.Fatalf("want exactly 2 delta traces (assistant line must not trace), got:\n%s", out)
	}

	// Disabled: silent.
	buf.Reset()
	chatStreamDebug = false
	relayChatChunkWithTimer(t, chunk, &streamTimer{})
	if buf.Len() != 0 {
		t.Fatalf("want no trace when disabled, got:\n%s", buf.String())
	}

	// nil timer (non-live path) must be a safe no-op even when enabled.
	buf.Reset()
	chatStreamDebug = true
	var nilTimer *streamTimer
	nilTimer.note("agent-x", []byte("x"))
	if buf.Len() != 0 {
		t.Fatalf("nil timer traced or panicked, got:\n%s", buf.String())
	}
}
