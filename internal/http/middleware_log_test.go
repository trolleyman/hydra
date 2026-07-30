package http

import (
	"braces.dev/errtrace"
	"bytes"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"braces.dev/errtrace"
)

// captureLog swaps the standard logger's output for a buffer and restores it.
func captureLog(t *testing.T, fn func()) string {
	t.Helper()
	var buf bytes.Buffer
	old := log.Writer()
	oldFlags := log.Flags()
	log.SetOutput(&buf)
	log.SetFlags(0)
	defer func() {
		log.SetOutput(old)
		log.SetFlags(oldFlags)
	}()
	fn()
	return buf.String()
}

func serve(handler http.Handler, method, target string, headers map[string]string) {
	req := httptest.NewRequest(method, target, nil)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	handler.ServeHTTP(httptest.NewRecorder(), req)
}

// The UI polls a handful of endpoints several times a second per open tab. Those
// requests were 99.7% of the log by volume, which rolled the file over every few
// minutes; a fast successful GET must now log nothing at all.
func TestLoggingMiddlewareIsQuietForFastSuccessfulGets(t *testing.T) {
	h := LoggingMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	out := captureLog(t, func() {
		for i := 0; i < 50; i++ {
			serve(h, http.MethodGet, "/api/status", nil)
		}
	})
	if out != "" {
		t.Errorf("50 fast successful GETs logged %q, want nothing", out)
	}
}

func TestLoggingMiddlewareLogsMutationsAndErrors(t *testing.T) {
	ok := LoggingMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	out := captureLog(t, func() { serve(ok, http.MethodPost, "/api/projects/p/agents/a/read", nil) })
	if !strings.Contains(out, "<- POST") || !strings.Contains(out, "-> POST") {
		t.Errorf("POST logged %q, want both a receipt and a completion line", out)
	}

	bad := LoggingMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	out = captureLog(t, func() { serve(bad, http.MethodGet, "/api/nope", nil) })
	if !strings.Contains(out, "-> GET /api/nope 404") {
		t.Errorf("failing GET logged %q, want a completion line with the status", out)
	}
}

// Quieting the routine traffic must not lose the old property that a request
// stuck in its handler is visible in the log BEFORE it finishes.
//
// The in-flight warning is emitted from a time.AfterFunc timer goroutine, so it
// is asynchronous: a busy test binary can schedule that goroutine after the
// handler has already returned. Capturing a single snapshot the instant serve()
// returns (as captureLog does) therefore races the warning and can miss it - the
// line then lands on the restored default logger instead of the buffer. Capture
// into a synchronized buffer and wait for the warning rather than snapshotting.
func TestLoggingMiddlewareWarnsWhileAGetIsStuck(t *testing.T) {
	old := slowRequestWarn
	slowRequestWarn = 20 * time.Millisecond
	defer func() { slowRequestWarn = old }()

	buf := &syncBuffer{}
	oldOut, oldFlags := log.Writer(), log.Flags()
	log.SetOutput(buf)
	log.SetFlags(0)
	defer func() {
		log.SetOutput(oldOut)
		log.SetFlags(oldFlags)
	}()

	h := LoggingMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(80 * time.Millisecond)
	}))
	serve(h, http.MethodGet, "/api/slow", nil)

	// The completion line is written synchronously by serve; the warning is not,
	// so give the timer goroutine a generous window to land it.
	deadline := time.Now().Add(2 * time.Second)
	for {
		out := buf.String()
		if strings.Contains(out, "== GET /api/slow still running") && strings.Contains(out, "-> GET /api/slow 200") {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("slow GET logged %q, want an in-flight warning and a completion line", out)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

// syncBuffer is a bytes.Buffer safe for the logger to write to from its timer
// goroutine while the test reads it.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return errtrace.Wrap2(s.buf.Write(p))
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buf.String()
}

// A websocket is meant to sit open for minutes, so neither the stuck warning nor
// a duration on close says anything worth a line.
func TestLoggingMiddlewareIsQuietForWebsockets(t *testing.T) {
	old := slowRequestWarn
	slowRequestWarn = 20 * time.Millisecond
	defer func() { slowRequestWarn = old }()

	h := LoggingMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(80 * time.Millisecond)
	}))
	out := captureLog(t, func() {
		serve(h, http.MethodGet, "/ws/projects/p/events", map[string]string{"Upgrade": "websocket"})
	})
	if out != "" {
		t.Errorf("long-lived websocket logged %q, want nothing", out)
	}
}
