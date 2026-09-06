package egress

import "github.com/trolleyman/hydra/internal/sandbox"

// HardBoundary is the platform-specific kernel boundary around the filtering
// proxy. Linux wraps bwrap in pasta+nft; Darwin records the one permitted
// loopback proxy port for the Seatbelt profile and needs no argv wrapper.
type HardBoundary struct {
	ProxyURL  string
	Wrap      func(sandboxArgv []string, preExec string) []string
	Mechanism string
}

// PrepareHardBoundary configures a hard egress boundary for a running proxy.
// available is false when the host cannot provide inescapable enforcement.
func PrepareHardBoundary(id string, proxyPort int, netPol *sandbox.NetworkPolicy, inboundPort int) (boundary HardBoundary, available bool) {
	return prepareHardBoundary(id, proxyPort, netPol, inboundPort)
}
