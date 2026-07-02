package egress

import (
	"fmt"
	"strings"
)

// PastaArgs returns the pasta invocation (up to and including the "--"
// separator) that creates a network namespace whose host-loopback is reachable
// at mapAddr and whose automatic port forwarding is disabled — except for
// loopbackTCPPorts, which are spliced through to the host's loopback (see
// LoopbackPortSpec). The caller appends the command to run inside the namespace.
//
// The guest is pinned to a deterministic synthetic subnet (GuestAddr/GuestPrefixLen)
// with mapAddr as its gateway, rather than inheriting the host's real address and
// route. This is what makes mapAddr *on-link* and therefore reachable: pasta's
// --map-host-loopback default is the gateway address, and a destination the guest
// can only reach via a gateway that isn't on-link (e.g. a link-local addr) fails
// with "Network is unreachable". Since nft locks all egress to mapAddr in hard
// mode, the guest never needs the host's real network config.
//
// --config-net is load-bearing: pasta only applies an address/route to a netns it
// spawns when that flag is given — -a/-n/-g alone just select the values (pasta
// even rejects its --no-copy-* spellings without it: "needs --config-net").
// Without it the tap device comes up bare, expecting the guest to autoconfigure —
// which the --no-dhcp/--no-ra/--no-ndp flags below (deliberately) rule out — so
// every connect() died with ENETUNREACH and hard mode never activated.
//
// -4 keeps the netns IPv4-only: the whole proxy path is IPv4 (mapAddr), and
// -a/-g only pin the v4 side, so without -4 --config-net would still copy the
// host's IPv6 addresses/routes into the netns — extra setup that can fail, for
// reach the nft lock drops anyway.
//
// pasta runs OUTSIDE bwrap and creates the netns; bwrap then runs inside it
// WITHOUT --unshare-net, inheriting it. pasta exits when the command does, so the
// namespace is torn down automatically (no explicit cleanup).
func PastaArgs(pasta, mapAddr string, loopbackTCPPorts []int) []string {
	return []string{
		pasta,
		"--config-net",                        // actually configure the netns (see doc comment)
		"-4",                                  // IPv4-only (see doc comment)
		"-a", GuestAddr, "-n", GuestPrefixLen, // deterministic guest address...
		"-g", mapAddr, // ...with mapAddr as its (on-link) gateway
		"--map-host-loopback", mapAddr, // reach the host proxy at a deterministic addr
		"-q",                       // quiet
		"-t", "none", "-u", "none", // no inbound port forwarding
		"-T", LoopbackPortSpec(loopbackTCPPorts), // outbound TCP: only the allow-listed loopback ports
		"-U", "none", // no outbound UDP forwarding
		"--no-dhcp", "--no-dhcpv6", "--no-ndp", "--no-ra", // no autoconfig services
		"--",
	}
}

// LoopbackPortSpec renders a loopback-port allow-list as a pasta -T port spec:
// "none" when empty, else a comma-separated port list ("5037" / "5037,8080").
// pasta then binds each port on the namespace's loopback and splices connections
// through to the same port on the HOST's loopback — this is how a sandboxed
// client reaches a host-local daemon that hard mode's netns would otherwise cut
// off (e.g. adb's hardcoded 127.0.0.1:5037). The splice happens in pasta, in
// userspace, so the in-namespace connection still travels over "lo" and needs no
// nft change (the ruleset's `oifname "lo" accept` already covers it).
//
// Out-of-range ports are dropped rather than passed through: a bad value must
// not make pasta reject its whole argv and kill the head at launch.
func LoopbackPortSpec(ports []int) string {
	var parts []string
	seen := map[int]bool{}
	for _, p := range ports {
		if p < 1 || p > 65535 || seen[p] {
			continue
		}
		seen[p] = true
		parts = append(parts, fmt.Sprintf("%d", p))
	}
	if len(parts) == 0 {
		return "none"
	}
	return strings.Join(parts, ",")
}

// NftScript returns a shell snippet that loads an nft ruleset dropping ALL egress
// from the namespace except loopback and TCP to mapAddr:proxyPort (the host
// proxy). It is run inside pasta's netns while the process still holds
// CAP_NET_ADMIN; bwrap then drops all capabilities, so the agent cannot flush it.
//
// The agent's HTTP client needs no DNS (the CONNECT proxy resolves names), so
// blocking everything but the proxy — including port 53 — is exactly right.
func NftScript(nft, mapAddr string, proxyPort int) string {
	return fmt.Sprintf(`%s -f - <<'NFTEOF'
table inet hydra_egress {
  chain output {
    type filter hook output priority 0; policy drop;
    oifname "lo" accept
    ct state established,related accept
    ip daddr %s tcp dport %d accept
  }
}
NFTEOF`, nft, mapAddr, proxyPort)
}

// HardWrapArgv wraps an existing bwrap argv so it runs inside a pasta netns with
// the nft egress lock applied first. The returned argv runs `pasta … -- bash -c
// '<nft>; <preExec> exec "$@"' bash <bwrap…>`, so the nft rules load (with
// CAP_NET_ADMIN), the optional preExec snippet runs, and then exec hands off to
// bwrap, which drops caps. proxyPort is the host loopback port the filtering
// proxy listens on.
//
// preExec is an optional shell snippet run in this innermost shell just before it
// execs bwrap — Hydra uses it to reopen the seccomp blob by path onto bwrap's
// --seccomp fd, because the fd Go inherits to pasta does not survive pasta's
// re-exec + netns fork. It must be empty or newline/semicolon-terminated.
//
// loopbackTCPPorts are the host-loopback ports the namespace may still reach
// (config `[sandbox.network] allowed_loopback_ports`, spliced via pasta -T —
// see LoopbackPortSpec).
func HardWrapArgv(h HardMode, proxyPort int, loopbackTCPPorts []int, bwrapArgv []string, preExec string) []string {
	script := NftScript(h.NftPath, MapAddr, proxyPort) + "\n" + preExec + "exec \"$@\""
	argv := PastaArgs(h.PastaPath, MapAddr, loopbackTCPPorts)
	argv = append(argv, "bash", "-c", script, "bash")
	return append(argv, bwrapArgv...)
}

// ProxyEnv returns the HTTP(S)_PROXY environment for an agent, pointed at host
// (advisory mode: addr is the host loopback proxy) or at mapAddr (hard mode).
// NO_PROXY excludes loopback so local services bypass the proxy.
func ProxyEnv(proxyURL string) []string {
	const noProxy = "localhost,127.0.0.1,::1"
	return []string{
		"HTTP_PROXY=" + proxyURL, "http_proxy=" + proxyURL,
		"HTTPS_PROXY=" + proxyURL, "https_proxy=" + proxyURL,
		"ALL_PROXY=" + proxyURL, "all_proxy=" + proxyURL,
		"NO_PROXY=" + noProxy, "no_proxy=" + noProxy,
	}
}

// HostPort splits a host:port (the proxy Addr) into its port number. Best-effort:
// returns 0 if unparseable.
func HostPort(addr string) int {
	i := strings.LastIndex(addr, ":")
	if i < 0 {
		return 0
	}
	var port int
	_, _ = fmt.Sscanf(addr[i+1:], "%d", &port)
	return port
}
