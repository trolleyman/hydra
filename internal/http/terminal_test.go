package http

import (
	"net/http"
	"testing"
)

func TestCheckOrigin(t *testing.T) {
	tests := []struct {
		name   string
		origin string
		allow  bool
	}{
		// Allowed: no origin header (native/CLI clients)
		{name: "no origin", origin: "", allow: true},

		// Allowed: localhost variants
		{name: "localhost http", origin: "http://localhost", allow: true},
		{name: "localhost with port", origin: "http://localhost:8080", allow: true},
		{name: "localhost https", origin: "https://localhost:8080", allow: true},
		{name: "127.0.0.1", origin: "http://127.0.0.1:8080", allow: true},
		{name: "IPv6 loopback", origin: "http://[::1]:8080", allow: true},

		// Blocked: external origins
		{name: "external domain", origin: "http://evil.com", allow: false},
		{name: "external domain with port", origin: "http://evil.com:8080", allow: false},
		{name: "subdomain of localhost", origin: "http://evil.localhost", allow: false},
		{name: "localhost in path", origin: "http://evil.com/localhost", allow: false},
		{name: "malformed origin", origin: "://bad", allow: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r, _ := http.NewRequest(http.MethodGet, "/ws", nil)
			if tt.origin != "" {
				r.Header.Set("Origin", tt.origin)
			}
			got := checkOrigin(r)
			if got != tt.allow {
				t.Errorf("checkOrigin(%q) = %v, want %v", tt.origin, got, tt.allow)
			}
		})
	}
}
