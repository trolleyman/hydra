//go:build darwin

package heads

import (
	"fmt"
	"os"
	"path/filepath"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/paths"
	"github.com/trolleyman/hydra/internal/sandbox"
)

func prepareSeedDir(projectRoot, cacheDir, id string, agentType sandbox.AgentType) (string, error) {
	if agentType != sandbox.AgentTypeClaude && agentType != sandbox.AgentTypeCodex {
		return cacheDir, nil
	}
	dir := paths.GetSeedDirFromProjectRoot(projectRoot, id)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", errtrace.Wrap(fmt.Errorf("create Darwin seed directory: %w", err))
	}
	return dir, nil
}

func seedFilePath(seedDir, id, name string) string {
	return filepath.Join(seedDir, id+"-"+name)
}

func deliverSeedFile(res *seedResult, source, target string, readOnly bool) string {
	if res.nativeSeedPaths {
		res.ImmutablePaths = append(res.ImmutablePaths, source)
		return source
	}
	res.Binds = append(res.Binds, sandbox.Bind{Source: source, Target: target, ReadOnly: readOnly})
	return target
}
