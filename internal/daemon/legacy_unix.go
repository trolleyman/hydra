//go:build !windows

package daemon

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"

	"braces.dev/errtrace"
)

var legacySocketName = regexp.MustCompile(`^[0-9a-f]{16}\.sock$`)

// RefuseLegacyDaemons prevents the global daemon from starting beside a live
// daemon from the former per-project socket layout. Two owners could otherwise
// resume and operate the same worktrees while writing to different databases.
func RefuseLegacyDaemons(ctx context.Context) error {
	dir := runtimeDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return errtrace.Wrap(err)
	}
	for _, entry := range entries {
		if entry.IsDir() || !legacySocketName.MatchString(entry.Name()) {
			continue
		}
		sock := filepath.Join(dir, entry.Name())
		if (&Client{sock: sock, http: unixHTTPClient(sock)}).ping(ctx) {
			return errtrace.Wrap(fmt.Errorf("legacy Hydra daemon is still running on %s; stop the older Hydra process before starting this version", sock))
		}
		_ = os.Remove(sock)
	}
	return nil
}
