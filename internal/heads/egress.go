package heads

import (
	"log"
	"sync"

	"github.com/trolleyman/hydra/internal/egress"
	"github.com/trolleyman/hydra/internal/sandbox"
)

// EgressMode is the network-enforcement posture in effect for a head, surfaced to
// the UI so the user knows how strong the boundary is.
type EgressMode string

const (
	// EgressNone is the zero value: no mode recorded for the head (not live, or
	// never started). The API omits it.
	EgressNone EgressMode = ""
	// EgressUnrestricted: network on with host filtering off → every host
	// reachable. Surfaced so the user can see a head has an open egress channel.
	EgressUnrestricted EgressMode = "unrestricted"
	// EgressOff: network disabled entirely (the hard off-switch).
	EgressOff EgressMode = "off"
	// EgressHard: allow-list enforced in a pasta netns + nft lock — a real,
	// inescapable boundary.
	EgressHard EgressMode = "filtered-hard"
	// EgressAdvisory: allow-list enforced by the proxy via HTTP(S)_PROXY only —
	// filters every proxy-respecting client, but a determined process in the
	// shared net namespace can bypass it (pasta/nft unavailable on this host).
	EgressAdvisory EgressMode = "filtered-advisory"
)

// egressEntry is a head's running proxy plus its mode.
type egressEntry struct {
	proxy *egress.Proxy
	mode  EgressMode
}

var egressProxies = struct {
	mu sync.Mutex
	m  map[string]*egressEntry
}{m: map[string]*egressEntry{}}

// startEgress sets up a head's egress filtering from its resolved network policy
// and returns the proxy env to inject plus, for hard mode, the bwrap-wrapping
// closure to put on sandbox.Options.EgressWrap. It may set net.Enabled = false
// (via the pointer) when a strict hard policy can't build its boundary, so the
// sandbox falls back to no network at all.
//
//   - mode off / !Enabled → no proxy, no network.
//   - mode unrestricted → no proxy, unrestricted egress.
//   - mode advisory → proxy-only filtering (escapable), no hard boundary attempted.
//   - mode hard → attempt the pasta+nft netns (inescapable); if the tooling is
//     unavailable, degrade to advisory with a warning, unless Strict, in which
//     case fail closed (no network).
//
// The proxy enforces the effective allow-list — the built-in DefaultAllowedHosts
// unioned with net.AllowedHosts — minus net.BlockedHosts, which overrides it.
func startEgress(id string, net *sandbox.NetworkPolicy) (env []string, wrap func([]string) []string) {
	stopEgressProxy(id)
	if !net.Enabled || net.Mode == sandbox.NetOff {
		setEgressMode(id, EgressOff)
		return nil, nil
	}
	if !net.FilterHosts || net.Mode == sandbox.NetUnrestricted {
		setEgressMode(id, EgressUnrestricted)
		return nil, nil
	}

	allowed := append(sandbox.DefaultAllowedHosts(), net.AllowedHosts...)
	p, err := egress.Start(id, allowed, net.BlockedHosts)
	if err != nil {
		if net.Mode == sandbox.NetHard && net.Strict {
			log.Printf("hydra egress[%s]: STRICT hard egress but proxy failed to start; failing closed (no network): %v", id, err)
			net.Enabled = false
			setEgressMode(id, EgressOff)
			return nil, nil
		}
		log.Printf("hydra egress[%s]: could not start filtering proxy, continuing WITHOUT host filtering: %v", id, err)
		setEgressMode(id, EgressUnrestricted)
		return nil, nil
	}
	port := egress.HostPort(p.Addr())

	if net.Mode == sandbox.NetHard {
		if hm := egress.DetectHardMode(); hm.Available && port != 0 {
			// Hard mode: the agent reaches the host proxy at the mapped address, and
			// nft drops everything else. The proxy itself listens on host loopback.
			storeEgress(id, p, EgressHard)
			log.Printf("hydra egress[%s]: hard egress boundary active (pasta+nft), %d allow-listed host(s)", id, len(allowed))
			env = egress.ProxyEnv("http://" + egress.MapAddr + ":" + itoa(port))
			wrap = func(bwrapArgv []string) []string { return egress.HardWrapArgv(hm, port, bwrapArgv) }
			return env, wrap
		}
		if net.Strict {
			// Strict: no inescapable boundary available → fail closed.
			log.Printf("hydra egress[%s]: STRICT hard egress requested but pasta/nft unavailable; failing closed (no network)", id)
			_ = p.Close()
			net.Enabled = false
			setEgressMode(id, EgressOff)
			return nil, nil
		}
		log.Printf("hydra egress[%s]: hard egress requested but pasta/nft unavailable; DEGRADED to advisory filtering", id)
	}

	// Advisory mode (chosen, or a non-strict hard degrade): shared host net, proxy
	// reachable on loopback, filtering via HTTP(S)_PROXY only.
	storeEgress(id, p, EgressAdvisory)
	log.Printf("hydra egress[%s]: advisory egress filtering (proxy only), %d allow-listed host(s)", id, len(allowed))
	return egress.ProxyEnv("http://" + p.Addr()), nil
}

// EgressModeFor returns the enforcement mode currently recorded for a head (used
// by the API/UI). Unknown heads report EgressNone.
func EgressModeFor(id string) EgressMode {
	egressProxies.mu.Lock()
	defer egressProxies.mu.Unlock()
	if e := egressProxies.m[id]; e != nil {
		return e.mode
	}
	return EgressNone
}

func storeEgress(id string, p *egress.Proxy, mode EgressMode) {
	egressProxies.mu.Lock()
	egressProxies.m[id] = &egressEntry{proxy: p, mode: mode}
	egressProxies.mu.Unlock()
}

// setEgressMode records a mode with no running proxy (off / unrestricted).
func setEgressMode(id string, mode EgressMode) {
	egressProxies.mu.Lock()
	egressProxies.m[id] = &egressEntry{mode: mode}
	egressProxies.mu.Unlock()
}

// stopEgressProxy closes and forgets a head's egress proxy, if any.
func stopEgressProxy(id string) {
	egressProxies.mu.Lock()
	e := egressProxies.m[id]
	delete(egressProxies.m, id)
	egressProxies.mu.Unlock()
	if e != nil && e.proxy != nil {
		_ = e.proxy.Close()
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}
