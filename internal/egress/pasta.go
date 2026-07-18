package egress

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// pastaLogSizeBytes caps each per-netns pasta log file. pasta rotates in place
// once it grows past this, so a long-lived head can never grow it without bound.
const pastaLogSizeBytes = 256 * 1024

// pastaLogDir is where pasta writes its own per-netns log (see PastaLogFile). It
// lives under the host temp dir because pasta runs OUTSIDE the sandbox on the
// host, and the id is globally unique across projects (the single daemon serves
// all of them), so one shared dir keyed by id is correct. /tmp is cleared on
// reboot, which doubles as cleanup.
var pastaLogDir = filepath.Join(os.TempDir(), "hydra-pasta")

// PastaLogFile returns the path pasta should log to for the netns identified by
// id, creating the parent dir. It returns "" (pasta keeps its default sink) when
// id is empty or the dir can't be created.
//
// Diverting pasta's log to a file keeps its runtime chatter OUT of the host
// journal (and out of agent terminals, whose PTY is pasta's stderr). The chief
// offender is the benign per-flow "Flow N (TCP connection): shutdown() failed:
// Transport endpoint is not connected" teardown warning pasta emits whenever a
// peer has already closed a connection - it is logged at error level, so pasta's
// -q quiet flag does NOT suppress it, yet it carries no diagnostic value. Real
// pasta errors still land in the file for debugging.
func PastaLogFile(id string) string {
	if id == "" {
		return ""
	}
	if err := os.MkdirAll(pastaLogDir, 0o755); err != nil {
		return ""
	}
	return filepath.Join(pastaLogDir, sanitizePastaLogName(id)+".log")
}

// sanitizePastaLogName maps an id to a safe single-path-component filename. Ids
// like "tests:foo" / "preview:bar" carry a ":" label prefix; keep only
// filename-safe bytes so the result is one component with no surprises.
func sanitizePastaLogName(id string) string {
	var b strings.Builder
	for _, r := range id {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_', r == '.':
			b.WriteRune(r)
		default:
			b.WriteByte('-')
		}
	}
	if b.Len() == 0 {
		return "pasta"
	}
	return b.String()
}

// PastaArgs returns the pasta invocation (up to and including the "--"
// separator) that creates a network namespace whose host-loopback is reachable
// at mapAddr and whose automatic port forwarding is disabled - except for
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
// spawns when that flag is given - -a/-n/-g alone just select the values (pasta
// even rejects its --no-copy-* spellings without it: "needs --config-net").
// Without it the tap device comes up bare, expecting the guest to autoconfigure -
// which the --no-dhcp/--no-ra/--no-ndp flags below (deliberately) rule out - so
// every connect() died with ENETUNREACH and hard mode never activated.
//
// -4 keeps the netns IPv4-only: the whole proxy path is IPv4 (mapAddr), and
// -a/-g only pin the v4 side, so without -4 --config-net would still copy the
// host's IPv6 addresses/routes into the netns - extra setup that can fail, for
// reach the nft lock drops anyway.
//
// pasta runs OUTSIDE bwrap and creates the netns; bwrap then runs inside it
// WITHOUT --unshare-net, inheriting it. pasta exits when the command does, so the
// namespace is torn down automatically (no explicit cleanup).
//
// inboundTCPPort > 0 forwards that single host-loopback TCP port INTO the
// namespace (pasta -t): a connection to the host's 127.0.0.1:<port> is spliced
// through to the same port inside the netns - and because the origin is the
// host's loopback, pasta delivers it on the namespace's loopback, so a server
// bound to 127.0.0.1 inside still receives it. Live previews use this so the
// daemon's reverse proxy can reach the sandboxed demo server's
// $HYDRA_PREVIEW_PORT. 0 = no inbound forwarding (the default posture).
//
// logFile, when non-empty, is passed as pasta's -l/--log-file so ALL of pasta's
// own logging goes there instead of the host journal (see PastaLogFile) - pasta
// logs to syslog whenever its stderr is not a tty, which spams the journal with
// benign per-flow teardown warnings. --log-size bounds the file.
func PastaArgs(pasta, mapAddr string, loopbackTCPPorts []int, inboundTCPPort int, logFile string) []string {
	args := []string{
		pasta,
		"--config-net",                        // actually configure the netns (see doc comment)
		"-4",                                  // IPv4-only (see doc comment)
		"-a", GuestAddr, "-n", GuestPrefixLen, // deterministic guest address...
		"-g", mapAddr, // ...with mapAddr as its (on-link) gateway
		"--map-host-loopback", mapAddr, // reach the host proxy at a deterministic addr
		"-q",                                                // quiet
		"-t", InboundPortSpec(inboundTCPPort), "-u", "none", // inbound: only the one forwarded port, if any
		"-T", LoopbackPortSpec(loopbackTCPPorts), // outbound TCP: only the allow-listed loopback ports
		"-U", "none", // no outbound UDP forwarding
		"--no-dhcp", "--no-dhcpv6", "--no-ndp", "--no-ra", // no autoconfig services
	}
	if logFile != "" {
		args = append(args, "-l", logFile, "--log-size", fmt.Sprintf("%d", pastaLogSizeBytes))
	}
	return append(args, "--")
}

// InboundPortSpec renders the single inbound-forward port as a pasta -t spec:
// "none" when unset, else "127.0.0.1/<port>" so pasta binds ONLY the host's
// loopback (never an external interface) and forwards to the same port inside
// the namespace. Out-of-range values render "none" rather than passing through:
// a bad value must not make pasta reject its whole argv and kill the launch
// (mirrors LoopbackPortSpec).
func InboundPortSpec(port int) string {
	if port < 1 || port > 65535 {
		return "none"
	}
	return fmt.Sprintf("127.0.0.1/%d", port)
}

// LoopbackPortSpec renders a loopback-port allow-list as a pasta -T port spec:
// "none" when empty, else a comma-separated port list ("5037" / "5037,8080").
// pasta then binds each port on the namespace's loopback and splices connections
// through to the same port on the HOST's loopback - this is how a sandboxed
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
// blocking everything but the proxy - including port 53 - is exactly right.
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
// the nft egress lock applied first. The returned argv runs `pasta ... -- bash -c
// '<nft>; <preExec> exec "$@"' bash <bwrap...>`, so the nft rules load (with
// CAP_NET_ADMIN), the optional preExec snippet runs, and then exec hands off to
// bwrap, which drops caps. proxyPort is the host loopback port the filtering
// proxy listens on.
//
// preExec is an optional shell snippet run in this innermost shell just before it
// execs bwrap - Hydra uses it to reopen the seccomp blob by path onto bwrap's
// --seccomp fd, because the fd Go inherits to pasta does not survive pasta's
// re-exec + netns fork. It must be empty or newline/semicolon-terminated.
//
// loopbackTCPPorts are the host-loopback ports the namespace may still reach
// (config `[sandbox.network] allowed_loopback_ports`, spliced via pasta -T -
// see LoopbackPortSpec). inboundTCPPort > 0 additionally forwards that one
// host-loopback port into the namespace (see PastaArgs/InboundPortSpec).
//
// logFile, when non-empty, diverts pasta's own logging to that file instead of
// syslog (see PastaLogFile/PastaArgs), keeping its benign per-flow teardown
// chatter out of the host journal.
func HardWrapArgv(h HardMode, proxyPort int, loopbackTCPPorts []int, inboundTCPPort int, bwrapArgv []string, preExec, logFile string) []string {
	script := NftScript(h.NftPath, MapAddr, proxyPort) + "\n" + preExec + "exec \"$@\""
	argv := PastaArgs(h.PastaPath, MapAddr, loopbackTCPPorts, inboundTCPPort, logFile)
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
