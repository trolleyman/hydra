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

// startEgress sets up a head's egress filtering and returns the proxy env to
// inject plus, for hard mode, the bwrap-wrapping closure to put on
// sandbox.Options.EgressWrap. With network off it blocks all egress; with
// filtering off it returns nil/nil and leaves egress unrestricted.
//
// When filtering is on (net.FilterHosts), the allow-list is enforced — an empty
// list blocks all egress (deny-by-default). Hard mode (pasta + nft, validated by
// a smoke test) confines the agent to a netns whose only egress is the proxy.
// Otherwise it degrades to advisory mode: the proxy still filters every
// well-behaved client via HTTP(S)_PROXY, but it is not an inescapable boundary —
// surfaced to the UI via EgressMode.
func startEgress(id string, net sandbox.NetworkPolicy) (env []string, wrap func([]string) []string) {
	stopEgressProxy(id)
	if !net.Enabled {
		setEgressMode(id, EgressOff)
		return nil, nil
	}
	if !net.FilterHosts {
		setEgressMode(id, EgressUnrestricted)
		return nil, nil
	}

	p, err := egress.Start(id, net.AllowedHosts)
	if err != nil {
		log.Printf("hydra egress[%s]: could not start filtering proxy, continuing WITHOUT host filtering: %v", id, err)
		setEgressMode(id, EgressUnrestricted)
		return nil, nil
	}
	port := egress.HostPort(p.Addr())

	if hm := egress.DetectHardMode(); hm.Available && port != 0 {
		// Hard mode: the agent reaches the host proxy at the mapped address, and
		// nft drops everything else. The proxy itself listens on host loopback.
		storeEgress(id, p, EgressHard)
		log.Printf("hydra egress[%s]: hard egress boundary active (pasta+nft), allow-list of %d host(s)", id, len(net.AllowedHosts))
		env = egress.ProxyEnv("http://" + egress.MapAddr + ":" + itoa(port))
		wrap = func(bwrapArgv []string) []string { return egress.HardWrapArgv(hm, port, bwrapArgv) }
		return env, wrap
	}

	// Advisory mode: shared host net, proxy reachable on loopback, filtering via
	// HTTP(S)_PROXY only.
	storeEgress(id, p, EgressAdvisory)
	log.Printf("hydra egress[%s]: advisory egress filtering (proxy only; pasta/nft unavailable), allow-list of %d host(s)", id, len(net.AllowedHosts))
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
