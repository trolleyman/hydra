//go:build !windows

package docker

import (
	"os"
	"os/signal"
	"syscall"
)

// notifyWindowResize subscribes c to SIGWINCH so the caller can forward
// terminal resize events into the container.
func notifyWindowResize(c chan<- os.Signal) {
	signal.Notify(c, syscall.SIGWINCH)
}
