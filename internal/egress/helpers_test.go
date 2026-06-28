package egress

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

// newTestServer is a tiny HTTP upstream returning body for any request.
func newTestServer(t *testing.T, body string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(body))
	}))
}

// mustHost returns the hostname (no port) of a URL.
func mustHost(t *testing.T, raw string) string {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return u.Hostname()
}
