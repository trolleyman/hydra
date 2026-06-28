package heads

import (
	"log"
	"sync"

	"github.com/trolleyman/hydra/internal/egress"
	"github.com/trolleyman/hydra/internal/sandbox"
)

// egressProxies tracks the per-head filtering proxies so they can be torn down
// when a head is killed or relaunched. A proxy is a lightweight loopback
// listener; the map is keyed by head ID.
var egressProxies = struct {
	mu sync.Mutex
	m  map[string]*egress.Proxy
}{m: map[string]*egress.Proxy{}}

// startEgressProxy starts (or restarts) a head's filtering egress proxy when it
// has a non-empty network allow-list, returning the HTTP(S)_PROXY environment to
// inject so the sandboxed agent routes outbound traffic through it. With no
// allow-list (or network disabled) it returns nil and no proxy runs — egress is
// then unrestricted (network on) or fully blocked (network off), as before.
//
// Any existing proxy for id is closed first, so a resume gets a fresh one.
func startEgressProxy(id string, net sandbox.NetworkPolicy) []string {
	stopEgressProxy(id)
	if !net.Enabled || len(net.AllowedHosts) == 0 {
		return nil
	}
	p, err := egress.Start(id, net.AllowedHosts)
	if err != nil {
		// Fail open on the proxy itself: the head still launches (the allow-list
		// just isn't applied this run). Loud, because it widens egress.
		log.Printf("hydra egress[%s]: could not start filtering proxy, continuing WITHOUT host filtering: %v", id, err)
		return nil
	}
	egressProxies.mu.Lock()
	egressProxies.m[id] = p
	egressProxies.mu.Unlock()

	url := "http://" + p.Addr()
	const noProxy = "localhost,127.0.0.1,::1"
	// Set both upper- and lower-case spellings: different clients read different
	// ones (curl/git use lower-case; many Go/Node libraries accept either).
	return []string{
		"HTTP_PROXY=" + url, "http_proxy=" + url,
		"HTTPS_PROXY=" + url, "https_proxy=" + url,
		"ALL_PROXY=" + url, "all_proxy=" + url,
		"NO_PROXY=" + noProxy, "no_proxy=" + noProxy,
	}
}

// stopEgressProxy closes and forgets a head's egress proxy, if any.
func stopEgressProxy(id string) {
	egressProxies.mu.Lock()
	p := egressProxies.m[id]
	delete(egressProxies.m, id)
	egressProxies.mu.Unlock()
	if p != nil {
		_ = p.Close()
	}
}
