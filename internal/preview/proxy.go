package preview

import (
	"encoding/json"
	"fmt"
	"html"
	"net/http"
	"strings"
	"time"
)

// statusPrefix is a reserved URL prefix on every preview port, served by the
// proxy itself (never forwarded to the child): the loading page polls it for
// spawn progress. The odd name makes a collision with a real app path
// vanishingly unlikely.
const statusPrefix = "/__hydra_preview__/"

// serveHTTP is the handler for an instance's proxy port: auth gate, reserved
// status endpoint, lazy spawn, loading page while starting, then reverse-proxy
// with in-flight accounting (an open WebSocket tunnel blocks inside ServeHTTP,
// so it holds the in-flight count for its whole lifetime).
func (in *instance) serveHTTP(w http.ResponseWriter, r *http.Request) {
	if auth := in.mgr.auth; auth != nil && !auth.Authorized(r) {
		in.serveUnauthorized(w, r)
		return
	}
	in.touch()

	if strings.HasPrefix(r.URL.Path, statusPrefix) {
		in.serveStatus(w, r)
		return
	}

	// Any real request (re)spawns a stopped server. An errored one is only
	// retried on a browser navigation (an HTML GET), so a crash-looping command
	// isn't hammered by an app's background fetches; the loading page shows the
	// failure and offers reload-to-retry.
	in.mu.Lock()
	state := in.state
	in.mu.Unlock()
	wantsHTML := prefersHTML(r)
	if state == StateStopped || (state == StateError && wantsHTML) {
		in.ensureStarted()
	}

	in.mu.Lock()
	state = in.state
	readyCh := in.readyCh
	proxy := in.proxy
	in.mu.Unlock()

	if state == StateStarting {
		if wantsHTML {
			in.serveLoadingPage(w)
			return
		}
		// Non-HTML callers (the app's own fetches, curl) wait for readiness.
		if readyCh != nil {
			select {
			case <-readyCh:
			case <-r.Context().Done():
				return
			}
		}
		in.mu.Lock()
		state = in.state
		proxy = in.proxy
		in.mu.Unlock()
	}

	switch state {
	case StateRunning:
		if proxy == nil { // settled between the check and here; rare
			http.Error(w, "preview restarting, retry", http.StatusServiceUnavailable)
			return
		}
		in.mu.Lock()
		in.inflight++
		in.lastActive = time.Now()
		in.mu.Unlock()
		defer func() {
			in.mu.Lock()
			in.inflight--
			in.lastActive = time.Now()
			in.mu.Unlock()
		}()
		proxy.ServeHTTP(w, r)
	case StateError:
		if wantsHTML {
			in.serveLoadingPage(w) // renders the error + log with reload-to-retry
			return
		}
		in.mu.Lock()
		msg := in.message
		in.mu.Unlock()
		http.Error(w, "preview failed to start: "+msg, http.StatusBadGateway)
	default: // stopped mid-flight (torn down while we waited)
		w.Header().Set("Retry-After", "1")
		http.Error(w, "preview stopped, retry", http.StatusServiceUnavailable)
	}
}

// serveUnauthorized mirrors the main UI's auth middleware: JSON 401 for
// programmatic requests, a small pointer page for browsers (the hydra_auth
// cookie is host-scoped, so logging into the main UI authorizes this port too).
func (in *instance) serveUnauthorized(w http.ResponseWriter, r *http.Request) {
	if prefersHTML(r) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusUnauthorized)
		fmt.Fprintf(w, `<!doctype html><meta charset="utf-8"><title>Hydra preview</title>
<body style="font-family:system-ui;display:grid;place-items:center;min-height:90vh;background:#0b0e14;color:#d6dbe4">
<div style="max-width:34rem;text-align:center">
<h1 style="font-size:1.2rem">Authentication required</h1>
<p>This is a Hydra preview server. Log in to the Hydra web UI on this host first - the login cookie also unlocks preview ports - then reload this page.</p>
</div></body>`)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusUnauthorized)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error":   "unauthorized",
		"details": "authentication required for non-localhost access",
	})
}

// serveStatus is the reserved endpoint the loading page polls.
func (in *instance) serveStatus(w http.ResponseWriter, _ *http.Request) {
	st := in.status()
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"name":     st.Name,
		"state":    string(st.State),
		"version":  st.Version,
		"progress": st.Progress,
		"message":  st.Message,
		"log":      st.Log,
	})
}

// serveLoadingPage renders the self-contained holding page shown on browser
// navigations while the server is starting (live build log, auto-reload into
// the app once ready) or errored (failure detail, reload retries).
func (in *instance) serveLoadingPage(w http.ResponseWriter) {
	in.mu.Lock()
	name := in.spec.Name
	in.mu.Unlock()
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	// 200 (not 503) so browsers render it rather than an error page; the page
	// replaces itself the moment the app is up.
	fmt.Fprintf(w, loadingPageHTML, html.EscapeString(name), statusPrefix)
}

// prefersHTML reports whether the request looks like a browser navigation
// (rather than an app's fetch/XHR/WS), i.e. it should get an HTML page.
func prefersHTML(r *http.Request) bool {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		return false
	}
	if r.Header.Get("Upgrade") != "" {
		return false
	}
	accept := r.Header.Get("Accept")
	return strings.Contains(accept, "text/html")
}

// loadingPageHTML is the holding page template. Placeholders: script name,
// status endpoint prefix. Plain ASCII, no external assets (previews may be
// fully offline), dark neutral styling.
const loadingPageHTML = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Starting %[1]s...</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: system-ui, sans-serif; background: #0b0e14; color: #d6dbe4;
         margin: 0; display: flex; flex-direction: column; align-items: center;
         min-height: 100vh; box-sizing: border-box; padding: 12vh 1.5rem 2rem; }
  h1 { font-size: 1.1rem; font-weight: 600; margin: 0 0 .35rem; }
  .sub { color: #8a93a5; font-size: .85rem; margin-bottom: 1.4rem; min-height: 1.2em; }
  .dot { display: inline-block; width: .55em; height: .55em; border-radius: 50%%;
         background: #e0af3f; margin-right: .5em; animation: pulse 1.2s ease-in-out infinite; }
  .dot.err { background: #e05f5f; animation: none; }
  @keyframes pulse { 50%% { opacity: .3; } }
  pre { background: #10141d; border: 1px solid #1e2430; border-radius: 8px;
        width: min(72rem, 100%%); max-width: 100%%; box-sizing: border-box;
        padding: .9rem 1.1rem; overflow: auto; max-height: 55vh;
        font-size: .78rem; line-height: 1.45; white-space: pre-wrap; word-break: break-all; }
  .stderr { color: #e08f8f; }
  .err-msg { color: #e05f5f; font-size: .85rem; margin: 0 0 1rem; max-width: 60rem; }
  .hint { color: #5c6575; font-size: .75rem; margin-top: 1rem; }
</style>
<body>
  <h1><span class="dot" id="dot"></span>Starting <span id="name">%[1]s</span>...</h1>
  <div class="sub" id="progress"></div>
  <p class="err-msg" id="message" hidden></p>
  <pre id="log" hidden></pre>
  <div class="hint" id="hint">This page reloads into the app automatically once the server is ready.</div>
<script>
(function () {
  var logEl = document.getElementById('log');
  var progressEl = document.getElementById('progress');
  var messageEl = document.getElementById('message');
  var dotEl = document.getElementById('dot');
  var hintEl = document.getElementById('hint');
  function render(st) {
    if (st.state === 'running') { location.reload(); return; }
    progressEl.textContent = st.progress || '';
    if (st.log && st.log.length) {
      logEl.hidden = false;
      logEl.innerHTML = st.log.map(function (l) {
        var t = l.text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
        return l.stream === 'stderr' ? '<span class="stderr">' + t + '</span>' : t;
      }).join('\n');
      logEl.scrollTop = logEl.scrollHeight;
    }
    if (st.state === 'error') {
      dotEl.classList.add('err');
      document.title = 'Failed: ' + st.name;
      messageEl.hidden = !st.message;
      messageEl.textContent = st.message || '';
      hintEl.textContent = 'Reload the page to retry.';
      return; // keep polling stopped on error; reload retries
    }
    setTimeout(poll, 800);
  }
  function poll() {
    fetch('%[2]sstatus', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(render)
      .catch(function () { setTimeout(poll, 1500); });
  }
  poll();
})();
</script>
</body>
`
