package desktop

import (
	"path/filepath"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/statepath"
)

// webProfileDirectories returns the durable data and cache directories owned by
// the native webview. Keeping this under the selected Hydra state root means a
// checkout-local desktop run cannot read or overwrite the installed app's
// browser preferences.
func webProfileDirectories() (data, cache string, err error) {
	root, err := statepath.Root()
	if err != nil {
		return "", "", errtrace.Wrap(err)
	}
	return filepath.Join(root, "webview", "data"), filepath.Join(root, "webview", "cache"), nil
}
