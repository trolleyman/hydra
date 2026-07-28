package http

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"runtime/debug"
	"strings"
	"syscall"
	"time"

	"braces.dev/errtrace"

	"github.com/trolleyman/hydra/internal/api"
)

type errorTracker struct {
	err error
}

type apiError struct {
	Code int
	Type api.ErrorResponseError
	Err  error
}

func (e *apiError) Error() string {
	return e.Err.Error()
}

type contextKey string

const errorTrackerKey contextKey = "errorTracker"

func withErrorTracker(r *http.Request) (*http.Request, *errorTracker) {
	et := &errorTracker{}
	return r.WithContext(context.WithValue(r.Context(), errorTrackerKey, et)), et
}

// RecordError stores an error in the request context for LoggingMiddleware to use.
func RecordError(r *http.Request, err error) {
	if et, ok := r.Context().Value(errorTrackerKey).(*errorTracker); ok {
		et.err = err
	}
}

// isClientDisconnect reports whether err is the peer hanging up mid-response
// rather than anything going wrong server-side: the browser aborting a fetch
// (navigation, a cancelled react-query, a StrictMode double-render) shows up as
// EPIPE/ECONNRESET on the response write, and a cancelled request context as
// context.Canceled. Neither is a server fault, so callers neither write an error
// body (the status line is already on the wire) nor log a 500.
func isClientDisconnect(err error) bool {
	if err == nil {
		return false
	}
	return errors.Is(err, syscall.EPIPE) ||
		errors.Is(err, syscall.ECONNRESET) ||
		errors.Is(err, net.ErrClosed) ||
		errors.Is(err, context.Canceled) ||
		errors.Is(err, http.ErrAbortHandler)
}

// statusRecorder wraps http.ResponseWriter to capture the status code and body on error.
type statusRecorder struct {
	http.ResponseWriter
	statusCode int
	body       bytes.Buffer
	// writeErr is the first error returned by the underlying writer. A
	// client disconnect lands here, and LoggingMiddleware reports it as such
	// instead of as a server error.
	writeErr error
}

func (r *statusRecorder) WriteHeader(code int) {
	r.statusCode = code
	r.ResponseWriter.WriteHeader(code)
}

func (r *statusRecorder) Write(b []byte) (int, error) {
	if r.statusCode >= 400 {
		r.body.Write(b)
	}
	n, err := r.ResponseWriter.Write(b)
	if err != nil && r.writeErr == nil {
		r.writeErr = err
	}
	return n, errtrace.Wrap(err)
}

// Unwrap returns the underlying ResponseWriter, allowing the standard library
// to detect interfaces like http.Flusher on the original writer.
func (r *statusRecorder) Unwrap() http.ResponseWriter {
	return r.ResponseWriter
}

// Hijack implements http.Hijacker, delegating to the underlying ResponseWriter.
// This is required for WebSocket upgrades which use http.Hijacker to take over
// the raw TCP connection.
func (r *statusRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	hj, ok := r.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, errtrace.Wrap(fmt.Errorf("underlying ResponseWriter does not implement http.Hijacker"))
	}
	return errtrace.Wrap3(hj.Hijack())
}

// Flush implements http.Flusher, delegating to the underlying ResponseWriter.
func (r *statusRecorder) Flush() {
	if f, ok := r.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// RequestBodyLimitMiddleware rejects request bodies larger than maxBytes.
// This prevents unbounded memory consumption from oversized JSON payloads.
func RequestBodyLimitMiddleware(maxBytes int64) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
			next.ServeHTTP(w, r)
		})
	}
}

// slowRequestWarn is how long a request may run before the log says so - both
// while it is still in flight and again when it finishes. A var so tests can
// shorten it rather than sleeping through the real threshold.
var slowRequestWarn = 2 * time.Second

// logAllHTTP restores a line per request in both directions, for when the HTTP
// layer itself is what you are debugging. Off by default: the UI polls
// /api/status, /api/projects, .../agents, .../services and friends several
// times a second per open tab, and logging those was 99.7% of the log by
// volume - enough to roll the file over every few minutes and throw away the
// parts anyone would actually want to read.
var logAllHTTP = os.Getenv("HYDRA_LOG_HTTP") == "1"

// LoggingMiddleware logs each HTTP request with method, path, status code, and
// duration - but only the ones worth a line: mutations, errors, and anything
// slow. A fast, successful GET logs nothing.
func LoggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		r, et := withErrorTracker(r)

		// Include the query string so distinct requests to the same path (e.g.
		// per-file diff fetches with different ?path=&context=) are tellable apart
		// in the log instead of all collapsing to an identical-looking line.
		uri := r.URL.Path
		if r.URL.RawQuery != "" {
			uri += "?" + r.URL.RawQuery
		}

		// A websocket is *meant* to sit open for minutes, so neither the
		// in-flight warning nor the duration on close says anything useful.
		websocket := strings.EqualFold(r.Header.Get("Upgrade"), "websocket")
		// GETs are the poll traffic; everything else changes state and is rare
		// enough to trace both ways.
		verbose := logAllHTTP || (r.Method != http.MethodGet && !websocket)

		if verbose {
			log.Printf("<- %s %s", r.Method, uri)
		}
		// The old code logged every request on receipt so that one hanging in its
		// handler showed up as a "<- " with no matching "-> ". Keep that property
		// without the volume: only a request that is ACTUALLY stuck says so.
		// AfterFunc costs a timer, not a goroutine, until it fires.
		if !websocket && !verbose {
			stuck := time.AfterFunc(slowRequestWarn, func() {
				log.Printf("== %s %s still running after %s", r.Method, uri, slowRequestWarn)
			})
			defer stuck.Stop()
		}

		rec := &statusRecorder{ResponseWriter: w, statusCode: http.StatusOK}
		next.ServeHTTP(rec, r)

		// The peer hung up part-way through the response. The handler itself was
		// fine, so report the disconnect rather than whatever half-written status
		// happens to be recorded, and skip the 500 stack dump below. Gated like a
		// normal response, not like an error: an aborted poll IS poll traffic, and
		// nothing went wrong server-side.
		if isClientDisconnect(rec.writeErr) {
			if elapsed := time.Since(start); verbose || (!websocket && elapsed >= slowRequestWarn) {
				log.Printf("-> %s %s %d %s (client disconnected)", r.Method, uri, rec.statusCode, elapsed.Round(time.Millisecond))
			}
			return
		}

		var errorSuffix string
		if rec.statusCode >= 400 {
			var errResp api.ErrorResponse
			if err := json.Unmarshal(rec.body.Bytes(), &errResp); err == nil {
				details := errResp.Details
				if details == "" && et.err != nil {
					details = et.err.Error()
				}
				errorSuffix = fmt.Sprintf(" (%s: %q)", errResp.Error, details)
			} else if et.err != nil {
				errorSuffix = fmt.Sprintf(" (internal_error: %q)", et.err.Error())
			}
		}

		elapsed := time.Since(start)
		if verbose || rec.statusCode >= 400 || (!websocket && elapsed >= slowRequestWarn) {
			log.Printf("-> %s %s %d %s%s", r.Method, uri, rec.statusCode, elapsed.Round(time.Millisecond), errorSuffix)
		}

		if rec.statusCode == http.StatusInternalServerError {
			if et.err != nil {
				log.Printf("Internal Server Error details:\n%+v", et.err)
			} else {
				log.Printf("500 Internal Server Error at %s:\n%s", time.Now().Format(time.RFC3339), debug.Stack())
			}
		}
	})
}
