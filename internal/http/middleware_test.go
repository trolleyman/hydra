package http

import (
	"braces.dev/errtrace"
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"syscall"
	"testing"
)

// A response write that fails because the peer hung up is not a server error:
// the generated strict handlers route it to ResponseErrorHandlerFunc like any
// other, and writing an error body there both trips "superfluous WriteHeader"
// and logs a phantom 500 for a request that was served fine.
func TestIsClientDisconnect(t *testing.T) {
	// The shape the net stack actually produces: *net.OpError wrapping
	// *os.SyscallError wrapping the errno.
	brokenPipe := &net.OpError{
		Op: "write", Net: "tcp",
		Err: &os.SyscallError{Syscall: "write", Err: syscall.EPIPE},
	}
	for _, tc := range []struct {
		name string
		err  error
		want bool
	}{
		{"nil", nil, false},
		{"broken pipe", brokenPipe, true},
		{"wrapped broken pipe", fmt.Errorf("write response: %w", brokenPipe), true},
		{"connection reset", &net.OpError{Op: "write", Err: syscall.ECONNRESET}, true},
		{"use of closed connection", net.ErrClosed, true},
		{"request cancelled", context.Canceled, true},
		{"handler aborted", http.ErrAbortHandler, true},
		{"a real failure", errors.New("database is on fire"), false},
		{"deadline exceeded", context.DeadlineExceeded, false},
	} {
		if got := isClientDisconnect(tc.err); got != tc.want {
			t.Errorf("isClientDisconnect(%s) = %v, want %v", tc.name, got, tc.want)
		}
	}
}

// The recorder remembers the first write error so LoggingMiddleware can report a
// disconnect instead of whatever status happens to be half-written.
func TestStatusRecorderCapturesWriteError(t *testing.T) {
	rec := &statusRecorder{ResponseWriter: failingWriter{ResponseWriter: httptest.NewRecorder()}, statusCode: http.StatusOK}
	if _, err := rec.Write([]byte("body")); err == nil {
		t.Fatal("Write returned no error, want the underlying failure")
	}
	if !isClientDisconnect(rec.writeErr) {
		t.Errorf("recorder.writeErr = %v, want a recognised client disconnect", rec.writeErr)
	}
}

type failingWriter struct {
	http.ResponseWriter
}

func (failingWriter) Write([]byte) (int, error) {
	return 0, errtrace.Wrap(&net.OpError{Op: "write", Err: &os.SyscallError{Syscall: "write", Err: syscall.EPIPE}})
}
