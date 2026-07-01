package egress

import (
	"fmt"
	"strings"
)

// PastaArgs returns the pasta invocation (up to and including the "--"
// separator) that creates a network namespace whose host-loopback is reachable
// at mapAddr and whose automatic port forwarding is disabled. The caller appends
// the command to run inside the namespace.
//
// pasta runs OUTSIDE bwrap and creates the netns; bwrap then runs inside it
// WITHOUT --unshare-net, inheriting it. pasta exits when the command does, so the
// namespace is torn down automatically (no explicit cleanup).
func PastaArgs(pasta, mapAddr string) []string {
	return []string{
		pasta,
		"--map-host-loopback", mapAddr, // reach the host proxy at a deterministic addr
		"-q",                       // quiet
		"-t", "none", "-u", "none", // no inbound port forwarding
		"-T", "none", "-U", "none", // no outbound port forwarding
		"--no-dhcp", "--no-dhcpv6", "--no-ndp", "--no-ra", // no autoconfig services
		"--",
	}
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
func HardWrapArgv(h HardMode, proxyPort int, bwrapArgv []string, preExec string) []string {
	script := NftScript(h.NftPath, MapAddr, proxyPort) + "\n" + preExec + "exec \"$@\""
	argv := PastaArgs(h.PastaPath, MapAddr)
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
