//go:build darwin

package heads

import "braces.dev/errtrace"

func prepareCodexSeedLayout(projectRoot, cacheDir, id, home string, res *seedResult) (codexSeedLayout, error) {
	return errtrace.Wrap2(prepareNativeCodexSeedLayout(projectRoot, cacheDir, id, home, res))
}

func deliverCodexSeedFile(res *seedResult, layout codexSeedLayout, source, name string, readOnly bool) {
	deliverNativeCodexSeedFile(res, layout, source, name, readOnly)
}
