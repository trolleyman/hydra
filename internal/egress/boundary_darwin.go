//go:build darwin

package egress

import (
	"strconv"

	"github.com/trolleyman/hydra/internal/sandbox"
)

func prepareHardBoundary(_ string, proxyPort int, netPol *sandbox.NetworkPolicy, inboundPort int) (HardBoundary, bool) {
	if proxyPort == 0 {
		return HardBoundary{}, false
	}
	netPol.HardProxyPort = proxyPort
	netPol.HardInboundPort = inboundPort
	return HardBoundary{
		ProxyURL:  "http://127.0.0.1:" + strconv.Itoa(proxyPort),
		Mechanism: "Seatbelt loopback-only",
	}, true
}
