package egress

import (
	"log"

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
	// Wrap is the sandbox.Options.EgressWrap for Linux hard mode (pasta netns +
	// nft lock around the bwrap argv); Darwin enforces hard mode in BuildSpec, so
	// Wrap remains nil there.
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
//   - hard: platform kernel boundary + CONNECT proxy (pasta+nft Wrap on Linux,
//     Seatbelt proxy-port policy on Darwin). When the boundary cannot be built
//     it fails closed (netPol.Enabled set false, like heads) - never degrades.
//
// netPol is taken by pointer because a hard-mode failure must flip Enabled
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
		if netPol.Mode == sandbox.NetHard {
			log.Printf("hydra egress[%s]: hard egress but proxy failed to start; failing closed (no network): %v", id, err)
			netPol.Enabled = false
			return &Session{}
		}
		log.Printf("hydra egress[%s]: could not start filtering proxy, continuing WITHOUT host filtering: %v", id, err)
		return &Session{}
	}
	port := HostPort(p.Addr())

	if netPol.Mode == sandbox.NetHard {
		if boundary, ok := PrepareHardBoundary(id, port, netPol, inboundPort); ok {
			log.Printf("hydra egress[%s]: hard egress boundary active (%s), %d allow-listed host(s); proxy=%s (host listener %s); inbound port: %d", id, boundary.Mechanism, len(allowed), boundary.ProxyURL, p.Addr(), inboundPort)
			return &Session{
				Env:   ProxyEnv(boundary.ProxyURL),
				Wrap:  boundary.Wrap,
				proxy: p,
			}
		}
		// No inescapable boundary available → fail closed. Hard never degrades
		// to the escapable advisory posture.
		log.Printf("hydra egress[%s]: hard egress requested but pasta/nft unavailable; failing closed (no network)", id)
		_ = p.Close()
		netPol.Enabled = false
		return &Session{}
	}

	// Advisory mode (explicitly chosen): shared host net, proxy reachable on
	// loopback, filtering via HTTP(S)_PROXY only.
	return &Session{Env: ProxyEnv("http://" + p.Addr()), proxy: p}
}
