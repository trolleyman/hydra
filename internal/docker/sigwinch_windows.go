//go:build windows

package docker

import "os"

// notifyWindowResize is a no-op on Windows; SIGWINCH does not exist.
// The initial terminal size sync in AttachAgent provides the starting dimensions.
func notifyWindowResize(_ chan<- os.Signal) {}
