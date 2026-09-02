//go:build linux

package heads

import (
	"fmt"
	"os"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/sandbox"
)

func hydraRuntimeForSandbox() (*hydraRuntime, error) {
	hydraBin, err := os.Executable()
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("resolve hydra executable: %w", err))
	}
	return &hydraRuntime{
		VisiblePath: SandboxHydraBinPath,
		Bind: &sandbox.Bind{
			Source:   hydraBin,
			Target:   SandboxHydraBinPath,
			ReadOnly: true,
		},
	}, nil
}
