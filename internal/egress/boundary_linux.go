//go:build linux

package egress

import (
	"strconv"

	"github.com/trolleyman/hydra/internal/sandbox"
)

func prepareHardBoundary(id string, proxyPort int, netPol *sandbox.NetworkPolicy, inboundPort int) (HardBoundary, bool) {
	hm := DetectHardMode()
	if !hm.Available || proxyPort == 0 {
		return HardBoundary{}, false
	}
	proxyURL := "http://" + MapAddr + ":" + strconv.Itoa(proxyPort)
	loopbackPorts := append([]int(nil), netPol.AllowedLoopbackPorts...)
	return HardBoundary{
		ProxyURL:  proxyURL,
		Mechanism: "pasta+nft",
		Wrap: func(sandboxArgv []string, preExec string) []string {
			return HardWrapArgv(hm, proxyPort, loopbackPorts, inboundPort, sandboxArgv, preExec, PastaLogFile(id))
		},
	}, true
}
