package desktop

import (
	"path/filepath"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/statepath"
)

// webProfileDirectory returns the durable state directory owned by the native
// webview. The WebKit session itself is ephemeral because its loopback origin
// changes with the backend's random port; Hydra preferences are mirrored here.
func webProfileDirectory() (string, error) {
	root, err := statepath.Root()
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	return filepath.Join(root, "webview"), nil
}
