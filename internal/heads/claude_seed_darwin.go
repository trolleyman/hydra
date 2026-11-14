//go:build darwin

package heads

import "braces.dev/errtrace"

func prepareClaudeSeedLayout(projectRoot, id, home, worktreePath string, res *seedResult) (claudeSeedLayout, error) {
	return errtrace.Wrap2(prepareNativeClaudeSeedLayout(projectRoot, id, home, worktreePath, res))
}
