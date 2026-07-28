package http

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// okHandler is a trivial next-handler that records whether it was reached.
func okHandler(reached *bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*reached = true
		w.WriteHeader(http.StatusOK)
	})
}

func req(method, path, remoteAddr string) *http.Request {
	r := httptest.NewRequest(method, path, nil)
	r.RemoteAddr = remoteAddr
	return r
}

// postJSON builds a POST request with a JSON body from the given remote peer.
func postJSON(path, remoteAddr, body string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	r.RemoteAddr = remoteAddr
	r.Header.Set("Content-Type", "application/json")
	return r
}

func TestAuthMiddleware(t *testing.T) {
	const key = "s3cr3t-key"
	auth := NewAuthenticator(key, false)

	cases := []struct {
		name       string
		path       string
		remoteAddr string
		cookie     string
		bearer     string
		wantPass   bool
	}{
		{"loopback ipv4 trusted", "/api/projects", "127.0.0.1:5555", "", "", true},
		{"loopback ipv6 trusted", "/api/projects", "[::1]:5555", "", "", true},
		{"unix socket trusted", "/api/projects", "", "", "", true},
		{"remote protected blocked", "/api/projects", "192.168.1.20:5555", "", "", false},
		{"remote ws blocked", "/ws/projects/p/events", "192.168.1.20:5555", "", "", false},
		{"remote with valid cookie", "/api/projects", "192.168.1.20:5555", auth.token, "", true},
		{"remote with bad cookie", "/api/projects", "192.168.1.20:5555", "nope", "", false},
		{"remote with valid bearer", "/api/projects", "192.168.1.20:5555", "", key, true},
		{"remote with bad bearer", "/api/projects", "192.168.1.20:5555", "", "wrong", false},
		{"remote frontend asset open", "/assets/app.js", "192.168.1.20:5555", "", "", true},
		{"remote health open", "/health", "192.168.1.20:5555", "", "", true},
		{"remote auth endpoint open", "/api/auth/status", "192.168.1.20:5555", "", "", true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			reached := false
			r := req(http.MethodGet, tc.path, tc.remoteAddr)
			if tc.cookie != "" {
				r.AddCookie(&http.Cookie{Name: authCookieName, Value: tc.cookie})
			}
			if tc.bearer != "" {
				r.Header.Set("Authorization", "Bearer "+tc.bearer)
			}
			w := httptest.NewRecorder()
			auth.Middleware(okHandler(&reached)).ServeHTTP(w, r)

			if reached != tc.wantPass {
				t.Fatalf("reached=%v, want %v (status %d)", reached, tc.wantPass, w.Code)
			}
			if !tc.wantPass && w.Code != http.StatusUnauthorized {
				t.Fatalf("blocked request returned %d, want 401", w.Code)
			}
		})
	}
}

// TestAuthRequireLocal covers require_local_auth: loopback loses its exemption
// but the unix control socket keeps it, and a valid cookie/bearer still passes.
func TestAuthRequireLocal(t *testing.T) {
	const key = "s3cr3t-key"
	auth := NewAuthenticator(key, true)

	cases := []struct {
		name       string
		path       string
		remoteAddr string
		cookie     string
		bearer     string
		wantPass   bool
	}{
		{"loopback ipv4 gated", "/api/projects", "127.0.0.1:5555", "", "", false},
		{"loopback ipv6 gated", "/api/projects", "[::1]:5555", "", "", false},
		{"loopback ws gated", "/ws/projects/p/events", "127.0.0.1:5555", "", "", false},
		{"unix socket still trusted", "/api/projects", "", "", "", true},
		{"abstract unix socket still trusted", "/api/projects", "@", "", "", true},
		{"loopback with valid cookie", "/api/projects", "127.0.0.1:5555", auth.token, "", true},
		{"loopback with valid bearer", "/api/projects", "127.0.0.1:5555", "", key, true},
		{"loopback with bad bearer", "/api/projects", "127.0.0.1:5555", "", "wrong", false},
		{"loopback frontend asset open", "/assets/app.js", "127.0.0.1:5555", "", "", true},
		{"loopback auth endpoint open", "/api/auth/status", "127.0.0.1:5555", "", "", true},
		{"loopback health open", "/health", "127.0.0.1:5555", "", "", true},
		{"remote still blocked", "/api/projects", "192.168.1.20:5555", "", "", false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			reached := false
			r := req(http.MethodGet, tc.path, tc.remoteAddr)
			if tc.cookie != "" {
				r.AddCookie(&http.Cookie{Name: authCookieName, Value: tc.cookie})
			}
			if tc.bearer != "" {
				r.Header.Set("Authorization", "Bearer "+tc.bearer)
			}
			w := httptest.NewRecorder()
			auth.Middleware(okHandler(&reached)).ServeHTTP(w, r)

			if reached != tc.wantPass {
				t.Fatalf("reached=%v, want %v (status %d)", reached, tc.wantPass, w.Code)
			}
			if !tc.wantPass && w.Code != http.StatusUnauthorized {
				t.Fatalf("blocked request returned %d, want 401", w.Code)
			}
		})
	}

	// Preview ports share the gate, so they follow localhost in.
	if auth.Authorized(req(http.MethodGet, "/", "127.0.0.1:5555")) {
		t.Fatal("Authorized let an unauthenticated loopback request through")
	}
}

// TestAuthRequireLocalWithoutKeyIsInert guards the misconfiguration: a bare
// require_local_auth with no key must not lock out the local UI.
func TestAuthRequireLocalWithoutKeyIsInert(t *testing.T) {
	auth := NewAuthenticator("", true)
	if auth.Enabled() {
		t.Fatal("empty key should disable auth even with require_local_auth")
	}
	reached := false
	w := httptest.NewRecorder()
	auth.Middleware(okHandler(&reached)).ServeHTTP(w, req(http.MethodGet, "/api/projects", "127.0.0.1:1"))
	if !reached {
		t.Fatalf("keyless require_local_auth blocked a local request (status %d)", w.Code)
	}
}

func TestAuthDisabledPassesEverything(t *testing.T) {
	auth := NewAuthenticator("", false)
	if auth.Enabled() {
		t.Fatal("empty key should disable auth")
	}
	reached := false
	r := req(http.MethodGet, "/api/projects", "8.8.8.8:5555")
	w := httptest.NewRecorder()
	auth.Middleware(okHandler(&reached)).ServeHTTP(w, r)
	if !reached {
		t.Fatalf("disabled auth blocked a remote request (status %d)", w.Code)
	}
}

func TestLoginSetsCookieAndAuthenticates(t *testing.T) {
	const key = "open-sesame"
	auth := NewAuthenticator(key, false)
	mux := http.NewServeMux()
	auth.RegisterRoutes(mux)

	// Wrong key is rejected with no cookie.
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, postJSON("/api/auth/login", "192.168.1.5:9", `{"key":"nope"}`))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("bad login returned %d, want 401", w.Code)
	}

	// Correct key sets the auth cookie.
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, postJSON("/api/auth/login", "192.168.1.5:9", `{"key":"`+key+`"}`))
	if w.Code != http.StatusOK {
		t.Fatalf("good login returned %d, want 200", w.Code)
	}
	var cookie *http.Cookie
	for _, c := range w.Result().Cookies() {
		if c.Name == authCookieName {
			cookie = c
		}
	}
	if cookie == nil || cookie.Value != auth.token {
		t.Fatal("login did not set the auth cookie to the token")
	}

	// That cookie then authenticates a protected request from a remote peer.
	r := req(http.MethodGet, "/api/projects", "192.168.1.5:9")
	r.AddCookie(cookie)
	if !auth.authenticated(r) {
		t.Fatal("cookie set by login does not authenticate")
	}
}

func TestStatusReportsRequirement(t *testing.T) {
	auth := NewAuthenticator("k", false)

	// Remote, unauthenticated → must log in.
	w := httptest.NewRecorder()
	auth.handleStatus(w, req(http.MethodGet, "/api/auth/status", "10.0.0.1:1"))
	var remote map[string]bool
	_ = json.Unmarshal(w.Body.Bytes(), &remote)
	if !remote["auth_required"] || remote["authenticated"] || !remote["remote"] {
		t.Fatalf("remote status = %v, want required & not authenticated & remote", remote)
	}

	// Localhost → not required by default.
	w = httptest.NewRecorder()
	auth.handleStatus(w, req(http.MethodGet, "/api/auth/status", "127.0.0.1:1"))
	var local map[string]bool
	_ = json.Unmarshal(w.Body.Bytes(), &local)
	if local["auth_required"] || !local["authenticated"] || local["remote"] {
		t.Fatalf("local status = %v, want not required & authenticated & not remote", local)
	}

	// Localhost under require_local_auth → login screen, worded as local.
	w = httptest.NewRecorder()
	NewAuthenticator("k", true).handleStatus(w, req(http.MethodGet, "/api/auth/status", "127.0.0.1:1"))
	var gated map[string]bool
	_ = json.Unmarshal(w.Body.Bytes(), &gated)
	if !gated["auth_required"] || gated["authenticated"] || gated["remote"] {
		t.Fatalf("gated-local status = %v, want required & not authenticated & not remote", gated)
	}
}
