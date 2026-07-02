package egress

import (
	"context"
	"fmt"
	"log"
	"net"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// MapAddr is the address the sandboxed netns uses to reach the host-loopback
// proxy under pasta's --map-host-loopback translation. It doubles as the guest's
// default gateway (see PastaArgs), so it MUST be on-link inside the netns — a
// link-local address is NOT, because Linux refuses to route a link-local
// destination via a gateway, which yields "Network is unreachable". We instead
// synthesise a deterministic point-to-point subnet from RFC 5737's TEST-NET-1
// (reserved for documentation, so it never collides with a real LAN): the guest
// is GuestAddr and its gateway is MapAddr, both in 192.0.2.0/GuestPrefixLen. This
// gives a route the netns can actually use, and stays deterministic for the nft
// rule and HTTP_PROXY. In hard mode nft locks all egress to MapAddr anyway, so
// overriding the guest's addressing has no downside.
const (
	MapAddr        = "192.0.2.1"
	GuestAddr      = "192.0.2.2"
	GuestPrefixLen = "24"
)

// HardMode describes whether the kernel/tooling can give a real (inescapable)
// egress boundary on this host, and the resolved tool paths to build it.
type HardMode struct {
	Available bool
	PastaPath string
	NftPath   string
}

var (
	hardOnce sync.Once
	hardRes  HardMode
)

// DetectHardMode reports whether a hard egress boundary is possible here, caching
// the (host-stable) result. It requires: pasta with --map-host-loopback, an nft
// binary, and — decisively — a SMOKE TEST that actually spins up the pasta netns +
// nft ruleset and confirms it works. The smoke test means hard mode only ever
// activates when it genuinely functions on this host (so an old pasta, a kernel
// without unprivileged userns, or a missing capability all fall back cleanly to
// the advisory proxy rather than wedging a head at launch).
func DetectHardMode() HardMode {
	hardOnce.Do(func() { hardRes = detectHardMode() })
	return hardRes
}

func detectHardMode() HardMode {
	pasta := lookPasta()
	if pasta == "" {
		log.Printf("hydra egress: hard mode unavailable — pasta not found (set HYDRA_PASTA or install pasta); degrading to advisory")
		return HardMode{}
	}
	nft := lookNft()
	if nft == "" {
		log.Printf("hydra egress: hard mode unavailable — nft not found (looked on PATH + /usr/sbin,/sbin); degrading to advisory")
		return HardMode{}
	}
	// --map-host-loopback is required for a deterministic proxy address; older
	// pasta builds lack it, so don't even smoke-test those.
	if !pastaHasMapHostLoopback(pasta) {
		log.Printf("hydra egress: hard mode unavailable — pasta at %q lacks --map-host-loopback (too old); degrading to advisory", pasta)
		return HardMode{}
	}
	if reason := smokeTest(pasta, nft); reason != "" {
		log.Printf("hydra egress: hard mode unavailable — smoke test failed: %s (pasta=%q nft=%q); degrading to advisory", reason, pasta, nft)
		return HardMode{}
	}
	log.Printf("hydra egress: hard mode AVAILABLE — proxy reachable through pasta netns (pasta=%q nft=%q)", pasta, nft)
	return HardMode{Available: true, PastaPath: pasta, NftPath: nft}
}

// lookPasta resolves the pasta binary. HYDRA_PASTA overrides PATH lookup so a
// newer pasta (e.g. one with --map-host-loopback, dropped in ~/.local/bin) can be
// used without touching the system binary — mirrors HYDRA_BWRAP.
func lookPasta() string {
	if p := os.Getenv("HYDRA_PASTA"); p != "" {
		return p
	}
	if p, err := exec.LookPath("pasta"); err == nil {
		return p
	}
	return ""
}

// lookNft resolves nft, falling back to the usual sbin locations that are often
// off a service PATH.
func lookNft() string {
	if p, err := exec.LookPath("nft"); err == nil {
		return p
	}
	for _, p := range []string{"/usr/sbin/nft", "/sbin/nft"} {
		if fileExists(p) {
			return p
		}
	}
	return ""
}

func pastaHasMapHostLoopback(pasta string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, _ := exec.CommandContext(ctx, pasta, "--help").CombinedOutput()
	return strings.Contains(string(out), "--map-host-loopback")
}

// smokeTest runs the exact pasta+nft+bash chain the real launch uses AND verifies
// the mapped proxy address is actually reachable from inside the netns. It returns
// "" on success, or a short human-readable reason on failure.
//
// This is the load-bearing check: it is not enough that pasta creates the netns and
// nft loads the ruleset — the agent must be able to open a TCP connection to the
// host-loopback proxy at MapAddr:port, or every request dies with ConnectionRefused
// (the proxy never even sees the traffic). The old smoke test only ran `true`
// inside the netns, so a host where --map-host-loopback does not deliver traffic to
// a 127.0.0.1 listener passed the test yet wedged every hard-mode head at runtime.
//
// So we stand up a throwaway host-loopback listener that emits a token, open the
// nft rule for exactly that port, and from inside the netns connect to
// MapAddr:port via bash's /dev/tcp and read the token back. Seeing the token proves
// the whole path pasta+nft+map-host-loopback → host 127.0.0.1 listener works; the
// real proxy binds 127.0.0.1 the same way, so this generalises.
func smokeTest(pasta, nft string) string {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return fmt.Sprintf("could not bind host-loopback probe listener: %v", err)
	}
	defer ln.Close()
	port := HostPort(ln.Addr().String())
	if port == 0 {
		return "probe listener has no port"
	}
	const token = "hydra-egress-probe-ok"
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			_, _ = c.Write([]byte(token))
			_ = c.Close()
		}
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	// Inside the netns: connect to the mapped proxy address and echo whatever the
	// listener sends. bash's /dev/tcp needs no extra tools in the sandbox.
	inner := fmt.Sprintf("exec 3<>/dev/tcp/%s/%d && cat <&3", MapAddr, port)
	script := NftScript(nft, MapAddr, port) + "\nexec \"$@\""
	args := append(PastaArgs(pasta, MapAddr), "bash", "-c", script, "bash", "bash", "-c", inner)
	out, err := exec.CommandContext(ctx, args[0], args[1:]...).CombinedOutput()
	if strings.Contains(string(out), token) {
		return ""
	}
	detail := strings.TrimSpace(string(out))
	if err != nil {
		return fmt.Sprintf("proxy unreachable from netns (%v): %s", err, detail)
	}
	return fmt.Sprintf("proxy unreachable from netns — token not received: %s", detail)
}

func fileExists(p string) bool {
	cmd := exec.Command("test", "-x", p) //errtrace:skip
	return cmd.Run() == nil
}
