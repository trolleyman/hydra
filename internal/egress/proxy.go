// Package egress implements Hydra's filtering forward proxy: a per-head HTTP/
// HTTPS proxy that relays only to an allow-listed set of hosts, so an agent with
// a network allow-list (`[<agent>.sandbox.network] allowed_hosts`) can reach the
// hosts it needs and nothing else.
//
// Enforcement model (important, and deliberately honest - see AUDIT.md rec 3):
// this proxy is reached via the standard HTTP(S)_PROXY environment variables, and
// every well-behaved client (claude, git, npm, curl, node, bun, ...) honours those,
// so for them the allow-list is enforced at this choke point. On its own that is
// NOT an inescapable boundary: a process sharing the host network namespace can
// open a direct socket and ignore the proxy (this is "advisory" mode).
//
// The inescapable boundary is HARD mode (internal/egress/hardmode.go + pasta.go):
// pasta puts the agent in its own network namespace whose nft ruleset drops all
// egress except TCP to this proxy, so a raw socket has nowhere to go. Hard mode is
// selected automatically when a smoke test confirms pasta+nft work on the host,
// and otherwise degrades to advisory (surfaced via heads.EgressMode). The proxy
// code below is identical for both modes - only the reachability of a bypass
// differs. `network mode = "off"` remains the absolute hard off-switch.
//
// A request is relayed iff its host is on the effective allow-list (user list +
// the built-in defaults) AND not on the block-list, which overrides the allow.
// A host on neither list is parked for user approval (an ApproveFunc supplied by
// the caller surfaces an approval toast in the UI); approving it allows the host
// for the rest of the session. A host on the block-list is refused outright, with
// no prompt. Every blocked attempt is logged.
package egress

import (
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/gate"
)

// dialTimeout bounds how long an upstream connection attempt may take.
const dialTimeout = 30 * time.Second

// egressDebug enables a per-request trace of every proxied connection. Off by
// default (Claude opens many connections; the trace is noisy) but invaluable when
// diagnosing whether the agent's traffic reaches the proxy at all - a
// ConnectionRefused at the client means it never did (a netns/pasta reachability
// problem, below this code), while silence here with the client still failing
// points upstream. Enable with HYDRA_EGRESS_DEBUG=1.
var egressDebug = os.Getenv("HYDRA_EGRESS_DEBUG") != ""

func debugf(id, format string, args ...any) {
	if egressDebug {
		log.Printf("hydra egress[%s]: "+format, append([]any{id}, args...)...)
	}
}

// ApproveFunc asks whether an outbound connection to an as-yet-unlisted host may
// proceed. It blocks (typically prompting the user) until decided, and should
// abandon and return false when cancel is closed (the proxy is shutting down). A
// nil ApproveFunc means unknown hosts are silently denied.
type ApproveFunc func(host string, cancel <-chan struct{}) bool

// Proxy is a running per-head filtering forward proxy bound to host loopback.
type Proxy struct {
	id  string
	ln  net.Listener
	srv *http.Server

	// approve parks an unknown host for user approval; nil = deny unknown hosts.
	approve ApproveFunc
	// done is closed by Close so a pending approval can abandon its wait.
	done     chan struct{}
	doneOnce sync.Once

	// mu guards the (mutable) allow-list and the in-flight approval map. The
	// allow-list grows as the user approves hosts mid-session.
	mu       sync.Mutex
	allowed  []string
	blocked  []string
	inflight map[string]*inflightApproval
}

// inflightApproval collapses concurrent connections to the same unknown host into
// a single prompt: the first caller runs the approver; the rest wait on done and
// share result.
type inflightApproval struct {
	done   chan struct{}
	result bool
}

// Start binds a filtering proxy on a loopback port and begins serving. id is the
// head ID (for log lines); port is the loopback port to bind (0 = pick a free
// ephemeral one), allowed is the effective host allow-list and blocked is the
// block-list that overrides it (both exact or "*.suffix"). approve, when non-nil,
// is consulted for a host on neither list - it can park the connection for user
// approval (and, if granted, the host is allowed for the rest of the session).
// Close it when the head ends.
//
// A non-zero port matters for hard mode: a head's pasta/nft netns hard-codes the
// single allowed proxy port when its supervisor is first launched and never
// rebuilds it, so a proxy that restarts (resume, restart) MUST come back on the
// same port - otherwise the netns firewall drops its traffic and the agent sees a
// permanent ConnectionRefused. The caller passes the head's already-bound port on
// any relaunch (see heads.startEgress).
func Start(id string, port int, allowed, blocked []string, approve ApproveFunc) (*Proxy, error) {
	ln, err := listenLoopback(port)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	p := &Proxy{
		id:       id,
		ln:       ln,
		approve:  approve,
		done:     make(chan struct{}),
		allowed:  normalize(allowed),
		blocked:  normalize(blocked),
		inflight: map[string]*inflightApproval{},
	}
	p.srv = &http.Server{
		Handler:           http.HandlerFunc(p.handle),
		ReadHeaderTimeout: dialTimeout,
	}
	go func() {
		if err := p.srv.Serve(ln); err != nil && err != http.ErrServerClosed {
			log.Printf("hydra egress[%s]: serve stopped: %v", id, err)
		}
	}()
	return p, nil
}

// listenLoopback binds a TCP listener on host loopback. port 0 picks a free
// ephemeral port; a non-zero port binds that exact port, retrying briefly so an
// immediate re-bind right after a previous proxy's Close (as happens on resume)
// rides out a transient "address already in use" while the old listener finishes
// closing. (Go sets SO_REUSEADDR on Linux listeners, so this is belt-and-braces.)
func listenLoopback(port int) (net.Listener, error) {
	if port == 0 {
		return errtrace.Wrap2(net.Listen("tcp", "127.0.0.1:0"))
	}
	addr := "127.0.0.1:" + strconv.Itoa(port)
	var lastErr error
	for attempt := 0; attempt < 5; attempt++ {
		ln, err := net.Listen("tcp", addr)
		if err == nil {
			return ln, nil
		}
		lastErr = err
		time.Sleep(100 * time.Millisecond)
	}
	return nil, errtrace.Wrap(lastErr)
}

// Addr is the host:port the proxy listens on (e.g. 127.0.0.1:54321).
func (p *Proxy) Addr() string { return p.ln.Addr().String() }

// Close stops the proxy, abandoning any pending approvals.
func (p *Proxy) Close() error {
	if p == nil || p.srv == nil {
		return nil
	}
	p.doneOnce.Do(func() { close(p.done) })
	return errtrace.Wrap(p.srv.Close())
}

func (p *Proxy) handle(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodConnect {
		p.handleConnect(w, r)
		return
	}
	p.handleHTTP(w, r)
}

// handleConnect tunnels an HTTPS (or any TCP) CONNECT once its target host is on
// the allow-list. The CONNECT target is plaintext in the request line, so the
// host check needs no TLS interception.
func (p *Proxy) handleConnect(w http.ResponseWriter, r *http.Request) {
	host := hostOnly(r.Host)
	if !p.authorize(host) {
		http.Error(w, "hydra: egress to "+host+" blocked (not on the network allow-list)", http.StatusForbidden)
		return
	}
	debugf(p.id, "CONNECT %s → dialing upstream", r.Host)
	upstream, err := net.DialTimeout("tcp", r.Host, dialTimeout)
	if err != nil {
		log.Printf("hydra egress[%s]: upstream dial to %q failed: %v", p.id, r.Host, err)
		http.Error(w, "hydra egress: "+err.Error(), http.StatusBadGateway)
		return
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		upstream.Close()
		http.Error(w, "hydra egress: hijack unsupported", http.StatusInternalServerError)
		return
	}
	client, _, err := hj.Hijack()
	if err != nil {
		upstream.Close()
		return
	}
	if _, err := client.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n")); err != nil {
		client.Close()
		upstream.Close()
		return
	}
	go pipe(upstream, client)
	go pipe(client, upstream)
}

// handleHTTP forwards a plain-HTTP request when its host is allow-listed.
func (p *Proxy) handleHTTP(w http.ResponseWriter, r *http.Request) {
	host := hostOnly(r.Host)
	if host == "" {
		host = hostOnly(r.URL.Host)
	}
	if !p.authorize(host) {
		http.Error(w, "hydra: egress to "+host+" blocked (not on the network allow-list)", http.StatusForbidden)
		return
	}
	outReq := r.Clone(r.Context())
	outReq.RequestURI = ""
	if outReq.URL.Scheme == "" {
		outReq.URL.Scheme = "http"
	}
	if outReq.URL.Host == "" {
		outReq.URL.Host = r.Host
	}
	debugf(p.id, "%s %s → forwarding", r.Method, host)
	resp, err := http.DefaultTransport.RoundTrip(outReq)
	if err != nil {
		log.Printf("hydra egress[%s]: forward to %q failed: %v", p.id, host, err)
		http.Error(w, "hydra egress: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	copyHeader(w.Header(), resp.Header)
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

// authorize reports whether an outbound connection to host may proceed. A host on
// the effective allow-list is permitted; one on the block-list is refused outright
// (block wins - no prompt). An otherwise-unknown host is parked for user approval
// via the approve callback (when configured), and a granted host is added to the
// allow-list for the rest of the session. With no approver - or on deny/timeout -
// the host is refused.
func (p *Proxy) authorize(host string) bool {
	if host == "" {
		return false
	}
	p.mu.Lock()
	blocked := gate.HostAllowed(p.blocked, host)
	allowed := !blocked && gate.HostAllowed(p.allowed, host)
	p.mu.Unlock()
	if blocked {
		p.deny(host)
		return false
	}
	if allowed {
		return true
	}
	if p.approve == nil {
		p.deny(host)
		return false
	}
	if p.requestApproval(host) {
		return true
	}
	p.deny(host)
	return false
}

// requestApproval runs the approve callback for host, collapsing concurrent
// connections to the same unknown host into one prompt: the first caller runs the
// approver; the rest wait for and share its verdict. On approval the host joins
// the session allow-list atomically with the in-flight entry's removal, so a
// racer that read the allow-list before the verdict landed either finds the
// entry still in flight or finds the host already allowed on the re-check here -
// never a gap that would raise a second prompt for the same host.
func (p *Proxy) requestApproval(host string) bool {
	p.mu.Lock()
	if gate.HostAllowed(p.allowed, host) {
		p.mu.Unlock()
		return true
	}
	if fa, ok := p.inflight[host]; ok {
		p.mu.Unlock()
		select {
		case <-fa.done:
			return fa.result
		case <-p.done:
			return false
		}
	}
	fa := &inflightApproval{done: make(chan struct{})}
	p.inflight[host] = fa
	p.mu.Unlock()

	result := p.approve(host, p.done)

	p.mu.Lock()
	fa.result = result
	if result {
		p.allowed = append(p.allowed, host)
	}
	delete(p.inflight, host)
	p.mu.Unlock()
	close(fa.done)
	if result {
		log.Printf("hydra egress[%s]: user APPROVED outbound connection to %q (allowed for this session)", p.id, host)
	}
	return result
}

// deny logs a blocked egress attempt so an unattended head's exfil attempts are
// visible without reading the agent's own output.
func (p *Proxy) deny(host string) {
	log.Printf("hydra egress[%s]: BLOCKED outbound connection to %q (not on allow-list)", p.id, host)
}

// pipe copies src→dst then closes dst's write side, ending the half-tunnel.
func pipe(dst, src net.Conn) {
	_, _ = io.Copy(dst, src)
	dst.Close()
}

// hostOnly strips a :port from a host[:port], leaving the lowercase hostname.
func hostOnly(hostport string) string {
	if hostport == "" {
		return ""
	}
	if h, _, err := net.SplitHostPort(hostport); err == nil {
		return strings.ToLower(h)
	}
	return strings.ToLower(hostport)
}

func normalize(allowed []string) []string {
	out := make([]string, 0, len(allowed))
	for _, a := range allowed {
		if a = strings.TrimSpace(a); a != "" {
			out = append(out, a)
		}
	}
	return out
}

func copyHeader(dst, src http.Header) {
	for k, vs := range src {
		for _, v := range vs {
			dst.Add(k, v)
		}
	}
}
