package egress

import (
	"log"
	"strconv"

	"github.com/trolleyman/hydra/internal/sandbox"
)

// Session is one runner command's egress boundary: the proxy env to inject,
// the (hard-mode) pasta wrap for its bwrap argv, and the proxy's lifetime.
// A Session is returned even when there is nothing to do (off/unrestricted) so
// callers can use it unconditionally; Close is nil-safe and idempotent enough
// for cleanup chains.
type Session struct {
	// Env is the HTTP(S)_PROXY environment to append to the command's env.
	// Empty when no filtering proxy runs.
	Env []string
	// Wrap is the sandbox.Options.EgressWrap for hard mode (pasta netns + nft
	// lock around the bwrap argv); nil otherwise.
	Wrap func(bwrapArgv []string, preExec string) []string

	proxy *Proxy
}

// Close tears the session's filtering proxy down. Call when the command's
// resources are reclaimed (chain onto the sandbox launch Cleanup).
func (s *Session) Close() {
	if s != nil && s.proxy != nil {
		_ = s.proxy.Close()
		s.proxy = nil
	}
}

// StartCommandEgress builds the egress boundary for a one-shot sandboxed
// runner command (a test runner, artifact generator, service, or live-preview
// server) from its resolved network policy - the same mode ladder agent heads
// get from heads.startEgress, minus the head-specific machinery (no supervisor
// port pinning: every run is a fresh netns, so the proxy always binds an
// ephemeral port; no approval UI: approve may be nil, in which case a host on
// neither list is silently denied - a build must not park waiting for a human).
//
//   - off / not enabled: no proxy; the sandbox gets --unshare-net via
//     netPol.Enabled == false.
//   - unrestricted / unfiltered: no proxy, open host network.
//   - advisory: filtering proxy on host loopback, enforced via proxy env only.
//   - hard: pasta netns + nft lock + CONNECT proxy (Wrap non-nil). When the
//     tooling is unavailable, degrades to advisory - or fails closed
//     (netPol.Enabled set false, like heads) when the policy is Strict.
//
// netPol is taken by pointer because a strict-hard failure must flip Enabled
// off before the caller hands the policy to sandbox.BuildSpec.
//
// inboundPort > 0 forwards that host-loopback TCP port into the hard-mode
// netns (pasta -t; see InboundPortSpec) so the daemon can reach a server the
// command starts inside - live previews pass their child port. Ignored
// outside hard mode, where the command shares the host netns anyway.
//
// id is a label for log lines only.
func StartCommandEgress(id string, agentType sandbox.AgentType, netPol *sandbox.NetworkPolicy, inboundPort int, approve ApproveFunc) *Session {
	if !netPol.Enabled || netPol.Mode == sandbox.NetOff {
		return &Session{}
	}
	if !netPol.FilterHosts || netPol.Mode == sandbox.NetUnrestricted {
		return &Session{}
	}

	allowed := append(sandbox.DefaultAllowedHosts(agentType), netPol.AllowedHosts...)
	p, err := Start(id, 0, allowed, netPol.BlockedHosts, approve)
	if err != nil {
		if netPol.Mode == sandbox.NetHard && netPol.Strict {
			log.Printf("hydra egress[%s]: STRICT hard egress but proxy failed to start; failing closed (no network): %v", id, err)
			netPol.Enabled = false
			return &Session{}
		}
		log.Printf("hydra egress[%s]: could not start filtering proxy, continuing WITHOUT host filtering: %v", id, err)
		return &Session{}
	}
	port := HostPort(p.Addr())

	if netPol.Mode == sandbox.NetHard {
		if hm := DetectHardMode(); hm.Available && port != 0 {
			proxyURL := "http://" + MapAddr + ":" + strconv.Itoa(port)
			loopbackPorts := netPol.AllowedLoopbackPorts
			log.Printf("hydra egress[%s]: hard egress boundary active (pasta+nft), %d allow-listed host(s); proxy=%s (host listener %s); inbound forward: %s", id, len(allowed), proxyURL, p.Addr(), InboundPortSpec(inboundPort))
			return &Session{
				Env: ProxyEnv(proxyURL),
				Wrap: func(bwrapArgv []string, preExec string) []string {
					return HardWrapArgv(hm, port, loopbackPorts, inboundPort, bwrapArgv, preExec)
				},
				proxy: p,
			}
		}
		if netPol.Strict {
			log.Printf("hydra egress[%s]: STRICT hard egress requested but pasta/nft unavailable; failing closed (no network)", id)
			_ = p.Close()
			netPol.Enabled = false
			return &Session{}
		}
		log.Printf("hydra egress[%s]: hard egress requested but pasta/nft unavailable; DEGRADED to advisory filtering", id)
	}

	// Advisory mode (chosen, or a non-strict hard degrade): shared host net,
	// proxy reachable on loopback, filtering via HTTP(S)_PROXY only.
	return &Session{Env: ProxyEnv("http://" + p.Addr()), proxy: p}
}
