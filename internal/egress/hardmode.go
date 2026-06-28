package egress

import (
	"context"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// MapAddr is the address the sandboxed netns uses to reach the host-loopback
// proxy under pasta's --map-host-loopback translation. A link-local address keeps
// it off any real route and deterministic for both the nft rule and HTTP_PROXY.
const MapAddr = "169.254.1.2"

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
	pasta, err := exec.LookPath("pasta")
	if err != nil {
		return HardMode{}
	}
	nft := lookNft()
	if nft == "" {
		return HardMode{}
	}
	// --map-host-loopback is required for a deterministic proxy address; older
	// pasta builds lack it, so don't even smoke-test those.
	if !pastaHasMapHostLoopback(pasta) {
		return HardMode{}
	}
	if !smokeTest(pasta, nft) {
		return HardMode{}
	}
	return HardMode{Available: true, PastaPath: pasta, NftPath: nft}
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

// smokeTest runs the exact pasta+nft+bash chain the real launch uses, against a
// harmless command, and verifies the egress rule actually blocks direct traffic.
// It returns true only if the whole pipeline executes (pasta creates the netns,
// nft loads the ruleset, the inner command runs).
func smokeTest(pasta, nft string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	script := NftScript(nft, MapAddr, 1) + "\nexec \"$@\""
	args := append(PastaArgs(pasta, MapAddr), "bash", "-c", script, "bash", "true")
	cmd := exec.CommandContext(ctx, args[0], args[1:]...)
	return cmd.Run() == nil
}

func fileExists(p string) bool {
	cmd := exec.Command("test", "-x", p) //errtrace:skip
	return cmd.Run() == nil
}
