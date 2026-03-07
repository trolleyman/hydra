package http

import (
	"braces.dev/errtrace"
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"runtime/debug"
	"time"

	"github.com/trolleyman/hydra/internal/api"
)

type errorTracker struct {
	err error
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

// statusRecorder wraps http.ResponseWriter to capture the status code and body on error.
type statusRecorder struct {
	http.ResponseWriter
	statusCode int
	body       bytes.Buffer
}

func (r *statusRecorder) WriteHeader(code int) {
	r.statusCode = code
	r.ResponseWriter.WriteHeader(code)
}

func (r *statusRecorder) Write(b []byte) (int, error) {
	if r.statusCode >= 400 {
		r.body.Write(b)
	}
	return r.ResponseWriter.Write(b)
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

// LoggingMiddleware logs each HTTP request with method, path, status code, and duration.
func LoggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		r, et := withErrorTracker(r)

		rec := &statusRecorder{ResponseWriter: w, statusCode: http.StatusOK}
		next.ServeHTTP(rec, r)

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

		log.Printf("%s %s %d %s%s", r.Method, r.URL.Path, rec.statusCode, time.Since(start).Round(time.Millisecond), errorSuffix)

		if rec.statusCode == http.StatusInternalServerError {
			if et.err != nil {
				log.Printf("Internal Server Error details:\n%+v", et.err)
			} else {
				log.Printf("500 Internal Server Error at %s:\n%s", time.Now().Format(time.RFC3339), debug.Stack())
			}
		}
	})
}
