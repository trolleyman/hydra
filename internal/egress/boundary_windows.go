//go:build windows

package egress

import "github.com/trolleyman/hydra/internal/sandbox"

func prepareHardBoundary(_ string, _ int, _ *sandbox.NetworkPolicy, _ int) (HardBoundary, bool) {
	return HardBoundary{}, false
}
