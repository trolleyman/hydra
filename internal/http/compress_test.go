package http

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// bigJSON is comfortably over minCompressSize and compresses well.
var bigJSON = []byte(`{"items":[` + strings.Repeat(`{"name":"agent","status":"running"},`, 200) + `{}]}`)

func doRequest(t *testing.T, h http.Handler, req *http.Request) *http.Response {
	t.Helper()
	rec := httptest.NewRecorder()
	CompressionMiddleware(h).ServeHTTP(rec, req)
	return rec.Result()
}

func gzipReq() *http.Request {
	r := httptest.NewRequest("GET", "/api/agents", nil)
	r.Header.Set("Accept-Encoding", "gzip")
	return r
}

// TestCompressesLargeJSON is the case the middleware exists for.
func TestCompressesLargeJSON(t *testing.T) {
	resp := doRequest(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(bigJSON)
	}), gzipReq())

	if got := resp.Header.Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("Content-Encoding = %q, want gzip", got)
	}
	if got := resp.Header.Get("Vary"); !strings.Contains(got, "Accept-Encoding") {
		t.Errorf("Vary = %q, want it to mention Accept-Encoding", got)
	}
	// A stale Content-Length would describe the identity body and desync the client.
	if got := resp.Header.Get("Content-Length"); got != "" {
		t.Errorf("Content-Length = %q, want it dropped once re-encoded", got)
	}

	zr, err := gzip.NewReader(resp.Body)
	if err != nil {
		t.Fatalf("gzip.NewReader: %v", err)
	}
	body, err := io.ReadAll(zr)
	if err != nil {
		t.Fatalf("read gzip body: %v", err)
	}
	if !bytes.Equal(body, bigJSON) {
		t.Errorf("round-tripped body differs from what the handler wrote")
	}
}

// TestSkipsWithoutAcceptEncoding covers the client that can't read gzip.
func TestSkipsWithoutAcceptEncoding(t *testing.T) {
	resp := doRequest(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(bigJSON)
	}), httptest.NewRequest("GET", "/api/agents", nil))

	if got := resp.Header.Get("Content-Encoding"); got != "" {
		t.Fatalf("Content-Encoding = %q, want empty", got)
	}
	body, _ := io.ReadAll(resp.Body)
	if !bytes.Equal(body, bigJSON) {
		t.Errorf("body was altered for a client that never asked for gzip")
	}
}

// TestSkipsSmallResponses guards the poll traffic: gzipping a 30-byte object
// makes it bigger, and the UI asks for several of them per second per tab.
func TestSkipsSmallResponses(t *testing.T) {
	small := []byte(`{"status":"ok"}`)
	resp := doRequest(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(small)
	}), gzipReq())

	if got := resp.Header.Get("Content-Encoding"); got != "" {
		t.Fatalf("Content-Encoding = %q, want empty for a %d-byte body", got, len(small))
	}
	body, _ := io.ReadAll(resp.Body)
	if !bytes.Equal(body, small) {
		t.Errorf("body = %q, want %q", body, small)
	}
}

// TestSkipsAlreadyCompressedTypes: re-gzipping a PNG burns CPU to grow the body.
func TestSkipsAlreadyCompressedTypes(t *testing.T) {
	blob := bytes.Repeat([]byte{0x89, 0x50, 0x4e, 0x47}, 500)
	resp := doRequest(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(blob)
	}), gzipReq())

	if got := resp.Header.Get("Content-Encoding"); got != "" {
		t.Fatalf("Content-Encoding = %q, want empty for image/png", got)
	}
}

// TestSkipsRangeRequests: a Range names bytes of the identity representation, so
// serving encoded bytes for it would hand back the wrong window.
func TestSkipsRangeRequests(t *testing.T) {
	req := gzipReq()
	req.Header.Set("Range", "bytes=0-99")
	resp := doRequest(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write(bigJSON)
	}), req)

	if got := resp.Header.Get("Content-Encoding"); got != "" {
		t.Fatalf("Content-Encoding = %q, want empty for a range request", got)
	}
}

// TestSkipsNotModified: a 304 carries no body, and tagging it as encoded is a
// lie the cache will act on.
func TestSkipsNotModified(t *testing.T) {
	resp := doRequest(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotModified)
	}), gzipReq())

	if got := resp.Header.Get("Content-Encoding"); got != "" {
		t.Fatalf("Content-Encoding = %q, want empty on 304", got)
	}
	if resp.StatusCode != http.StatusNotModified {
		t.Errorf("status = %d, want 304", resp.StatusCode)
	}
}

// TestPreservesStatusCode: the header is held back until the compress decision
// is made, so it is easy to accidentally send 200 for everything.
func TestPreservesStatusCode(t *testing.T) {
	resp := doRequest(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusTeapot)
		_, _ = w.Write(bigJSON)
	}), gzipReq())

	if resp.StatusCode != http.StatusTeapot {
		t.Fatalf("status = %d, want 418", resp.StatusCode)
	}
	if got := resp.Header.Get("Content-Encoding"); got != "gzip" {
		t.Errorf("Content-Encoding = %q, want gzip", got)
	}
}

// TestSniffsContentTypeFromUncompressedBody: Go's sniffer runs on whatever
// reaches the underlying writer, so if the decision were made after compression
// started every sniffed response would come back labelled application/x-gzip.
func TestSniffsContentTypeFromUncompressedBody(t *testing.T) {
	html := []byte("<!DOCTYPE html><html><body>" + strings.Repeat("hydra ", 400) + "</body></html>")
	resp := doRequest(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(html) // no explicit Content-Type
	}), gzipReq())

	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Fatalf("Content-Type = %q, want text/html...", ct)
	}
	if got := resp.Header.Get("Content-Encoding"); got != "gzip" {
		t.Errorf("Content-Encoding = %q, want gzip", got)
	}
}

// flushRecorder reports whether the underlying writer actually saw a Flush, so a
// streaming handler can be checked end to end.
type flushRecorder struct {
	*httptest.ResponseRecorder
	flushed int
}

func (f *flushRecorder) Flush() { f.flushed++; f.ResponseRecorder.Flush() }

// TestFlushStreamsThroughGzip is the case the build-log stream depends on: a
// handler that flushes must not be held back waiting for minCompressSize, and
// the bytes must be readable as they arrive rather than stuck in the gzip
// window.
func TestFlushStreamsThroughGzip(t *testing.T) {
	rec := &flushRecorder{ResponseRecorder: httptest.NewRecorder()}
	h := CompressionMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write([]byte("first line\n")) // far below minCompressSize
		w.(http.Flusher).Flush()
	}))
	h.ServeHTTP(rec, gzipReq())

	if rec.flushed == 0 {
		t.Fatal("handler flushed but nothing reached the underlying writer")
	}
	resp := rec.Result()
	if got := resp.Header.Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("Content-Encoding = %q, want gzip - a flushing handler is streaming, so the size threshold must not apply", got)
	}
	zr, err := gzip.NewReader(resp.Body)
	if err != nil {
		t.Fatalf("gzip.NewReader: %v", err)
	}
	body, err := io.ReadAll(zr)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(body) != "first line\n" {
		t.Errorf("body = %q, want %q", body, "first line\n")
	}
}

// hijackRecorder satisfies http.Hijacker so the websocket path can be exercised.
type hijackRecorder struct {
	*httptest.ResponseRecorder
	hijacked bool
}

func (h *hijackRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	h.hijacked = true
	client, server := net.Pipe()
	_ = client.Close()
	return server, bufio.NewReadWriter(bufio.NewReader(server), bufio.NewWriter(server)), nil
}

// TestWebSocketUpgradeIsNotWrapped: every terminal, chat, tests and artifacts
// stream in the UI is a websocket, and each one hijacks the connection. If the
// middleware wrapped those the socket would come back without a Hijacker.
func TestWebSocketUpgradeIsNotWrapped(t *testing.T) {
	req := gzipReq()
	req.Header.Set("Upgrade", "websocket")
	req.Header.Set("Connection", "Upgrade")

	rec := &hijackRecorder{ResponseRecorder: httptest.NewRecorder()}
	CompressionMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hj, ok := w.(http.Hijacker)
		if !ok {
			t.Error("ResponseWriter passed to a websocket handler does not implement http.Hijacker")
			return
		}
		conn, _, err := hj.Hijack()
		if err != nil {
			t.Errorf("Hijack: %v", err)
			return
		}
		_ = conn.Close()
	})).ServeHTTP(rec, req)

	if !rec.hijacked {
		t.Fatal("handler never reached the underlying Hijacker")
	}
}

// TestHijackWorksThroughWrapper covers a hijack that happens without the upgrade
// headers that would have skipped wrapping - the wrapper must still delegate.
func TestHijackWorksThroughWrapper(t *testing.T) {
	rec := &hijackRecorder{ResponseRecorder: httptest.NewRecorder()}
	CompressionMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hj, ok := w.(http.Hijacker)
		if !ok {
			t.Error("wrapped ResponseWriter does not implement http.Hijacker")
			return
		}
		conn, _, err := hj.Hijack()
		if err != nil {
			t.Errorf("Hijack: %v", err)
			return
		}
		_ = conn.Close()
	})).ServeHTTP(rec, gzipReq())

	if !rec.hijacked {
		t.Fatal("Hijack did not reach the underlying writer")
	}
}

// TestEmptyBodyStillSendsHeader: a handler that sets a status and writes nothing
// must not be swallowed by the deferred decision.
func TestEmptyBodyStillSendsHeader(t *testing.T) {
	resp := doRequest(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}), gzipReq())

	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", resp.StatusCode)
	}
	if got := resp.Header.Get("Content-Encoding"); got != "" {
		t.Errorf("Content-Encoding = %q, want empty on 204", got)
	}
}

// TestWeakensStrongETag: a strong ETag names the identity bytes, so leaving it
// unchanged on a re-encoded body invites a cache to treat the two as the same.
func TestWeakensStrongETag(t *testing.T) {
	resp := doRequest(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("ETag", `"abc123"`)
		_, _ = w.Write(bigJSON)
	}), gzipReq())

	if got := resp.Header.Get("ETag"); got != `W/"abc123"` {
		t.Errorf("ETag = %q, want it weakened to W/\"abc123\"", got)
	}
}
