//go:build linux

package heads

import "github.com/trolleyman/hydra/internal/sandbox"
import "braces.dev/errtrace"

func prepareCodexSeedLayout(projectRoot string, cacheDir, id, home string, res *seedResult) (codexSeedLayout, error) {
	if res.local {
		return errtrace.Wrap2(prepareNativeCodexSeedLayout(projectRoot, cacheDir, id, home, res))
	}
	hostHome := configuredCodexHome(home)
	res.Env = append(res.Env, "CODEX_HOME="+hostHome)
	res.WritablePaths = append(res.WritablePaths, hostHome)
	return codexSeedLayout{
		hostHome:    hostHome,
		runtimeHome: hostHome,
		outputDir:   cacheDir,
		filePrefix:  id + "-codex-",
	}, nil
}

func deliverCodexSeedFile(res *seedResult, layout codexSeedLayout, source, name string, readOnly bool) {
	if res.local {
		deliverNativeCodexSeedFile(res, layout, source, name, readOnly)
		return
	}
	res.Binds = append(res.Binds, sandbox.Bind{
		Source:   source,
		Target:   layout.visiblePath(name),
		ReadOnly: readOnly,
	})
}
