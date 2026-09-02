package http

import (
	"net/http"
	"testing"

	"github.com/trolleyman/hydra/internal/heads"
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

// TestCheckOriginSameHost covers the same-origin path: a LAN/remote browser
// reaching Hydra by IP or hostname must be allowed (so the phone use-case works)
// while a different site pointed at the same host is still rejected.
func TestCheckOriginSameHost(t *testing.T) {
	tests := []struct {
		name   string
		host   string
		origin string
		allow  bool
	}{
		{name: "LAN IP same origin", host: "192.168.1.5:8080", origin: "http://192.168.1.5:8080", allow: true},
		{name: "hostname same origin", host: "my-laptop:8080", origin: "http://my-laptop:8080", allow: true},
		{name: "LAN IP cross origin", host: "192.168.1.5:8080", origin: "http://evil.com", allow: false},
		{name: "LAN IP port mismatch", host: "192.168.1.5:8080", origin: "http://192.168.1.5:9999", allow: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r, _ := http.NewRequest(http.MethodGet, "/ws", nil)
			r.Host = tt.host
			r.Header.Set("Origin", tt.origin)
			if got := checkOrigin(r); got != tt.allow {
				t.Errorf("checkOrigin(host=%q, origin=%q) = %v, want %v", tt.host, tt.origin, got, tt.allow)
			}
		})
	}
}

func TestHeadCanHostSession(t *testing.T) {
	worktree := "/tmp/hydra-worktree"
	branch := "hydra/test"
	tests := []struct {
		name string
		head heads.Head
		want bool
	}{
		{
			name: "live worktree head",
			head: heads.Head{Branch: &branch, Worktree: &worktree},
			want: true,
		},
		{
			name: "degraded worktree head",
			head: heads.Head{Branch: &branch},
			want: false,
		},
		{
			name: "live project-directory head",
			head: heads.Head{ProjectPath: "/tmp/hydra-project"},
			want: true,
		},
		{
			name: "archived project-directory head",
			head: heads.Head{ProjectPath: "/tmp/hydra-project", Archived: true},
			want: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := headCanHostSession(tt.head); got != tt.want {
				t.Fatalf("headCanHostSession() = %v, want %v", got, tt.want)
			}
		})
	}
}
