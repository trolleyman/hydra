package http

import (
	"bufio"
	"compress/gzip"
	"fmt"
	"net"
	"net/http"
	"strings"
	"sync"

	"braces.dev/errtrace"
)

// minCompressSize is how many body bytes have to accumulate before gzip earns
// its keep. Below it the response goes out untouched: the UI polls a handful of
// small JSON endpoints several times a second per open tab, and gzipping a
// 200-byte object makes it *bigger* once the framing is counted.
const minCompressSize = 1024

// gzipWriters recycles gzip.Writers, each of which carries a ~256KB window. The
// frontend is served from this process, so a cold page load is a few hundred
// requests in a burst; allocating a fresh compressor per response is the one
// part of this that would actually show up in a profile.
var gzipWriters = sync.Pool{
	New: func() any { return gzip.NewWriter(nil) },
}

// CompressionMiddleware gzips responses for clients that ask for it. Hydra
// serves its own frontend - 3.9MB of JS plus ~12MB of source maps, embedded in
// the binary - and previously served every byte of it uncompressed, so raw size
// was wire size. That is invisible over loopback and very visible over Tailscale
// from a phone.
//
// Compression is decided per response, lazily, once enough of the body has
// accumulated to be worth it (see compressWriter.decide). Requests that must not
// be touched - websocket upgrades and range requests - are passed straight
// through.
//
// It belongs OUTSIDE LoggingMiddleware: that middleware captures the body of a
// failed response to put in the log, and it should capture the readable one.
func CompressionMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Announce that the representation depends on the request encoding
		// whether or not this particular response ends up compressed, so a shared
		// cache never hands a gzipped body to a client that can't read it.
		w.Header().Add("Vary", "Accept-Encoding")

		// A websocket upgrade hijacks the connection and speaks its own framing;
		// a range request is asking for bytes of the *identity* representation,
		// which we would no longer be serving. Neither is ours to encode.
		if !acceptsGzip(r) || isUpgrade(r) || r.Header.Get("Range") != "" {
			next.ServeHTTP(w, r)
			return
		}

		cw := &compressWriter{ResponseWriter: w, status: http.StatusOK}
		defer cw.finish()
		next.ServeHTTP(cw, r)
	})
}

// acceptsGzip reports whether the client offered gzip. A bare token match is
// enough here: no mainstream client sends `gzip;q=0` while also being something
// we want to compress for.
func acceptsGzip(r *http.Request) bool {
	for enc := range strings.SplitSeq(r.Header.Get("Accept-Encoding"), ",") {
		if name, _, _ := strings.Cut(strings.TrimSpace(enc), ";"); strings.EqualFold(name, "gzip") {
			return true
		}
	}
	return false
}

func isUpgrade(r *http.Request) bool {
	return strings.EqualFold(r.Header.Get("Upgrade"), "websocket") ||
		strings.Contains(strings.ToLower(r.Header.Get("Connection")), "upgrade")
}

// compressibleType reports whether a Content-Type is worth gzipping. The list is
// deliberately an allow-list: the expensive mistake is re-compressing something
// already compressed (PNG, woff2, the video artifacts), which burns CPU to make
// the body slightly larger.
func compressibleType(ct string) bool {
	mediaType, _, _ := strings.Cut(ct, ";")
	mediaType = strings.ToLower(strings.TrimSpace(mediaType))
	if strings.HasPrefix(mediaType, "text/") {
		return true
	}
	if strings.HasSuffix(mediaType, "+json") || strings.HasSuffix(mediaType, "+xml") {
		return true
	}
	switch mediaType {
	case "application/json", "application/javascript", "application/xml",
		"application/wasm", "application/x-ndjson", "image/svg+xml":
		return true
	}
	return false
}

// compressWriter gzips what a handler writes, deciding whether to do so at the
// last responsible moment.
//
// The decision needs two things the handler hasn't necessarily supplied when it
// calls WriteHeader: the Content-Type (Go sniffs it from the first write, and if
// we hand the sniffer *compressed* bytes it will confidently label the response
// application/x-gzip) and enough body to know it clears minCompressSize. So the
// header and the first bytes are held back until decide() runs - on reaching the
// threshold, on an explicit Flush, or at finish() for a short response.
type compressWriter struct {
	http.ResponseWriter

	status  int
	decided bool
	// gz is nil when the decision came out "pass through".
	gz *gzip.Writer
	// pending holds the body written before decide() ran.
	pending []byte
	// hijacked suppresses finish(), since the connection is no longer ours.
	hijacked bool
	// writeErr keeps the first failure from draining pending, which happens
	// inside decide() where there is no caller to return it to.
	writeErr error
}

func (c *compressWriter) WriteHeader(code int) {
	if c.decided {
		return // header already went out; a second WriteHeader is the caller's bug
	}
	c.status = code
}

func (c *compressWriter) Write(b []byte) (int, error) {
	if !c.decided {
		c.pending = append(c.pending, b...)
		if len(c.pending) < minCompressSize {
			return len(b), nil
		}
		// decide() drains everything buffered, b included - so this call must
		// not fall through and write b a second time.
		c.decide(false)
		return len(b), errtrace.Wrap(c.writeErr)
	}
	if c.gz != nil {
		n, err := c.gz.Write(b)
		return n, errtrace.Wrap(err)
	}
	n, err := c.ResponseWriter.Write(b)
	return n, errtrace.Wrap(err)
}

// decide settles compress-vs-passthrough, emits the response header, and drains
// whatever was buffered while we waited. Everything after this point streams.
//
// streaming says the caller flushed, which means the body has no knowable size
// and the minCompressSize threshold must not be applied - otherwise a log stream
// that trickles out a line at a time would sit in the buffer forever.
func (c *compressWriter) decide(streaming bool) {
	if c.decided {
		return
	}
	c.decided = true

	h := c.Header()
	// Sniffing has to happen against the *uncompressed* bytes, and it has to be
	// recorded, because once we start writing gzip the stdlib's own sniffer would
	// get it wrong.
	if h.Get("Content-Type") == "" && len(c.pending) > 0 {
		h.Set("Content-Type", http.DetectContentType(c.pending))
	}

	if c.shouldCompress(h, streaming) {
		h.Set("Content-Encoding", "gzip")
		// The body length is about to change and we're streaming, so there is no
		// honest value to put here. Dropping it moves the response to chunked.
		h.Del("Content-Length")
		// A strong ETag identifies the identity bytes; keeping it on a re-encoded
		// body would let a cache serve the two interchangeably.
		if etag := h.Get("ETag"); etag != "" && !strings.HasPrefix(etag, "W/") {
			h.Set("ETag", "W/"+etag)
		}
		gz := gzipWriters.Get().(*gzip.Writer)
		gz.Reset(c.ResponseWriter)
		c.gz = gz
	}

	c.ResponseWriter.WriteHeader(c.status)
	if len(c.pending) > 0 {
		var err error
		if c.gz != nil {
			_, err = c.gz.Write(c.pending)
		} else {
			_, err = c.ResponseWriter.Write(c.pending)
		}
		if err != nil && c.writeErr == nil {
			c.writeErr = err
		}
		c.pending = nil
	}
}

// shouldCompress applies the checks that need the response header in hand.
func (c *compressWriter) shouldCompress(h http.Header, streaming bool) bool {
	// Someone downstream already encoded this (or explicitly opted out).
	if h.Get("Content-Encoding") != "" {
		return false
	}
	// 204/304 have no body; 1xx is not a response we terminate.
	if c.status == http.StatusNoContent || c.status == http.StatusNotModified || c.status < 200 {
		return false
	}
	// A response that finished under the threshold isn't worth encoding. Only
	// meaningful when the handler is *done* (or declared its length): mid-stream
	// there is more to come, so the buffer so far says nothing.
	if !streaming {
		if len(c.pending) < minCompressSize {
			return false
		}
		if cl := h.Get("Content-Length"); cl != "" {
			var n int64
			if _, err := fmt.Sscan(cl, &n); err == nil && n < minCompressSize {
				return false
			}
		}
	}
	return compressibleType(h.Get("Content-Type"))
}

// Flush forces the decision (a handler that flushes is streaming, so waiting for
// minCompressSize would stall it) and then pushes bytes all the way out. Both
// layers have to be flushed: gzip buffers on its own account, and a Flush that
// only hit the socket would strand a half-written frame.
func (c *compressWriter) Flush() {
	c.decide(true)
	if c.gz != nil {
		_ = c.gz.Flush()
	}
	if f, ok := c.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Hijack hands the raw connection over, having written nothing. Anything already
// buffered is dropped on purpose: the caller is about to speak a different
// protocol on this socket.
func (c *compressWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	hj, ok := c.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, errtrace.Wrap(fmt.Errorf("underlying ResponseWriter does not implement http.Hijacker"))
	}
	c.hijacked = true
	c.pending = nil
	return errtrace.Wrap3(hj.Hijack())
}

// finish flushes the gzip trailer and returns the compressor to the pool. It
// also covers the handler that wrote a short body, or none at all, by running
// the decision it never triggered.
func (c *compressWriter) finish() {
	if c.hijacked {
		return
	}
	c.decide(false)
	if c.gz != nil {
		_ = c.gz.Close()
		c.gz.Reset(nil) // don't pin the connection through the pool
		gzipWriters.Put(c.gz)
		c.gz = nil
	}
}
