//go:build linux

package heads

import (
	"path/filepath"

	"github.com/trolleyman/hydra/internal/sandbox"
)

func prepareSeedDir(_ string, cacheDir, _ string, _ sandbox.AgentType) (string, error) {
	return cacheDir, nil
}

func seedFilePath(seedDir, id, name string) string {
	return filepath.Join(seedDir, id+"-"+name)
}

func deliverSeedFile(res *seedResult, source, target string, readOnly bool) string {
	res.Binds = append(res.Binds, sandbox.Bind{Source: source, Target: target, ReadOnly: readOnly})
	return target
}
