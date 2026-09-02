//go:build windows

package heads

import "github.com/trolleyman/hydra/internal/sandbox"

func prepareCodexSeedLayout(_ string, cacheDir, id, home string, res *seedResult) (codexSeedLayout, error) {
	hostHome := configuredCodexHome(home)
	res.Env = append(res.Env, "CODEX_HOME="+hostHome)
	return codexSeedLayout{
		hostHome:    hostHome,
		runtimeHome: hostHome,
		outputDir:   cacheDir,
		filePrefix:  id + "-codex-",
	}, nil
}

func deliverCodexSeedFile(res *seedResult, layout codexSeedLayout, source, name string, readOnly bool) {
	res.Binds = append(res.Binds, sandbox.Bind{
		Source:   source,
		Target:   layout.visiblePath(name),
		ReadOnly: readOnly,
	})
}
