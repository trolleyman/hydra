//go:build windows

package heads

import (
	"fmt"
	"os"

	"braces.dev/errtrace"
)

func hydraRuntimeForSandbox() (*hydraRuntime, error) {
	hydraBin, err := os.Executable()
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("resolve hydra executable: %w", err))
	}
	return &hydraRuntime{VisiblePath: hydraBin}, nil
}
