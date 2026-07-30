package http

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"net"
	"net/http"
	"strings"
)

// authCookieName is the cookie the web login screen sets once a remote client
// has presented the correct key. It holds a token derived from the key (not the
// key itself), and is sent automatically on same-origin API and WebSocket
// requests, so the WebSocket endpoints are covered by the same gate.
const authCookieName = "hydra_auth"

// Authenticator gates non-localhost access to the API/WebSocket endpoints with a
// shared key. Loopback (and unix-socket / in-process) requests are trusted by
// default, so the local web UI and the CLI's daemon socket keep working with no
// credentials. When the key is empty, auth is disabled entirely and every
// request passes through - preserving the prior localhost-only behaviour.
//
// requireLocal (deploy.toml `require_local_auth`) withdraws the loopback
// exemption: a browser on this machine then has to present the key too. That
// matters when something else on the host forwards outside traffic in - a
// `tailscale serve` / reverse-proxy front-end dials Hydra from 127.0.0.1, so
// without it every proxied request looks local and is waved through. The unix
// control socket stays trusted regardless: it is filesystem-permission gated
// (0600) and is how the CLI and in-sandbox tools talk to the daemon.
type Authenticator struct {
	key          string // the configured shared secret ("" disables auth)
	token        string // hex(sha256(key)); the cookie value, so the raw key isn't stored client-side
	requireLocal bool   // gate loopback TCP peers as well as remote ones
}

// NewAuthenticator builds an Authenticator for the given key. An empty key
// disables authentication. requireLocal additionally gates loopback clients (a
// no-op when the key is empty, since there is then nothing to check).
func NewAuthenticator(key string, requireLocal bool) *Authenticator {
	a := &Authenticator{key: key, requireLocal: requireLocal}
	if key != "" {
		sum := sha256.Sum256([]byte(key))
		a.token = hex.EncodeToString(sum[:])
	}
	return a
}

// Enabled reports whether a key is configured (i.e. remote requests are gated).
func (a *Authenticator) Enabled() bool { return a != nil && a.key != "" }

// protectedPrefixes are the URL path prefixes that carry data or live
// connections and so require auth from remote clients. Everything else (the
// embedded SPA shell, its JS/CSS assets, /health, and /api/auth/*) stays open so
// an unauthenticated remote browser can still load the page and show the login
// screen.
//
// This list used to name one prefix per hand-served route family - /artifacts/,
// /uploads/, /shells/ and so on - which made it a thing somebody had to remember
// to extend. Twice nobody did: /tests/projects/{id}/log (whole test and build
// output) and /project-icon/projects/{id} were both reachable from an
// unauthenticated remote client for as long as they existed. Every one of those
// routes now lives under /api/, so this list is three ENTIRE namespaces rather
// than an enumeration, and a new route is gated by where it is registered rather
// than by anyone updating this slice. Keep it that way: if a route needs a new
// top-level prefix here, that is the signal it belongs under /api/ instead.
var protectedPrefixes = []string{
	"/api/",
	"/ws/",
	"/.well-known/",
}

// isProtected reports whether a path requires auth for remote clients. The auth
// endpoints themselves and the health check are always exempt.
func isProtected(path string) bool {
	if strings.HasPrefix(path, "/api/auth/") || path == "/health" {
		return false
	}
	for _, p := range protectedPrefixes {
		if strings.HasPrefix(path, p) {
			return true
		}
	}
	return false
}

// isLocalSocket reports whether a request arrived over the daemon's unix control
// socket or in-process (empty/abstract RemoteAddr, as used by the CLI and
// tests). Those are always trusted - the socket is 0600, so reaching it already
// means local filesystem access - and `require_local_auth` does not gate them.
func isLocalSocket(r *http.Request) bool {
	addr := r.RemoteAddr
	return addr == "" || addr == "@"
}

// isLoopbackPeer reports whether the request's TCP peer is on this machine.
func isLoopbackPeer(r *http.Request) bool {
	host := r.RemoteAddr
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	host = strings.TrimPrefix(strings.TrimSuffix(host, "]"), "[")
	if ip := net.ParseIP(host); ip != nil {
		return ip.IsLoopback()
	}
	return host == "localhost"
}

// trusted reports whether a request may skip the key entirely: the control
// socket always, and a loopback TCP peer unless require_local_auth is set.
func (a *Authenticator) trusted(r *http.Request) bool {
	if isLocalSocket(r) {
		return true
	}
	return !a.requireLocal && isLoopbackPeer(r)
}

// authenticated reports whether a request carries valid credentials: either the
// auth cookie (set by the login endpoint) or an `Authorization: Bearer <key>`
// header (for programmatic clients). Comparisons are constant-time.
func (a *Authenticator) authenticated(r *http.Request) bool {
	if !a.Enabled() {
		return true
	}
	if c, err := r.Cookie(authCookieName); err == nil {
		if subtle.ConstantTimeCompare([]byte(c.Value), []byte(a.token)) == 1 {
			return true
		}
	}
	if h := r.Header.Get("Authorization"); h != "" {
		if token, ok := strings.CutPrefix(h, "Bearer "); ok {
			if subtle.ConstantTimeCompare([]byte(strings.TrimSpace(token)), []byte(a.key)) == 1 {
				return true
			}
		}
	}
	return false
}

// Authorized reports whether a request may access protected content: auth
// disabled, a trusted-local peer, or valid credentials. It is the same gate
// Middleware applies, exported for subsystems serving on other ports (live
// server previews) - the auth cookie is host-scoped, so a browser logged into
// the main UI passes this check on any port of the same host.
func (a *Authenticator) Authorized(r *http.Request) bool {
	return !a.Enabled() || a.trusted(r) || a.authenticated(r)
}

// Middleware wraps next, allowing trusted-local and unprotected requests through
// unconditionally and requiring valid credentials for protected paths from
// remote clients. Unauthenticated protected requests get a 401.
func (a *Authenticator) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !a.Enabled() || a.trusted(r) || !isProtected(r.URL.Path) || a.authenticated(r) {
			next.ServeHTTP(w, r)
			return
		}
		details := "authentication required for non-localhost access"
		if a.requireLocal {
			details = "authentication required (require_local_auth is on, so localhost is gated too)"
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error":   "unauthorized",
			"details": details,
		})
	})
}

// RegisterRoutes wires the auth endpoints onto mux. They are exempt from the
// gate (see isProtected) so a remote, not-yet-authenticated browser can reach
// them to discover whether a key is required and to log in.
func (a *Authenticator) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/auth/status", a.handleStatus)
	mux.HandleFunc("POST /api/auth/login", a.handleLogin)
	mux.HandleFunc("POST /api/auth/logout", a.handleLogout)
}

// handleStatus tells the web client whether it must show a login screen.
// auth_required is true when a key is configured and this request isn't exempt
// (remote always; localhost too under require_local_auth); authenticated
// reflects whether this request would already be let through. `remote` lets the
// login screen explain *why* it is asking - "you are off-machine" reads wrong
// when the browser is on the same box.
func (a *Authenticator) handleStatus(w http.ResponseWriter, r *http.Request) {
	required := a.Enabled() && !a.trusted(r)
	authed := a.trusted(r) || a.authenticated(r)
	writeJSONResponse(w, http.StatusOK, map[string]bool{
		"auth_required": required,
		"authenticated": authed,
		"remote":        !isLocalSocket(r) && !isLoopbackPeer(r),
	})
}

// handleLogin validates a posted key and, on success, sets the auth cookie.
func (a *Authenticator) handleLogin(w http.ResponseWriter, r *http.Request) {
	if !a.Enabled() {
		writeJSONResponse(w, http.StatusOK, map[string]bool{"authenticated": true})
		return
	}
	var body struct {
		Key string `json:"key"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	key := strings.TrimSpace(body.Key)
	if key == "" {
		key = strings.TrimSpace(r.FormValue("key"))
	}
	if subtle.ConstantTimeCompare([]byte(key), []byte(a.key)) != 1 {
		writeJSONResponse(w, http.StatusUnauthorized, map[string]string{
			"error":   "unauthorized",
			"details": "incorrect key",
		})
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     authCookieName,
		Value:    a.token,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   r.TLS != nil,
		MaxAge:   30 * 24 * 60 * 60, // 30 days
	})
	writeJSONResponse(w, http.StatusOK, map[string]bool{"authenticated": true})
}

// handleLogout clears the auth cookie.
func (a *Authenticator) handleLogout(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name:     authCookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   r.TLS != nil,
		MaxAge:   -1,
	})
	writeJSONResponse(w, http.StatusOK, map[string]bool{"authenticated": false})
}
