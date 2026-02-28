//go:build !linux && !hydra_embed_linux_binary

package docker

// embeddedLinuxBinary is nil when built without the hydra_embed_linux_binary
// tag. resolveContainerHydraBin will return a descriptive error at runtime.
var embeddedLinuxBinary []byte
