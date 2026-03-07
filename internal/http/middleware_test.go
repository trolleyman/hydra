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

	"github.com/trolleyman/hydra/internal/api"
)

func TestLoggingMiddleware(t *testing.T) {
	var logBuf bytes.Buffer
	oldOutput := log.Writer()
	log.SetOutput(&logBuf)
	defer log.SetOutput(oldOutput)

	// Test 500 error with RecordError
	h500 := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		RecordError(r, errors.New("original error"))
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(api.ErrorResponse{
			Code:    500,
			Error:   "internal_error",
			Details: "", // Should fall back to RecordError
		})
	})

	mw := LoggingMiddleware(h500)
	req := httptest.NewRequest("GET", "/test-500", nil)
	rr := httptest.NewRecorder()
	mw.ServeHTTP(rr, req)

	logOutput := logBuf.String()
	// Should contain the suffix in the main log line
	if !strings.Contains(logOutput, "500") {
		t.Errorf("Expected log to contain 500, got: %s", logOutput)
	}
	if !strings.Contains(logOutput, "(internal_error: \"original error\")") {
		t.Errorf("Expected log to contain formatted ErrorResponse suffix, got: %s", logOutput)
	}
	if !strings.Contains(logOutput, "Internal Server Error details:\noriginal error") {
		t.Errorf("Expected log to contain detailed error, got: %s", logOutput)
	}

	logBuf.Reset()

	// Test 400 error with ErrorResponse details
	h400 := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(api.ErrorResponse{
			Code:    400,
			Error:   "bad_request",
			Details: "invalid input",
		})
	})

	mw = LoggingMiddleware(h400)
	req = httptest.NewRequest("POST", "/test-400", nil)
	rr = httptest.NewRecorder()
	mw.ServeHTTP(rr, req)

	logOutput = logBuf.String()
	if !strings.Contains(logOutput, "400") {
		t.Errorf("Expected log to contain 400, got: %s", logOutput)
	}
	if !strings.Contains(logOutput, "(bad_request: \"invalid input\")") {
		t.Errorf("Expected log to contain formatted ErrorResponse suffix, got: %s", logOutput)
	}
}
