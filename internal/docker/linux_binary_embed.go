//go:build !linux && hydra_embed_linux_binary

package docker

import _ "embed"

// embeddedLinuxBinary holds the linux/GOARCH hydra binary cross-compiled by
// `mage build`. It is extracted to .hydra/cache/hydra at container spawn time.
//
//go:embed hydra-linux
var embeddedLinuxBinary []byte
