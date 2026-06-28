// Package egress implements Hydra's filtering forward proxy: a per-head HTTP/
// HTTPS proxy that relays only to an allow-listed set of hosts, so an agent with
// a network allow-list (`[<agent>.sandbox.network] allowed_hosts`) can reach the
// hosts it needs and nothing else.
//
// Enforcement model (important, and deliberately honest — see AUDIT.md rec 3):
// Hydra's unprivileged bwrap sandbox shares the host network namespace when
// network is enabled, so this proxy is reached via the standard HTTP(S)_PROXY
// environment variables. Every well-behaved client (claude, git, npm, curl,
// node, bun, …) honours those, so for them the allow-list is enforced at this
// choke point. It is NOT an inescapable boundary: a determined process in a
// shared network namespace can open a direct socket and ignore the proxy. Making
// it inescapable needs either a privileged netfilter rule or a userspace network
// helper (slirp4netns / pasta) to put the agent in its own namespace with only
// the proxy reachable — neither is available in the unprivileged sandbox here.
// The hard boundary remains `network.enabled = false`. This proxy raises the bar
// from "unrestricted egress" to "egress filtered for every honest client", and
// logs every blocked attempt.
package egress

import (
	"io"
	"log"
	"net"
	"net/http"
	"strings"
	"time"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/gate"
)

// dialTimeout bounds how long an upstream connection attempt may take.
const dialTimeout = 30 * time.Second

// Proxy is a running per-head filtering forward proxy bound to host loopback.
type Proxy struct {
	id      string
	allowed []string
	ln      net.Listener
	srv     *http.Server
}

// Start binds a filtering proxy on a free loopback port and begins serving. id
// is the head ID (for log lines); allowed is the host allow-list (exact or
// "*.suffix"). Close it when the head ends.
func Start(id string, allowed []string) (*Proxy, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	p := &Proxy{id: id, allowed: normalize(allowed), ln: ln}
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

// Addr is the host:port the proxy listens on (e.g. 127.0.0.1:54321).
func (p *Proxy) Addr() string { return p.ln.Addr().String() }

// Close stops the proxy.
func (p *Proxy) Close() error {
	if p == nil || p.srv == nil {
		return nil
	}
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
	if !p.allow(host) {
		p.deny(host)
		http.Error(w, "hydra: egress to "+host+" blocked (not on the network allow-list)", http.StatusForbidden)
		return
	}
	upstream, err := net.DialTimeout("tcp", r.Host, dialTimeout)
	if err != nil {
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
	if !p.allow(host) {
		p.deny(host)
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
	resp, err := http.DefaultTransport.RoundTrip(outReq)
	if err != nil {
		http.Error(w, "hydra egress: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	copyHeader(w.Header(), resp.Header)
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

// allow reports whether host is permitted by the allow-list.
func (p *Proxy) allow(host string) bool {
	if host == "" {
		return false
	}
	return gate.HostAllowed(p.allowed, host)
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
