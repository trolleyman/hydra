//go:build !unix

package heads

import "os/exec"

// Leave CommandContext's process cancellation in place on non-Unix platforms.
func configureShellCommandCancellation(cmd *exec.Cmd) {}
